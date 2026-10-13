package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"sync"
	"sync/atomic"
	"time"
)

type Client struct {
	connector  *Connector
	login      *bridgev2.UserLogin
	session    backend.Session
	restoreErr error
	online     atomic.Bool
	mu         sync.Mutex
	cancel     context.CancelFunc
	done       chan struct{}
}

func (c *Client) IsLoggedIn() bool { return c.online.Load() }
func (c *Client) Connect(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		select {
		case <-c.done:
		default:
			return
		}
	}
	ctx, c.cancel = context.WithCancel(ctx)
	c.done = make(chan struct{})
	go c.run(ctx, c.done)
}
func (c *Client) Disconnect() {
	c.mu.Lock()
	cancel, done := c.cancel, c.done
	c.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	// Session methods are required to honor cancellation; do not hang shutdown.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	c.mu.Lock()
	if c.done == done {
		c.cancel = nil
		c.done = nil
	}
	c.mu.Unlock()
}
func (c *Client) state(state status.BridgeStateEvent, err error) {
	s := status.BridgeState{StateEvent: state}
	if err != nil {
		s.Message = err.Error()
	}
	if c.connector.Config.Backend == "fake" && state == status.StateConnected {
		s.Message = "Development fixture connected; this is not a real WeChat session."
	}
	c.login.BridgeState.Send(s)
}
func pause(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
func (c *Client) run(ctx context.Context, done chan struct{}) {
	defer close(done)
	defer c.online.Store(false)
	if c.restoreErr != nil || c.session == nil {
		err := c.restoreErr
		if err == nil {
			err = backend.ErrUnavailable
		}
		state := status.StateBadCredentials
		if errors.Is(err, backend.ErrUnavailable) {
			state = status.StateUnconfigured
		}
		c.state(state, err)
		return
	}
	defer c.session.Close()
	backoff := time.Second
	for ctx.Err() == nil {
		c.online.Store(false)
		c.state(status.StateConnecting, nil)
		err := c.session.Connect(ctx)
		if err == nil {
			var account backend.Account
			account, err = c.session.Self(ctx)
			meta := c.login.Metadata.(*LoginMetadata)
			if err == nil && (account.ID != meta.AccountID || account.Profile.ID != meta.UserID) {
				err = backend.ErrUnauthorized
			}
		}
		if err == nil {
			c.online.Store(true)
			c.state(status.StateConnected, nil)
			backoff = time.Second
			err = c.consume(ctx)
		}
		if ctx.Err() != nil {
			return
		}
		c.online.Store(false)
		if errors.Is(err, backend.ErrUnauthorized) {
			c.state(status.StateBadCredentials, err)
			return
		}
		if errors.Is(err, backend.ErrUnavailable) {
			c.state(status.StateUnconfigured, err)
			return
		}
		c.state(status.StateTransientDisconnect, err)
		_ = c.session.Close()
		if !pause(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}
func (c *Client) consume(ctx context.Context) error {
	meta := c.login.Metadata.(*LoginMetadata)
	return consumeEvents(ctx, c.session, meta, c.deliver, func(ctx context.Context) error { return c.login.Save(ctx) })
}
func consumeEvents(ctx context.Context, session backend.Session, meta *LoginMetadata, deliver func(context.Context, backend.Event) error, save func(context.Context) error) error {
	for {
		evt, err := session.Next(ctx, meta.Cursor)
		if err != nil {
			return err
		}
		if evt.AccountID != meta.AccountID || evt.ID == "" || evt.ChatID == "" || evt.SenderID == "" || evt.Cursor == "" || evt.Cursor == meta.Cursor {
			return errors.New("backend returned an invalid event identity or cursor")
		}
		if err = deliver(ctx, evt); err != nil {
			return err
		}
		previous := meta.Cursor
		meta.Cursor = evt.Cursor
		if err = save(ctx); err != nil {
			meta.Cursor = previous
			return fmt.Errorf("save event checkpoint: %w", err)
		}
	}
}

// Prefixing chat and message IDs with separate base64url encodings preserves
// opaque IDs, including separator characters, and avoids cross-chat collisions.
func messageID(chatID, id string) networkid.MessageID {
	return networkid.MessageID(base64.RawURLEncoding.EncodeToString([]byte(chatID)) + ":" + base64.RawURLEncoding.EncodeToString([]byte(id)))
}
func (c *Client) portalKey(chatID string) networkid.PortalKey {
	return networkid.PortalKey{ID: networkid.PortalID(chatID), Receiver: c.login.ID}
}
func (c *Client) eventMeta(evt backend.Event, post func(context.Context, *bridgev2.Portal)) simplevent.EventMeta {
	return simplevent.EventMeta{PortalKey: c.portalKey(evt.ChatID), Sender: bridgev2.EventSender{Sender: networkid.UserID(evt.SenderID), IsFromMe: evt.SenderID == string(c.GetUserID()), SenderLogin: func() networkid.UserLoginID {
		if evt.SenderID == string(c.GetUserID()) {
			return c.login.ID
		}
		return ""
	}()}, Timestamp: evt.Timestamp, CreatePortal: true, PostHandleFunc: post}
}
func (c *Client) deliver(ctx context.Context, evt backend.Event) error {
	// bridgev2 queues asynchronously. Only persist a backend cursor once all
	// expected message parts exist in the DB, or a revocation has been applied.
	completed := make(chan error, 1)
	expected := 1
	if len(evt.Message.Media) > 0 {
		expected = len(evt.Message.Media)
	}
	post := func(ctx context.Context, portal *bridgev2.Portal) {
		target := evt.ID
		if evt.Message.Kind == backend.Revoke {
			target = evt.TargetID
		}
		parts, err := c.connector.Bridge.DB.Message.GetAllPartsByID(ctx, c.login.ID, messageID(evt.ChatID, target))
		if err == nil {
			if evt.Message.Kind == backend.Revoke {
				if len(parts) != 0 {
					err = errors.New("revocation was not committed")
				}
			} else if len(parts) != expected {
				err = fmt.Errorf("message not fully committed: got %d of %d parts", len(parts), expected)
			}
		}
		select {
		case completed <- err:
		default:
		}
	}
	var remote bridgev2.RemoteEvent
	meta := c.eventMeta(evt, post)
	if evt.Message.Kind == backend.Revoke {
		if evt.TargetID == "" {
			return errors.New("revocation target is required")
		}
		meta.Type = bridgev2.RemoteEventMessageRemove
		remote = &simplevent.MessageRemove{EventMeta: meta, TargetMessage: messageID(evt.ChatID, evt.TargetID), HidePlaceholder: true}
	} else if evt.Message.Kind == backend.ChatChanged {
		portal, err := c.connector.Bridge.GetPortalByKey(ctx, c.portalKey(evt.ChatID))
		if err != nil {
			return err
		}
		info, err := c.GetChatInfo(ctx, portal)
		if err != nil {
			return err
		}
		// Chat resyncs contain no message row: wait for the room update itself.
		meta.Type = bridgev2.RemoteEventChatResync
		meta.PostHandleFunc = func(ctx context.Context, p *bridgev2.Portal) {
			select {
			case completed <- nil:
			default:
			}
		}
		remote = &simplevent.ChatResync{EventMeta: meta, ChatInfo: info}
	} else {
		meta.Type = bridgev2.RemoteEventMessage
		remote = &simplevent.Message[backend.Event]{EventMeta: meta, ID: messageID(evt.ChatID, evt.ID), TransactionID: networkid.TransactionID(evt.TransactionID), Data: evt, ConvertMessageFunc: c.convertIncoming}
	}
	result := c.login.QueueRemoteEvent(remote)
	if !result.Success {
		return fmt.Errorf("queue remote event: %w", result.Error)
	}
	if !result.Queued {
		return errors.New("remote event was not queued; checkpoint retained")
	}
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-completed:
		return err
	case <-timer.C:
		return errors.New("remote event processing timed out; checkpoint retained")
	}
}

func (c *Client) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	if !c.online.Load() || c.session == nil {
		return nil, backend.ErrDisconnected
	}
	converted, err := c.convertOutgoing(ctx, msg)
	if err != nil {
		return nil, err
	}
	result, err := c.session.Send(ctx, backend.SendRequest{ChatID: string(msg.Portal.ID), TransactionID: string(msg.Event.ID), Message: converted})
	if err != nil {
		return nil, bridgev2.WrapErrorInStatus(err).WithIsCertain(errors.Is(err, backend.ErrUnsupported)).WithErrorAsMessage()
	}
	if result.ID == "" {
		return nil, errors.New("backend send response has no remote message ID")
	}
	if result.Timestamp.IsZero() {
		result.Timestamp = time.Now()
	}
	return &bridgev2.MatrixMessageResponse{DB: &database.Message{ID: messageID(string(msg.Portal.ID), result.ID), SenderID: c.GetUserID(), Timestamp: result.Timestamp}}, nil
}
