package connector

import (
	"context"
	"errors"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend/fake"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
	"strings"
	"testing"
)

func testClient(t *testing.T) *Client {
	t.Helper()
	f, err := fake.New(fake.Fixture{Account: backend.Account{ID: "account", Profile: backend.Profile{ID: "self"}}, Capabilities: backend.Capabilities{Send: []backend.Kind{backend.Text, backend.CardMessage, backend.Image, backend.File}, Replies: true}, Chats: []backend.Chat{{ID: "chat"}}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := f.Restore(context.Background(), "account")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Connect(context.Background())
	return &Client{connector: &Connector{Config: Config{MaxMediaSize: 1024}}, session: s, login: &bridgev2.UserLogin{UserLogin: &database.UserLogin{ID: "account", Metadata: &LoginMetadata{AccountID: "account", UserID: "self"}}}}
}

type mediaIntent struct {
	bridgev2.MatrixAPI
	encrypted bool
	uploads   int
}

func (m *mediaIntent) UploadMedia(ctx context.Context, room id.RoomID, data []byte, name, mime string) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	m.uploads++
	var file *event.EncryptedFileInfo
	if m.encrypted {
		file = &event.EncryptedFileInfo{URL: "mxc://example/encrypted"}
	}
	return "mxc://example/media", file, nil
}
func TestRichCards(t *testing.T) {
	card := &backend.Card{Title: `Title <script> "quote"`, Description: "line one\n<b>not markup</b>", Source: "Example & publisher", URL: "https://example.com/article?a=1&b=2"}
	content := cardContent(card)
	for _, value := range []string{card.Title, card.Description, card.Source, card.URL} {
		if !strings.Contains(content.Body, value) {
			t.Fatalf("plain fallback lost %q", value)
		}
	}
	if strings.Contains(content.FormattedBody, "<script>") || strings.Contains(content.FormattedBody, "<b>not markup</b>") {
		t.Fatal("hook HTML was trusted", content.FormattedBody)
	}
	if len(content.BeeperLinkPreviews) != 1 || content.BeeperLinkPreviews[0].CanonicalURL != card.URL {
		t.Fatal("preview lost")
	}
	for _, url := range []string{"javascript:alert(1)", "data:text/html,hi", "https://user:secret@example.com", "//example.com", "not a url"} {
		card.URL = url
		content = cardContent(card)
		if strings.Contains(content.FormattedBody, "<a ") || len(content.BeeperLinkPreviews) != 0 {
			t.Fatal("unsafe URL made active", url)
		}
	}
	card.URL = ""
	content = cardContent(card)
	if content.Body == "" {
		t.Fatal("missing card fallback")
	}
}
func TestEncryptedCardThumbnailAndReply(t *testing.T) {
	c := testClient(t)
	intent := &mediaIntent{encrypted: true}
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0}
	evt := backend.Event{ChatID: "chat", Message: backend.Message{Kind: backend.CardMessage, ReplyTo: "original", Card: &backend.Card{Title: "Article", URL: "https://example.com", Thumbnail: &backend.Media{Data: png, Name: "thumbnail.png", Width: 1, Height: 1}}}}
	result, err := c.convertIncoming(context.Background(), &bridgev2.Portal{Portal: &database.Portal{MXID: "!room:example"}}, intent, evt)
	if err != nil {
		t.Fatal(err)
	}
	preview := result.Parts[0].Content.BeeperLinkPreviews[0]
	if preview.ImageEncryption == nil || preview.ImageURL == "" || intent.uploads != 1 {
		t.Fatal("encrypted thumbnail was lost")
	}
	if result.ReplyTo == nil || result.ReplyTo.MessageID != messageID("chat", "original") {
		t.Fatal("card reply mapping lost")
	}
	evt.Message.Card.Thumbnail = &backend.Media{Ref: "missing"}
	result, err = c.convertIncoming(context.Background(), &bridgev2.Portal{Portal: &database.Portal{}}, intent, evt)
	if err != nil || !strings.Contains(result.Parts[0].Content.Body, "Article") {
		t.Fatal("optional thumbnail lost article", err)
	}
}
func TestMediaPartsLimitsAndNames(t *testing.T) {
	c := testClient(t)
	intent := &mediaIntent{encrypted: true}
	evt := backend.Event{ChatID: "chat", Message: backend.Message{Kind: backend.File, Text: "Caption", Media: []backend.Media{{Name: "first.txt", Data: []byte("one")}, {Name: "second.txt", Data: []byte("two")}}}}
	result, err := c.convertIncoming(context.Background(), &bridgev2.Portal{Portal: &database.Portal{}}, intent, evt)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Parts) != 2 || result.Parts[0].ID == result.Parts[1].ID || result.Parts[0].Content.File == nil || result.Parts[0].Content.FileName != "first.txt" {
		t.Fatal("multipart attachment metadata lost")
	}
	if _, err = c.readMedia(context.Background(), backend.Media{Data: make([]byte, 1025)}); err == nil {
		t.Fatal("oversize accepted")
	}
	evt.Message.Media = nil
	if _, err = c.convertIncoming(context.Background(), &bridgev2.Portal{}, intent, evt); err == nil {
		t.Fatal("missing attachment accepted")
	}
}
func TestOutgoingRichLinksAndUnsupportedMedia(t *testing.T) {
	c := testClient(t)
	msg := &bridgev2.MatrixMessage{MatrixEventBase: bridgev2.MatrixEventBase[*event.MessageEventContent]{Event: &event.Event{ID: "$event", Type: event.EventMessage}, Content: &event.MessageEventContent{MsgType: event.MsgText, Body: "Example", Format: event.FormatHTML, FormattedBody: `Read <a href="https://example.com/article">the article</a>`, BeeperLinkPreviews: []*event.BeeperLinkPreview{{LinkPreview: event.LinkPreview{CanonicalURL: "https://example.com/article", Title: "Title", Description: "Description"}}}}}, ReplyTo: &database.Message{ID: messageID("chat", "reply")}}
	result, err := c.convertOutgoing(context.Background(), msg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "https://example.com/article") || result.Card == nil || result.Card.Title != "Title" || result.Kind != backend.CardMessage || result.ReplyTo != "reply" {
		t.Fatal("outbound rich content lost", result)
	}
	msg.Content = &event.MessageEventContent{MsgType: event.MsgAudio}
	if _, err = c.convertOutgoing(context.Background(), msg); !errors.Is(err, backend.ErrUnsupported) {
		t.Fatal("unsupported audio not rejected before upload", err)
	}
}
func TestOpaqueMessageIDs(t *testing.T) {
	a, b := messageID("a:b", "c"), messageID("a", "b:c")
	if a == b {
		t.Fatal("ID collision")
	}
	raw, err := rawMessageID(a)
	if err != nil || raw != "c" {
		t.Fatal(raw, err)
	}
	if messageID("chat", "same") == messageID("other-chat", "same") {
		t.Fatal("cross-chat collision")
	}
	c := testClient(t)
	if c.portalKey("chat").Receiver != networkid.UserLoginID("account") {
		t.Fatal("portal not account-scoped")
	}
}
