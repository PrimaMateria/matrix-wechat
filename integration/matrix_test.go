package integration

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	_ "go.mau.fi/util/dbutil/litestream"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	_ "maunium.net/go/mautrix/crypto/goolm"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

type credentials struct {
	UserID      id.UserID   `json:"user_id"`
	AccessToken string      `json:"access_token"`
	DeviceID    id.DeviceID `json:"device_id"`
}

func client(t *testing.T) (context.Context, *mautrix.Client, *cryptohelper.CryptoHelper, string) {
	t.Helper()
	base, state := os.Getenv("MATRIX_WECHAT_TEST_HOMESERVER"), os.Getenv("MATRIX_WECHAT_TEST_STATE")
	if base == "" || state == "" {
		t.Skip("run scripts/matrix-smoke.py for the live Matrix acceptance test")
	}
	data, err := os.ReadFile(filepath.Join(state, "client.json"))
	if err != nil {
		t.Fatal(err)
	}
	var credentials credentials
	if err = json.Unmarshal(data, &credentials); err != nil {
		t.Fatal(err)
	}
	cli, err := mautrix.NewClient(base, credentials.UserID, credentials.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	cli.DeviceID = credentials.DeviceID
	cli.Log = zerolog.Nop()
	helper, err := cryptohelper.NewCryptoHelper(cli, []byte("disposable-acceptance-test"), filepath.Join(state, "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	if err = helper.Init(ctx); err != nil {
		t.Fatal(err)
	}
	helper.Machine().SendKeysMinTrust = id.TrustStateUnset
	t.Cleanup(func() { _ = helper.Close() })
	return ctx, cli, helper, state
}
func TestMatrixSetup(t *testing.T) { _, _, _, _ = client(t) }
func TestMatrix(t *testing.T) {
	ctx, cli, helper, state := client(t)
	var mu sync.Mutex
	contents := make(map[string]*event.MessageEventContent)
	cli.Syncer.(mautrix.ExtensibleSyncer).OnEventType(event.EventMessage, func(ctx context.Context, evt *event.Event) {
		mu.Lock()
		defer mu.Unlock()
		content := evt.Content.AsMessage()
		contents[content.Body] = content
	})
	// The syncer receives encrypted messages and dispatches decrypted events.
	syncDone := make(chan error, 1)
	go func() { syncDone <- cli.SyncWithContext(ctx) }()
	t.Cleanup(func() {
		cli.StopSync()
		select {
		case <-syncDone:
		case <-time.After(5 * time.Second):
		}
	})
	wait := func(description string, condition func() bool) {
		t.Helper()
		for !condition() {
			select {
			case <-ctx.Done():
				t.Fatal("timed out: " + description)
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	wait("decrypted rich card", func() bool {
		mu.Lock()
		defer mu.Unlock()
		for body := range contents {
			if strings.Contains(body, "Shared article") {
				return true
			}
		}
		return false
	})
	wait("decrypted file", func() bool { mu.Lock(); defer mu.Unlock(); return contents["example.txt"] != nil })
	mu.Lock()
	file := contents["example.txt"]
	var card *event.MessageEventContent
	for body, content := range contents {
		if strings.Contains(body, "Shared article") {
			card = content
		}
	}
	mu.Unlock()
	if card == nil || !strings.Contains(card.FormattedBody, `href="https://example.com/article"`) || len(card.BeeperLinkPreviews) != 1 || card.BeeperLinkPreviews[0].SiteName != "Example publisher" {
		t.Fatal("rich card metadata missing", card)
	}
	wait("reply relation", func() bool {
		mu.Lock()
		defer mu.Unlock()
		for body, content := range contents {
			if strings.Contains(body, "This is a reply") {
				return content.RelatesTo != nil && content.RelatesTo.GetReplyTo() != ""
			}
		}
		return false
	})
	if file.File == nil || file.File.URL == "" {
		t.Fatal("attachment was not encrypted")
	}
	mxc, err := file.File.URL.Parse()
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := cli.DownloadBytes(ctx, mxc)
	if err != nil {
		t.Fatal("authenticated media download", err)
	}
	if err = file.File.DecryptInPlace(encrypted); err != nil {
		t.Fatal(err)
	}
	if string(encrypted) != "Development fixture\n" {
		t.Fatal("attachment payload changed", string(encrypted))
	}
	unauth, err := http.NewRequestWithContext(ctx, http.MethodGet, cli.HomeserverURL.String()+"/_matrix/client/v1/media/download/"+mxc.Homeserver+"/"+mxc.FileID, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(unauth)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("authenticated media endpoint allowed anonymous access", response.StatusCode)
	}
	db, err := sql.Open("sqlite3", "file:"+filepath.Join(state, "bridge.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var room id.RoomID
	if err = db.QueryRow("SELECT mxid FROM portal WHERE id='dm_friend'").Scan(&room); err != nil {
		t.Fatal(err)
	}
	// Ensure a sync has populated room encryption/membership state before sending.
	wait("room encryption state", func() bool {
		state, err := helper.Machine().StateStore.IsEncrypted(ctx, room)
		return err == nil && state
	})
	encryptedContent, err := helper.Encrypt(ctx, room, event.EventMessage, &event.MessageEventContent{MsgType: event.MsgText, Body: "Encrypted Matrix reply"})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := cli.SendMessageEvent(ctx, room, event.EventEncrypted, encryptedContent)
	if err != nil {
		t.Fatal(err)
	}
	wait("encrypted outbound message committed", func() bool {
		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM message WHERE mxid=?", sent.EventID).Scan(&count)
		return err == nil && count == 1
	})
	// Exercise double puppeting via an explicitly supplied disposable Matrix token.
	rooms, err := cli.JoinedRooms(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var management id.RoomID
	for _, candidate := range rooms.JoinedRooms {
		if candidate == room {
			continue
		}
		var count int
		_ = db.QueryRow("SELECT COUNT(*) FROM portal WHERE mxid=?", candidate).Scan(&count)
		if count == 0 {
			management = candidate
			break
		}
	}
	if management == "" {
		t.Fatal("management room missing")
	}
	_, err = cli.SendMessageEvent(ctx, management, event.EventMessage, &event.MessageEventContent{MsgType: event.MsgText, Body: "login-matrix " + cli.AccessToken})
	if err != nil {
		t.Fatal(err)
	}
	wait("double puppet token stored", func() bool {
		var accessToken string
		err := db.QueryRow(`SELECT access_token FROM "user" WHERE mxid=?`, cli.UserID).Scan(&accessToken)
		return err == nil && accessToken == cli.AccessToken
	})
	fmt.Println("Live Matrix encryption, rich cards, authenticated media, outbound bridging and double puppeting passed.")
}
