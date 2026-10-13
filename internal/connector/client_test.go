package connector

import (
	"context"
	"errors"
	"testing"

	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend/fake"
)

func TestCheckpointOnlyAfterDeliveryAndSave(t *testing.T) {
	for _, fail := range []string{"deliver", "save", "none"} {
		t.Run(fail, func(t *testing.T) {
			factory, _ := fake.New(fake.Fixture{Account: backend.Account{ID: "account", Profile: backend.Profile{ID: "self"}}, Events: []backend.Event{{ID: "1", ChatID: "chat", SenderID: "friend"}}})
			session, _ := factory.Restore(context.Background(), "account")
			_ = session.Connect(context.Background())
			meta := &LoginMetadata{AccountID: "account"}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var delivered, saved int
			problem := errors.New("test failure")
			err := consumeEvents(ctx, session, meta, func(context.Context, backend.Event) error {
				delivered++
				if meta.Cursor != "" {
					t.Fatal("cursor advanced before delivery")
				}
				if fail == "deliver" {
					return problem
				}
				return nil
			}, func(context.Context) error {
				saved++
				if meta.Cursor != "1" {
					t.Fatal("wrong cursor persisted")
				}
				if fail == "save" {
					return problem
				}
				cancel()
				return nil
			})
			if delivered != 1 {
				t.Fatal(delivered)
			}
			if fail == "none" {
				if meta.Cursor != "1" || !errors.Is(err, context.Canceled) {
					t.Fatal(meta.Cursor, err)
				}
			} else {
				if meta.Cursor != "" || !errors.Is(err, problem) {
					t.Fatal("failed event advanced checkpoint", meta.Cursor, err)
				}
			}
			if fail == "deliver" && saved != 0 {
				t.Fatal("saved before successful delivery")
			}
		})
	}
}
func TestBackendSelectionIsExplicit(t *testing.T) {
	c := New()
	c.Config = Config{Backend: "disabled", MaxMediaSize: 1024}
	if err := c.ValidateConfig(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Factory.StartLogin(context.Background(), "account"); !errors.Is(err, backend.ErrUnavailable) {
		t.Fatal("disabled backend logged in", err)
	}
	c.Config.Backend = "fake"
	if err := c.ValidateConfig(); err == nil {
		t.Fatal("fake enabled without fixtures")
	}
	c.Config.Backend = "unknown"
	if err := c.ValidateConfig(); err == nil {
		t.Fatal("unknown backend accepted")
	}
	injected := NewWithBackend("hook", backend.Disabled{})
	injected.Config = Config{Backend: "hook", MaxMediaSize: 1024}
	if err := injected.ValidateConfig(); err != nil {
		t.Fatal("injected adapter not accepted", err)
	}
}
