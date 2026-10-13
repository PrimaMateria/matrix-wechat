// Package fake implements deterministic local fixtures. It never contacts WeChat.
package fake

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
)

type Fixture struct {
	Account      backend.Account             `json:"account"`
	Capabilities backend.Capabilities        `json:"capabilities"`
	Contacts     []backend.Profile           `json:"contacts"`
	Chats        []backend.Chat              `json:"chats"`
	Members      map[string][]backend.Member `json:"members"`
	Events       []backend.Event             `json:"events"`
	Media        map[string][]byte           `json:"media,omitempty"`
	// Cursor-keyed one-shot faults: disconnect or unauthorized. Key "send"
	// fails one send, allowing recovery and uncertain-send tests.
	Faults map[string]string `json:"faults,omitempty"`
}
type Factory struct {
	mu       sync.Mutex
	fixtures map[string]Fixture
	sessions map[string]*Session
}

func New(fixtures ...Fixture) (*Factory, error) {
	f := &Factory{fixtures: make(map[string]Fixture), sessions: make(map[string]*Session)}
	for _, fixture := range fixtures {
		if fixture.Account.ID == "" || fixture.Account.Profile.ID == "" {
			return nil, errors.New("fake account and profile IDs are required")
		}
		if _, exists := f.fixtures[fixture.Account.ID]; exists {
			return nil, errors.New("duplicate fake account ID")
		}
		for i := range fixture.Events {
			e := &fixture.Events[i]
			if e.AccountID == "" {
				e.AccountID = fixture.Account.ID
			}
			if e.AccountID != fixture.Account.ID || e.ID == "" || e.ChatID == "" || e.SenderID == "" {
				return nil, fmt.Errorf("invalid fake event %d", i)
			}
			e.Cursor = strconv.Itoa(i + 1)
		}
		f.fixtures[fixture.Account.ID] = fixture
	}
	return f, nil
}
func Load(paths []string) (*Factory, error) {
	var fixtures []Fixture
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var fixture Fixture
		if err = json.Unmarshal(data, &fixture); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		fixtures = append(fixtures, fixture)
	}
	return New(fixtures...)
}
func (f *Factory) Restore(ctx context.Context, accountID string) (backend.Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	fixture, ok := f.fixtures[accountID]
	if !ok {
		return nil, backend.ErrUnauthorized
	}
	if session := f.sessions[accountID]; session != nil {
		return session, nil
	}
	faults := make(map[string]string)
	for k, v := range fixture.Faults {
		faults[k] = v
	}
	s := &Session{fixture: fixture, faults: faults, sent: make(map[string]backend.SendResult)}
	f.sessions[accountID] = s
	return s, nil
}
func (f *Factory) StartLogin(ctx context.Context, accountID string) (backend.Authentication, error) {
	s, err := f.Restore(ctx, accountID)
	if err != nil {
		return nil, err
	}
	return &Authentication{session: s, done: make(chan struct{})}, nil
}

type Authentication struct {
	session backend.Session
	done    chan struct{}
	once    sync.Once
}

func (a *Authentication) Challenge() backend.LoginChallenge {
	return backend.LoginChallenge{Instructions: "Development fixture: no real WeChat account will be connected."}
}
func (a *Authentication) Cancel() { a.once.Do(func() { close(a.done) }) }
func (a *Authentication) Wait(ctx context.Context) (backend.Session, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-a.done:
		return nil, context.Canceled
	default:
	}
	return a.session, nil
}

type Session struct {
	mu      sync.Mutex
	fixture Fixture
	online  bool
	faults  map[string]string
	sent    map[string]backend.SendResult
}

func (s *Session) Connect(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.online = true
	return nil
}
func (s *Session) Close() error                     { s.mu.Lock(); defer s.mu.Unlock(); s.online = false; return nil }
func (s *Session) Logout(ctx context.Context) error { return s.Close() }
func (s *Session) check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.online {
		return backend.ErrDisconnected
	}
	return nil
}
func (s *Session) Self(ctx context.Context) (backend.Account, error) {
	if err := s.check(ctx); err != nil {
		return backend.Account{}, err
	}
	return s.fixture.Account, nil
}
func (s *Session) Capabilities() backend.Capabilities {
	c := s.fixture.Capabilities
	c.Send = slices.Clone(c.Send)
	return c
}
func (s *Session) Contacts(ctx context.Context) ([]backend.Profile, error) {
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	return slices.Clone(s.fixture.Contacts), nil
}
func (s *Session) Chats(ctx context.Context) ([]backend.Chat, error) {
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	return slices.Clone(s.fixture.Chats), nil
}
func (s *Session) User(ctx context.Context, id string) (backend.Profile, error) {
	if err := s.check(ctx); err != nil {
		return backend.Profile{}, err
	}
	if id == s.fixture.Account.Profile.ID {
		return s.fixture.Account.Profile, nil
	}
	for _, p := range s.fixture.Contacts {
		if p.ID == id {
			return p, nil
		}
	}
	return backend.Profile{}, fmt.Errorf("unknown fixture user %q", id)
}
func (s *Session) Chat(ctx context.Context, id string) (backend.Chat, error) {
	if err := s.check(ctx); err != nil {
		return backend.Chat{}, err
	}
	for _, p := range s.fixture.Chats {
		if p.ID == id {
			return p, nil
		}
	}
	return backend.Chat{}, fmt.Errorf("unknown fixture chat %q", id)
}
func (s *Session) Members(ctx context.Context, id string) ([]backend.Member, error) {
	if _, err := s.Chat(ctx, id); err != nil {
		return nil, err
	}
	return slices.Clone(s.fixture.Members[id]), nil
}
func (s *Session) Send(ctx context.Context, r backend.SendRequest) (backend.SendResult, error) {
	if _, err := s.Chat(ctx, r.ChatID); err != nil {
		return backend.SendResult{}, err
	}
	if !s.Capabilities().Supports(r.Message.Kind) && !(r.Message.Kind == backend.Revoke && s.Capabilities().Revoke) {
		return backend.SendResult{}, backend.ErrUnsupported
	}
	if r.TransactionID == "" {
		return backend.SendResult{}, errors.New("transaction ID is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.faults["send"] != "" {
		delete(s.faults, "send")
		return backend.SendResult{}, backend.ErrDisconnected
	}
	key := r.ChatID + "\x00" + r.TransactionID
	if result, ok := s.sent[key]; ok {
		return result, nil
	}
	result := backend.SendResult{ID: "sent-" + r.TransactionID, Timestamp: time.Unix(1800000000, 0)}
	s.sent[key] = result
	return result, nil
}
func (s *Session) Next(ctx context.Context, cursor string) (backend.Event, error) {
	if err := s.check(ctx); err != nil {
		return backend.Event{}, err
	}
	s.mu.Lock()
	fault := s.faults[cursor]
	delete(s.faults, cursor)
	s.mu.Unlock()
	if fault == "disconnect" {
		return backend.Event{}, backend.ErrDisconnected
	}
	if fault == "unauthorized" {
		return backend.Event{}, backend.ErrUnauthorized
	}
	index := 0
	var err error
	if cursor != "" {
		index, err = strconv.Atoi(cursor)
	}
	if err != nil || index < 0 || index > len(s.fixture.Events) {
		return backend.Event{}, errors.New("invalid fixture cursor")
	}
	if index < len(s.fixture.Events) {
		return s.fixture.Events[index], nil
	}
	<-ctx.Done()
	return backend.Event{}, ctx.Err()
}
func (s *Session) OpenMedia(ctx context.Context, m backend.Media) (io.ReadCloser, error) {
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	data := m.Data
	if data == nil {
		var ok bool
		data, ok = s.fixture.Media[m.Ref]
		if !ok {
			return nil, errors.New("fixture media not found")
		}
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

var _ backend.Factory = (*Factory)(nil)
var _ backend.Session = (*Session)(nil)
