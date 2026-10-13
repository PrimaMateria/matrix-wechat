package wechatlinux

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func pipeClient(t *testing.T, opts Options) (*Client, net.Conn) {
	t.Helper()
	a, b := net.Pipe()
	c := newClient(a, opts)
	t.Cleanup(func() { c.Close(); b.Close() })
	return c, b
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	return ctx
}

type testRequest struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func TestConcurrentCallsCorrelateOutOfOrderResponses(t *testing.T) {
	c, server := pipeClient(t, Options{})
	ctx := testContext(t)
	const count = 24
	serverDone := make(chan error, 1)
	go func() {
		dec := json.NewDecoder(server)
		requests := make([]testRequest, count)
		for i := range requests {
			if err := dec.Decode(&requests[i]); err != nil {
				serverDone <- err
				return
			}
		}
		enc := json.NewEncoder(server)
		for i := len(requests) - 1; i >= 0; i-- {
			var params map[string]int
			if err := json.Unmarshal(requests[i].Params, &params); err != nil {
				serverDone <- err
				return
			}
			if err := enc.Encode(map[string]any{"id": requests[i].ID, "result": params}); err != nil {
				serverDone <- err
				return
			}
		}
		serverDone <- nil
	}()
	done := make(chan error, count)
	for i := 0; i < count; i++ {
		go func(value int) {
			var result map[string]int
			if err := c.Call(ctx, "echo", map[string]int{"value": value}, &result); err != nil {
				done <- err
				return
			}
			if result["value"] != value {
				done <- fmt.Errorf("wrong response: %v for %d", result, value)
				return
			}
			done <- nil
		}(i)
	}
	for i := 0; i < count; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

func TestCanceledCallDoesNotStealLaterResponse(t *testing.T) {
	c, server := pipeClient(t, Options{})
	ctx := testContext(t)
	canceled, cancel := context.WithCancel(ctx)
	firstRead := make(chan struct{})
	serverDone := make(chan error, 1)
	go func() {
		dec := json.NewDecoder(server)
		var first, second testRequest
		if err := dec.Decode(&first); err != nil {
			serverDone <- err
			return
		}
		close(firstRead)
		if err := dec.Decode(&second); err != nil {
			serverDone <- err
			return
		}
		enc := json.NewEncoder(server)
		if err := enc.Encode(map[string]any{"id": first.ID, "result": "late"}); err != nil {
			serverDone <- err
			return
		}
		serverDone <- enc.Encode(map[string]any{"id": second.ID, "result": "current"})
	}()
	done := make(chan error, 1)
	go func() { done <- c.Call(canceled, "first", nil, nil) }()
	<-firstRead
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	var result string
	if err := c.Call(ctx, "second", nil, &result); err != nil {
		t.Fatal(err)
	}
	if result != "current" {
		t.Fatalf("got %q", result)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	pending := len(c.pending)
	c.mu.Unlock()
	if pending != 0 {
		t.Fatalf("leaked %d pending calls", pending)
	}
}

func TestOverflowReportedWithoutBlockingOtherSubscribers(t *testing.T) {
	c, server := pipeClient(t, Options{})
	ctx := testContext(t)
	slow, err := c.SubscribeEvents(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	fast, err := c.SubscribeEvents(ctx, 4)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		enc := json.NewEncoder(server)
		for i := 0; i < 3; i++ {
			_ = enc.Encode(map[string]any{"event": Event{Type: "message", Message: &Message{ID: fmt.Sprint(i)}}})
		}
	}()
	select {
	case err := <-slow.Errors:
		if !errors.Is(err, ErrEventOverflow) {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for i := 0; i < 3; i++ {
		select {
		case event := <-fast.Events:
			if event.Message.ID != fmt.Sprint(i) {
				t.Fatalf("out of order: %+v", event)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	buffered, ok := <-slow.Events
	if !ok || buffered.Message.ID != "0" {
		t.Fatalf("first buffered event lost: %+v", buffered)
	}
	if _, ok := <-slow.Events; ok {
		t.Fatal("overflowed subscription still open")
	}
}

func TestHelperErrorsAndNativeIDsRemainExact(t *testing.T) {
	c, server := pipeClient(t, Options{})
	ctx := testContext(t)
	go func() {
		dec := json.NewDecoder(server)
		enc := json.NewEncoder(server)
		var request testRequest
		_ = dec.Decode(&request)
		_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": "unverified", "message": "send hook not verified", "details": map[string]any{"build": "test"}}})
		_ = dec.Decode(&request)
		_ = enc.Encode(map[string]any{"id": request.ID, "result": HistoryResult{Messages: []Message{{ID: "18446744073709551615", ChatID: "room", SenderID: "sender", Kind: "text"}}}})
	}()
	_, err := c.Send(ctx, SendRequest{ChatID: "room", Kind: "text", Text: "test"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "unverified" || !strings.Contains(string(apiErr.Details), "test") {
		t.Fatalf("got %v", err)
	}
	history, err := c.History(ctx, HistoryRequest{ChatID: "room", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Messages) != 1 || history.Messages[0].ID != "18446744073709551615" {
		t.Fatalf("native ID corrupted: %+v", history)
	}
}

func TestDisconnectFailsPendingRequestsAndSubscription(t *testing.T) {
	c, server := pipeClient(t, Options{})
	ctx := testContext(t)
	sub, err := c.SubscribeEvents(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	go func() { var req testRequest; _ = json.NewDecoder(server).Decode(&req); server.Close() }()
	_, err = c.Status(ctx)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("call got %v", err)
	}
	select {
	case err := <-sub.Errors:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("subscription got %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err = c.Status(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("subsequent call got %v", err)
	}
}

func TestMalformedAndOversizedFramesTerminateConnection(t *testing.T) {
	for _, test := range []struct {
		name, frame string
		limit       int
	}{
		{"malformed", "{\n", 512},
		{"empty_response", "{}\n", 512},
		{"mixed_event", "{\"id\":\"1\",\"event\":{\"type\":\"message\"}}\n", 512},
		{"missing_event_type", "{\"event\":{}}\n", 512},
		{"oversized", strings.Repeat("x", 1024) + "\n", 512},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, server := pipeClient(t, Options{MaxFrameBytes: test.limit})
			ctx := testContext(t)
			sub, err := c.SubscribeEvents(ctx, 1)
			if err != nil {
				t.Fatal(err)
			}
			go func() { _, _ = io.WriteString(server, test.frame) }()
			select {
			case err := <-sub.Errors:
				if err == nil {
					t.Fatal("missing protocol error")
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if c.Err() == nil {
				t.Fatal("transport remained open")
			}
		})
	}
}

func TestBlockedWriteCancellationTerminatesTransport(t *testing.T) {
	c, _ := pipeClient(t, Options{}) // Peer deliberately never reads.
	ctx, cancel := context.WithTimeout(testContext(t), 20*time.Millisecond)
	defer cancel()
	err := c.Call(ctx, "blocked", nil, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	if c.Err() == nil {
		t.Fatal("failed write left transport open")
	}
}

func TestOutboundLimitDoesNotCorruptNextRequest(t *testing.T) {
	c, server := pipeClient(t, Options{MaxFrameBytes: 256})
	ctx := testContext(t)
	if err := c.Call(ctx, "oversized", map[string]string{"text": strings.Repeat("x", 512)}, nil); err == nil {
		t.Fatal("accepted oversized frame")
	}
	go func() {
		line, _ := bufio.NewReader(server).ReadBytes('\n')
		var req testRequest
		_ = json.Unmarshal(line, &req)
		_ = json.NewEncoder(server).Encode(map[string]any{"id": req.ID, "result": Status{State: "logged_out"}})
	}()
	status, err := c.Status(ctx)
	if err != nil || status.State != "logged_out" {
		t.Fatalf("valid call failed: %+v %v", status, err)
	}
}

func TestDialUnixSocketAndSubscriptionCancellation(t *testing.T) {
	ctx := testContext(t)
	path := filepath.Join(t.TempDir(), "helper.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var req testRequest
		if json.NewDecoder(conn).Decode(&req) != nil {
			return
		}
		_ = json.NewEncoder(conn).Encode(map[string]any{"id": req.ID, "result": Status{State: "logged_in", Account: &Account{ID: "wxid_test"}}})
		_, _ = io.Copy(io.Discard, conn)
	}()
	c, err := Dial(ctx, path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	status, err := c.Status(ctx)
	if err != nil || status.Account == nil || status.Account.ID != "wxid_test" {
		t.Fatalf("status: %+v %v", status, err)
	}
	eventCtx, cancel := context.WithCancel(ctx)
	sub, err := c.SubscribeEvents(eventCtx, 2)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-sub.Errors:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, ok := <-sub.Events; ok {
		t.Fatal("subscription remained open")
	}
	if c.Err() != nil {
		t.Fatalf("subscription cancellation closed connection: %v", c.Err())
	}
	if _, err = Dial(ctx, filepath.Join(t.TempDir(), "absent.sock"), Options{}); err == nil {
		t.Fatal("dialed absent socket")
	}
}
