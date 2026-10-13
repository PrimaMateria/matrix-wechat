// Package wechatlinux exposes the local instrumented WeChat Linux helper.
// Native operations are available only when the helper reports verified support.
package wechatlinux

import "encoding/json"

type Account struct {
	ID     string          `json:"id"`
	Name   string          `json:"name,omitempty"`
	Avatar string          `json:"avatar,omitempty"`
	Native json.RawMessage `json:"native,omitempty"`
}

type Status struct {
	State     string          `json:"state"`
	Account   *Account        `json:"account,omitempty"`
	PID       int             `json:"pid,omitempty"`
	BuildHash string          `json:"build_hash,omitempty"`
	Native    json.RawMessage `json:"native,omitempty"`
}

type Capability struct {
	Name      string   `json:"name"`
	Direction string   `json:"direction,omitempty"`
	Status    string   `json:"status"`
	Reason    string   `json:"reason,omitempty"`
	Evidence  []string `json:"evidence,omitempty"`
}

type Capabilities struct {
	Capabilities []Capability `json:"capabilities"`
	BuildHash    string       `json:"build_hash,omitempty"`
}

type LoginRequest struct {
	Refresh bool `json:"refresh,omitempty"`
}

type QRCode struct {
	Path      string `json:"path,omitempty"`
	PNGBase64 string `json:"png_base64,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

type LoginResult struct {
	State   string          `json:"state"`
	QR      *QRCode         `json:"qr,omitempty"`
	Account *Account        `json:"account,omitempty"`
	Native  json.RawMessage `json:"native,omitempty"`
}

type Database struct {
	Path      string          `json:"path"`
	Encrypted bool            `json:"encrypted"`
	Readable  bool            `json:"readable"`
	Tables    []Table         `json:"tables,omitempty"`
	Native    json.RawMessage `json:"native,omitempty"`
}

type Table struct {
	Name    string   `json:"name"`
	Columns []Column `json:"columns,omitempty"`
}

type Column struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
}

type DatabaseInspection struct {
	Databases []Database      `json:"databases"`
	Native    json.RawMessage `json:"native,omitempty"`
}

type Contact struct {
	ID     string          `json:"id"`
	Name   string          `json:"name,omitempty"`
	Avatar string          `json:"avatar,omitempty"`
	Native json.RawMessage `json:"native,omitempty"`
}

type Contacts struct {
	Contacts []Contact `json:"contacts"`
}

type Group struct {
	ID      string          `json:"id"`
	Name    string          `json:"name,omitempty"`
	Avatar  string          `json:"avatar,omitempty"`
	Topic   string          `json:"topic,omitempty"`
	Members []Contact       `json:"members,omitempty"`
	Native  json.RawMessage `json:"native,omitempty"`
}

type Groups struct {
	Groups []Group `json:"groups"`
}

type Location struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Label     string  `json:"label,omitempty"`
}

type Media struct {
	ID     string          `json:"id,omitempty"`
	Kind   string          `json:"kind,omitempty"`
	State  string          `json:"state"`
	Path   string          `json:"path,omitempty"`
	MIME   string          `json:"mime,omitempty"`
	Name   string          `json:"name,omitempty"`
	Size   int64           `json:"size,omitempty"`
	Native json.RawMessage `json:"native,omitempty"`
}

type Message struct {
	ID           string          `json:"id"`
	AccountID    string          `json:"account_id,omitempty"`
	ChatID       string          `json:"chat_id"`
	ChatType     string          `json:"chat_type,omitempty"`
	SenderID     string          `json:"sender_id"`
	Kind         string          `json:"kind"`
	Text         string          `json:"text,omitempty"`
	Timestamp    int64           `json:"timestamp"`
	Own          bool            `json:"own,omitempty"`
	ReplyTo      string          `json:"reply_to,omitempty"`
	RevokeTarget string          `json:"revoke_target,omitempty"`
	Mentions     []string        `json:"mentions,omitempty"`
	Media        *Media          `json:"media,omitempty"`
	Location     *Location       `json:"location,omitempty"`
	Native       json.RawMessage `json:"native,omitempty"`
}

type Event struct {
	Type      string          `json:"type"`
	AccountID string          `json:"account_id,omitempty"`
	ChatID    string          `json:"chat_id,omitempty"`
	Message   *Message        `json:"message,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type HistoryRequest struct {
	ChatID string `json:"chat_id"`
	Cursor string `json:"cursor,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

type HistoryResult struct {
	Messages   []Message `json:"messages"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type MediaRequest struct {
	MessageID string `json:"message_id,omitempty"`
	MediaID   string `json:"media_id,omitempty"`
}

type SendRequest struct {
	ChatID   string    `json:"chat_id"`
	Kind     string    `json:"kind"`
	Text     string    `json:"text,omitempty"`
	Path     string    `json:"path,omitempty"`
	ReplyTo  string    `json:"reply_to,omitempty"`
	Mentions []string  `json:"mentions,omitempty"`
	Location *Location `json:"location,omitempty"`
}

type SendResult struct {
	MessageID string          `json:"message_id"`
	Native    json.RawMessage `json:"native,omitempty"`
}

// ChatActionRequest covers group membership, notification mute, metadata, and
// message revocation. Native support is checked by the helper for each action.
type ChatActionRequest struct {
	ChatID     string   `json:"chat_id"`
	Action     string   `json:"action"`
	UserIDs    []string `json:"user_ids,omitempty"`
	MessageID  string   `json:"message_id,omitempty"`
	Name       string   `json:"name,omitempty"`
	AvatarPath string   `json:"avatar_path,omitempty"`
	Topic      string   `json:"topic,omitempty"`
	Muted      *bool    `json:"muted,omitempty"`
}

type ProfileActionRequest struct {
	Action     string `json:"action"`
	Name       string `json:"name,omitempty"`
	AvatarPath string `json:"avatar_path,omitempty"`
}

type ActionResult struct {
	Native json.RawMessage `json:"native,omitempty"`
}
