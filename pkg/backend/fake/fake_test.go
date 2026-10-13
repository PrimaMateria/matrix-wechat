package fake

import (
	"context"
	"errors"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"io"
	"testing"
	"time"
)

func fixture(id string) Fixture {
	return Fixture{Account: backend.Account{ID: id, Profile: backend.Profile{ID: id, Name: id}}, Capabilities: backend.Capabilities{Send: []backend.Kind{backend.Text}}, Contacts: []backend.Profile{{ID: "friend"}}, Chats: []backend.Chat{{ID: "chat"}}, Events: []backend.Event{{ID: "1", ChatID: "chat", SenderID: "friend", Message: backend.Message{Kind: backend.Text, Text: "hello"}}}, Media: map[string][]byte{"attachment": []byte("hello")}}
}
func TestReplayFaultRecoveryAndIsolation(t *testing.T) {
	a, b := fixture("a"), fixture("b")
	a.Faults = map[string]string{"": "disconnect"}
	f, err := New(a, b)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	sa, _ := f.Restore(ctx, "a")
	sb, _ := f.Restore(ctx, "b")
	if err = sa.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	_ = sb.Connect(ctx)
	if _, err = sa.Next(ctx, ""); !errors.Is(err, backend.ErrDisconnected) {
		t.Fatal(err)
	}
	_ = sa.Close()
	_ = sa.Connect(ctx)
	first, err := sa.Next(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := sa.Next(ctx, "")
	if err != nil || replay.ID != first.ID || replay.Cursor != first.Cursor {
		t.Fatal("unstable replay", err)
	}
	other, err := sb.Next(ctx, "")
	if err != nil || other.AccountID == first.AccountID {
		t.Fatal("account leak", err)
	}
	timeout, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	if _, err = sa.Next(timeout, first.Cursor); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("exhausted stream must honor cancellation", err)
	}
}
func TestSendIdempotencyAndCapabilities(t *testing.T) {
	f, _ := New(fixture("a"))
	s, _ := f.Restore(context.Background(), "a")
	_ = s.Connect(context.Background())
	request := backend.SendRequest{ChatID: "chat", TransactionID: "txn", Message: backend.Message{Kind: backend.Text, Text: "hello"}}
	first, err := s.Send(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.Send(context.Background(), request)
	if err != nil || retry != first {
		t.Fatal("retry sends a duplicate", err)
	}
	request.Message.Kind = backend.Audio
	if _, err = s.Send(context.Background(), request); !errors.Is(err, backend.ErrUnsupported) {
		t.Fatal(err)
	}
	reader, err := s.OpenMedia(context.Background(), backend.Media{Ref: "attachment"})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, _ := io.ReadAll(reader)
	if string(data) != "hello" {
		t.Fatal(string(data))
	}
}
func TestAuthenticationCancellationAndExpiry(t *testing.T) {
	a := fixture("a")
	a.Faults = map[string]string{"": "unauthorized"}
	f, _ := New(a)
	auth, _ := f.StartLogin(context.Background(), "a")
	auth.Cancel()
	if _, err := auth.Wait(context.Background()); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s, _ := f.Restore(context.Background(), "a")
	_ = s.Connect(context.Background())
	if _, err := s.Next(context.Background(), ""); !errors.Is(err, backend.ErrUnauthorized) {
		t.Fatal(err)
	}
	if _, err := f.Restore(context.Background(), "other"); !errors.Is(err, backend.ErrUnauthorized) {
		t.Fatal(err)
	}
}
func TestInvalidFixtures(t *testing.T) {
	for _, fixtures := range [][]Fixture{{{}}, {fixture("a"), fixture("a")}} {
		if _, err := New(fixtures...); err == nil {
			t.Fatal("accepted invalid fixture")
		}
	}
	a := fixture("a")
	a.Events[0].AccountID = "b"
	if _, err := New(a); err == nil {
		t.Fatal("accepted cross-account event")
	}
}
