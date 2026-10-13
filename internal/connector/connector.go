package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend/fake"
	"go.mau.fi/util/configupgrade"
	"go.mau.fi/util/ptr"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
)

const exampleNetwork = `# The real hook adapter is not available yet.
backend: disabled
# Explicitly enable deterministic development fixtures:
# backend: fake
fake_fixtures: []
# Maximum incoming/outgoing attachment size in bytes.
max_media_size: 52428800
`

type Config struct {
	Backend      string   `yaml:"backend"`
	FakeFixtures []string `yaml:"fake_fixtures"`
	MaxMediaSize int64    `yaml:"max_media_size"`
}
type LoginMetadata struct {
	AccountID string `json:"account_id"`
	UserID    string `json:"user_id"`
	Backend   string `json:"backend"`
	Cursor    string `json:"cursor,omitempty"`
}
type Connector struct {
	Bridge      *bridgev2.Bridge
	Config      Config
	Factory     backend.Factory
	factoryName string
}

func New() *Connector { return &Connector{} }

// NewWithBackend installs a future hook adapter without changing Matrix code.
// Configure network.backend to the supplied name to explicitly enable it.
func NewWithBackend(name string, factory backend.Factory) *Connector {
	return &Connector{Factory: factory, factoryName: name}
}
func (c *Connector) Init(br *bridgev2.Bridge) { c.Bridge = br; c.registerCommands() }
func (c *Connector) Start(ctx context.Context) error {
	if c.Config.Backend == "disabled" {
		c.Bridge.SendGlobalBridgeState(status.BridgeState{StateEvent: status.StateUnconfigured, Message: backend.ErrUnavailable.Error()})
	}
	return nil
}
func (c *Connector) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{DisplayName: "WeChat", NetworkID: "wechat", BeeperBridgeType: "github.com/yamada-sexta/matrix-wechat", DefaultPort: 17778, DefaultCommandPrefix: "!wechat", NetworkURL: "https://www.wechat.com/"}
}
func (c *Connector) GetDBMetaTypes() database.MetaTypes {
	return database.MetaTypes{UserLogin: func() any { return &LoginMetadata{} }}
}
func (c *Connector) GetCapabilities() *bridgev2.NetworkGeneralCapabilities {
	return &bridgev2.NetworkGeneralCapabilities{}
}
func (c *Connector) GetConfig() (string, any, configupgrade.Upgrader) {
	return exampleNetwork, &c.Config, configupgrade.SimpleUpgrader(func(h configupgrade.Helper) {
		h.Copy(configupgrade.Str, "backend")
		h.Copy(configupgrade.List, "fake_fixtures")
		h.Copy(configupgrade.Int, "max_media_size")
	})
}
func (c *Connector) ValidateConfig() error {
	if c.Config.MaxMediaSize <= 0 {
		return errors.New("network.max_media_size must be positive")
	}
	if c.factoryName != "" && c.Config.Backend == c.factoryName && c.Factory != nil {
		return nil
	}
	switch c.Config.Backend {
	case "disabled":
		c.Factory = backend.Disabled{}
	case "fake":
		if len(c.Config.FakeFixtures) == 0 {
			return errors.New("network.fake_fixtures is required for the fake backend")
		}
		if c.Factory == nil {
			f, err := fake.Load(c.Config.FakeFixtures)
			if err != nil {
				return fmt.Errorf("load fake fixtures: %w", err)
			}
			c.Factory = f
		}
	default:
		return fmt.Errorf("unknown network.backend %q: the hook adapter has not been installed", c.Config.Backend)
	}
	return nil
}
func (c *Connector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	meta := login.Metadata.(*LoginMetadata)
	// Backend changes must never silently reinterpret persisted accounts.
	var session backend.Session
	var restoreErr error
	if meta.Backend != c.Config.Backend {
		restoreErr = errors.New("backend changed: log out and authenticate again")
	} else {
		session, restoreErr = c.Factory.Restore(ctx, meta.AccountID)
	}
	login.Client = &Client{connector: c, login: login, session: session, restoreErr: restoreErr}
	return nil
}
func (c *Connector) GetBridgeInfoVersion() (int, int) { return 1, 1 }
func (c *Connector) GetLoginFlows() []bridgev2.LoginFlow {
	return []bridgev2.LoginFlow{{ID: "wechat", Name: "WeChat", Description: "Connect an account through the configured WeChat backend."}}
}
func (c *Connector) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	if flowID != "wechat" {
		return nil, errors.New("unknown login flow")
	}
	return &Login{connector: c, user: user}, nil
}
func (c *Connector) SetMaxFileSize(size int64) { /* Limits are enforced by Matrix UploadMedia and network.max_media_size. */
}

func avatar(session backend.Session, m *backend.Media) *bridgev2.Avatar {
	if m == nil {
		return nil
	}
	ref := *m
	if ref.Ref == "" {
		hash := sha256.Sum256(ref.Data)
		ref.Ref = hex.EncodeToString(hash[:])
	}
	return &bridgev2.Avatar{ID: networkid.AvatarID(ref.Ref), Get: func(ctx context.Context) ([]byte, error) {
		reader, err := session.OpenMedia(ctx, ref)
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		data, err := io.ReadAll(io.LimitReader(reader, 8*1024*1024+1))
		if len(data) > 8*1024*1024 {
			return nil, errors.New("avatar exceeds 8 MiB")
		}
		return data, err
	}}
}
func userInfo(session backend.Session, p backend.Profile) *bridgev2.UserInfo {
	return &bridgev2.UserInfo{Name: ptr.Ptr(p.Name), Avatar: avatar(session, p.Avatar)}
}
func (c *Client) GetChatInfo(ctx context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	if c.session == nil {
		return nil, backend.ErrUnavailable
	}
	chat, err := c.session.Chat(ctx, string(portal.ID))
	if err != nil {
		return nil, err
	}
	members, err := c.session.Members(ctx, chat.ID)
	if err != nil {
		return nil, err
	}
	memberMap := make(bridgev2.ChatMemberMap)
	for _, m := range members {
		self := m.Profile.ID == c.login.Metadata.(*LoginMetadata).UserID
		memberMap[networkid.UserID(m.Profile.ID)] = bridgev2.ChatMember{EventSender: bridgev2.EventSender{Sender: networkid.UserID(m.Profile.ID), IsFromMe: self}, Membership: event.MembershipJoin, Nickname: ptr.Ptr(m.Nickname), UserInfo: userInfo(c.session, m.Profile)}
	}
	roomType := database.RoomTypeDefault
	if !chat.Group {
		roomType = database.RoomTypeDM
	}
	return &bridgev2.ChatInfo{Name: ptr.Ptr(chat.Name), Topic: ptr.Ptr(chat.Topic), Avatar: avatar(c.session, chat.Avatar), Type: &roomType, Members: &bridgev2.ChatMemberList{IsFull: true, MemberMap: memberMap, OtherUserID: networkid.UserID(chat.PeerID)}}, nil
}
func (c *Client) GetUserInfo(ctx context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	if c.session == nil {
		return nil, backend.ErrUnavailable
	}
	p, err := c.session.User(ctx, string(ghost.ID))
	if err != nil {
		return nil, err
	}
	return userInfo(c.session, p), nil
}
func (c *Client) GetCapabilities(ctx context.Context, portal *bridgev2.Portal) *event.RoomFeatures {
	caps := backend.Capabilities{}
	if c.session != nil {
		caps = c.session.Capabilities()
	}
	return roomFeatures(caps)
}
func roomFeatures(caps backend.Capabilities) *event.RoomFeatures {
	f := &event.RoomFeatures{File: make(event.FileFeatureMap), Reply: event.CapLevelRejected, Edit: event.CapLevelRejected, Delete: event.CapLevelRejected, Reaction: event.CapLevelRejected, LocationMessage: event.CapLevelRejected}
	for _, kind := range []backend.Kind{backend.Image, backend.Sticker, backend.Video, backend.Audio, backend.File} {
		typ := matrixType(kind)
		if kind == backend.Sticker {
			typ = event.CapMsgSticker
		}
		level := event.CapLevelRejected
		if caps.Supports(kind) {
			level = event.CapLevelFullySupported
		}
		f.File[typ] = &event.FileFeatures{MimeTypes: map[string]event.CapabilitySupportLevel{"*/*": level}}
	}
	if caps.Replies {
		f.Reply = event.CapLevelFullySupported
	}
	if caps.Revoke {
		f.Delete = event.CapLevelFullySupported
	}
	if caps.Supports(backend.LocationMessage) {
		f.LocationMessage = event.CapLevelFullySupported
	}
	if caps.Mentions {
		f.Formatting = event.FormattingFeatureMap{event.FmtUserLink: event.CapLevelFullySupported, event.FmtAtRoomMention: event.CapLevelFullySupported}
	}
	return f
}
func (c *Client) GetUserID() networkid.UserID {
	return networkid.UserID(c.login.Metadata.(*LoginMetadata).UserID)
}
func (c *Client) IsThisUser(ctx context.Context, id networkid.UserID) bool {
	return id == c.GetUserID()
}
func (c *Client) LogoutRemote(ctx context.Context) {
	c.Disconnect()
	if c.session != nil {
		_ = c.session.Logout(ctx)
	}
}

var _ bridgev2.NetworkConnector = (*Connector)(nil)
var _ bridgev2.ConfigValidatingNetwork = (*Connector)(nil)
var _ bridgev2.NetworkAPI = (*Client)(nil)
