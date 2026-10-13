package wechatlinux

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

var (
	ErrClosed        = errors.New("wechatlinux: client closed")
	ErrEventOverflow = errors.New("wechatlinux: event subscription overflow; resubscribe and reconcile state")
)

// APIError is returned by the helper, including unsupported and unverified
// operations. Details retain native diagnostics without inventing a schema.
type APIError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details,omitempty"`
}

func (e *APIError) Error() string { return "wechatlinux: " + e.Code + ": " + e.Message }

type Options struct {
	// MaxFrameBytes bounds both inbound and outbound NDJSON records. Zero uses 8 MiB.
	MaxFrameBytes int
}

type response struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *APIError       `json:"error,omitempty"`
	Event  *Event          `json:"event,omitempty"`
}

type callResult struct {
	result json.RawMessage
	err    error
}

type Client struct {
	conn       net.Conn
	maxFrame   int
	writeToken chan struct{}
	mu         sync.Mutex
	sequence   uint64
	pending    map[string]chan callResult
	subs       map[*Subscription]struct{}
	err        error
}

// Dial connects to an already running helper. The socket should be private to
// the current user; the helper has access to the user's authenticated account.
func Dial(ctx context.Context, socketPath string, opts Options) (*Client, error) {
	if opts.MaxFrameBytes < 0 {
		return nil, errors.New("wechatlinux: negative frame limit")
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, err
	}
	return newClient(conn, opts), nil
}

func newClient(conn net.Conn, opts Options) *Client {
	limit := opts.MaxFrameBytes
	if limit == 0 {
		limit = 8 << 20
	}
	c := &Client{conn: conn, maxFrame: limit, writeToken: make(chan struct{}, 1), pending: make(map[string]chan callResult), subs: make(map[*Subscription]struct{})}
	c.writeToken <- struct{}{}
	go c.readLoop()
	return c
}

func (c *Client) Close() error { c.shutdown(ErrClosed); return nil }

// Err reports the terminal transport error, or nil while the connection is open.
func (c *Client) Err() error { c.mu.Lock(); defer c.mu.Unlock(); return c.err }

func (c *Client) shutdown(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return
	}
	c.err = err
	c.conn.Close()
	for id, ch := range c.pending {
		ch <- callResult{err: err}
		delete(c.pending, id)
	}
	for sub := range c.subs {
		c.closeSubscriptionLocked(sub, err)
	}
}

func (c *Client) readLoop() {
	scanner := bufio.NewScanner(c.conn)
	// One extra byte permits a newline after a maximum-size JSON record.
	initial := c.maxFrame + 1
	if initial > 64<<10 {
		initial = 64 << 10
	}
	scanner.Buffer(make([]byte, initial), c.maxFrame+1)
	for scanner.Scan() {
		if len(scanner.Bytes()) > c.maxFrame {
			c.shutdown(errors.New("wechatlinux: incoming frame too large"))
			return
		}
		var wire response
		if err := json.Unmarshal(scanner.Bytes(), &wire); err != nil {
			c.shutdown(fmt.Errorf("wechatlinux: malformed response: %w", err))
			return
		}
		if wire.Event != nil {
			if wire.ID != "" || wire.Error != nil || wire.Result != nil {
				c.shutdown(errors.New("wechatlinux: mixed event and response frame"))
				return
			}
			if wire.Event.Type == "" {
				c.shutdown(errors.New("wechatlinux: event has no type"))
				return
			}
			c.publish(*wire.Event)
			continue
		}
		if wire.ID == "" || (wire.Error == nil && wire.Result == nil) {
			c.shutdown(errors.New("wechatlinux: incomplete response frame"))
			return
		}
		c.mu.Lock()
		if ch, ok := c.pending[wire.ID]; ok {
			delete(c.pending, wire.ID)
			r := callResult{result: wire.Result}
			if wire.Error != nil {
				r.err = wire.Error
			}
			ch <- r
		}
		c.mu.Unlock()
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	c.shutdown(fmt.Errorf("wechatlinux: helper disconnected: %w", err))
}

// Call sends one request. Cancellation discards its response; it cannot undo
// an operation already accepted by the native client.
func (c *Client) Call(ctx context.Context, method string, params any, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if method == "" {
		return errors.New("wechatlinux: empty method")
	}
	if params == nil {
		params = struct{}{}
	}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.sequence++
	id := strconv.FormatUint(c.sequence, 10)
	ch := make(chan callResult, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	frame, err := json.Marshal(struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{id, method, params})
	if err != nil {
		return err
	}
	if len(frame) > c.maxFrame {
		return errors.New("wechatlinux: outgoing frame too large")
	}
	frame = append(frame, '\n')
	if err = c.write(ctx, frame); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if result == nil {
			return nil
		}
		if err := json.Unmarshal(r.result, result); err != nil {
			return fmt.Errorf("wechatlinux: decode %s result: %w", method, err)
		}
		return nil
	}
}

func (c *Client) write(ctx context.Context, frame []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.writeToken:
	}
	defer func() { c.writeToken <- struct{}{} }()
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok {
		c.conn.SetWriteDeadline(deadline)
	}
	cancelDone := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { c.conn.SetWriteDeadline(time.Now()); close(cancelDone) })
	var err error
	for len(frame) > 0 {
		var n int
		n, err = c.conn.Write(frame)
		frame = frame[n:]
		if err != nil {
			break
		}
		if n == 0 {
			err = io.ErrShortWrite
			break
		}
	}
	if !stop() {
		<-cancelDone
	}
	c.conn.SetWriteDeadline(time.Time{})
	if err != nil {
		// A interrupted partial record corrupts framing, so every write failure
		// terminates this transport even if only one request was canceled.
		c.shutdown(fmt.Errorf("wechatlinux: write failed: %w", err))
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return c.Err()
	}
	return nil
}

type Subscription struct {
	Events <-chan Event
	Errors <-chan error
	events chan Event
	errors chan error
	done   chan struct{}
	client *Client
}

// SubscribeEvents receives future events. Overflow closes this subscription and
// reports ErrEventOverflow rather than silently dropping events. Buffered events
// remain drainable. Recover by resubscribing before querying current state/history,
// and deduplicate concurrent events using native IDs.
func (c *Client) SubscribeEvents(ctx context.Context, buffer int) (*Subscription, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if buffer <= 0 {
		return nil, errors.New("wechatlinux: event buffer must be positive")
	}
	events := make(chan Event, buffer)
	errCh := make(chan error, 1)
	sub := &Subscription{Events: events, Errors: errCh, events: events, errors: errCh, done: make(chan struct{}), client: c}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return nil, err
	}
	c.subs[sub] = struct{}{}
	c.mu.Unlock()
	go func() {
		select {
		case <-ctx.Done():
			sub.close(ctx.Err())
		case <-sub.done:
		}
	}()
	return sub, nil
}

func (s *Subscription) Close() { s.close(nil) }
func (s *Subscription) close(err error) {
	s.client.mu.Lock()
	defer s.client.mu.Unlock()
	s.client.closeSubscriptionLocked(s, err)
}

func (c *Client) closeSubscriptionLocked(s *Subscription, err error) {
	if _, ok := c.subs[s]; !ok {
		return
	}
	delete(c.subs, s)
	if err != nil {
		s.errors <- err
	}
	close(s.events)
	close(s.errors)
	close(s.done)
}

func (c *Client) publish(event Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for sub := range c.subs {
		select {
		case sub.events <- event:
		default:
			c.closeSubscriptionLocked(sub, ErrEventOverflow)
		}
	}
}
