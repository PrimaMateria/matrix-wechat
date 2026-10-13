// Package backend defines the transport-independent contract for a WeChat hook.
// It deliberately has no Matrix or hook-specific HTTP dependencies.
package backend

import (
	"context"
	"errors"
	"io"
	"time"
)

var (
	ErrUnavailable  = errors.New("WeChat hook is not configured")
	ErrUnauthorized = errors.New("WeChat session has expired")
	ErrUnsupported  = errors.New("operation is not supported by the WeChat backend")
	ErrDisconnected = errors.New("WeChat backend disconnected")
)

type Kind string

const (
	Text            Kind = "text"
	Image           Kind = "image"
	Sticker         Kind = "sticker"
	Video           Kind = "video"
	Audio           Kind = "audio"
	File            Kind = "file"
	LocationMessage Kind = "location"
	CardMessage     Kind = "card"
	Notice          Kind = "notice"
	Revoke          Kind = "revoke"
	ChatChanged     Kind = "chat_changed"
)

// Capabilities describe outbound operations, not what may be received.
type Capabilities struct {
	Send     []Kind `json:"send"`
	Replies  bool   `json:"replies"`
	Mentions bool   `json:"mentions"`
	Revoke   bool   `json:"revoke"`
}

func (c Capabilities) Supports(k Kind) bool {
	for _, s := range c.Send {
		if s == k {
			return true
		}
	}
	return false
}

type Profile struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar *Media `json:"avatar,omitempty"`
}
type Account struct {
	ID      string  `json:"id"`
	Profile Profile `json:"profile"`
}
type Chat struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Topic  string `json:"topic,omitempty"`
	Group  bool   `json:"group"`
	PeerID string `json:"peer_id,omitempty"`
	Avatar *Media `json:"avatar,omitempty"`
}
type Member struct {
	Profile  Profile `json:"profile"`
	Nickname string  `json:"nickname,omitempty"`
}

// Media.Ref is opaque and session-scoped. Data may provide inline bytes instead.
type Media struct {
	Ref        string `json:"ref,omitempty"`
	Name       string `json:"name"`
	MIME       string `json:"mime"`
	Data       []byte `json:"data,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	DurationMS int    `json:"duration_ms,omitempty"`
}
type Location struct {
	Name      string  `json:"name"`
	Address   string  `json:"address,omitempty"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// Card preserves articles, links, mini-apps and contact cards. Raw is optional
// structured hook data, never trusted HTML.
type Card struct {
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source,omitempty"`
	URL         string `json:"url,omitempty"`
	Thumbnail   *Media `json:"thumbnail,omitempty"`
	Raw         string `json:"raw,omitempty"`
}
type Message struct {
	Kind       Kind      `json:"kind"`
	Text       string    `json:"text,omitempty"`
	Media      []Media   `json:"media,omitempty"`
	Card       *Card     `json:"card,omitempty"`
	Location   *Location `json:"location,omitempty"`
	ReplyTo    string    `json:"reply_to,omitempty"`
	TargetID   string    `json:"target_id,omitempty"`
	Mentions   []string  `json:"mentions,omitempty"`
	MentionAll bool      `json:"mention_all,omitempty"`
}

// IDs must remain stable on replay. ChatID and ID together identify a message.
// Cursor is an opaque token following this event, scoped to AccountID.
type Event struct {
	AccountID     string    `json:"account_id"`
	ID            string    `json:"id"`
	ChatID        string    `json:"chat_id"`
	SenderID      string    `json:"sender_id"`
	Timestamp     time.Time `json:"timestamp"`
	Cursor        string    `json:"cursor"`
	TransactionID string    `json:"transaction_id,omitempty"`
	Message       Message   `json:"message"`
	TargetID      string    `json:"target_id,omitempty"`
}
type SendRequest struct {
	ChatID string
	// An adapter must deduplicate retries with the same transaction ID.
	TransactionID string
	Message       Message
}
type SendResult struct {
	ID        string
	Timestamp time.Time
}
type LoginChallenge struct {
	Instructions string
	QR           string
	Image        []byte
}
type Authentication interface {
	Challenge() LoginChallenge
	Wait(context.Context) (Session, error)
	Cancel()
}
type Factory interface {
	// Restore constructs a session; IO belongs in Session.Connect.
	Restore(context.Context, string) (Session, error)
	StartLogin(context.Context, string) (Authentication, error)
}
type Session interface {
	Connect(context.Context) error
	Close() error
	Logout(context.Context) error
	Self(context.Context) (Account, error)
	Capabilities() Capabilities
	Contacts(context.Context) ([]Profile, error)
	Chats(context.Context) ([]Chat, error)
	User(context.Context, string) (Profile, error)
	Chat(context.Context, string) (Chat, error)
	Members(context.Context, string) ([]Member, error)
	Send(context.Context, SendRequest) (SendResult, error)
	// Next blocks for one event after cursor. Errors never advance the cursor.
	// Calls are serialized per session and reconnects must support replay.
	Next(context.Context, string) (Event, error)
	OpenMedia(context.Context, Media) (io.ReadCloser, error)
}

// Disabled is the production default until a real hook adapter is installed.
type Disabled struct{}

func (Disabled) Restore(context.Context, string) (Session, error) { return nil, ErrUnavailable }
func (Disabled) StartLogin(context.Context, string) (Authentication, error) {
	return nil, ErrUnavailable
}
