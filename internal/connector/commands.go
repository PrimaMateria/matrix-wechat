package connector

import (
	"context"
	"errors"
	"fmt"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/commands"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"sort"
	"strings"
	"time"
)

func commandClient(ce *commands.Event) (*Client, error) {
	login := ce.User.GetDefaultLogin()
	if login == nil {
		return nil, errors.New("log in first")
	}
	c, ok := login.Client.(*Client)
	if !ok || !c.IsLoggedIn() {
		return nil, backend.ErrDisconnected
	}
	return c, nil
}
func (c *Connector) registerCommands() {
	processor, ok := c.Bridge.Commands.(*commands.Processor)
	if !ok {
		return
	}
	processor.AddHandlers(
		&commands.FullHandler{Name: "ping", Help: commands.HelpMeta{Section: commands.HelpSectionGeneral, Description: "Check the configured WeChat backend."}, Func: func(ce *commands.Event) {
			client, err := commandClient(ce)
			if err != nil {
				ce.Reply("Backend: %s. %s", c.Config.Backend, err)
				return
			}
			account, err := client.session.Self(ce.Ctx)
			if err != nil {
				ce.Reply("Backend unavailable: %s", err)
				return
			}
			ce.Reply("Backend: %s. Connected as %s.", c.Config.Backend, account.Profile.Name)
		}},
		&commands.FullHandler{Name: "list", RequiresLogin: true, Help: commands.HelpMeta{Section: commands.HelpSectionChats, Args: "<contacts|groups>", Description: "List contacts or group chats."}, Func: func(ce *commands.Event) {
			client, err := commandClient(ce)
			if err != nil {
				ce.Reply("%s", err)
				return
			}
			what := "contacts"
			if len(ce.Args) > 0 {
				what = ce.Args[0]
			}
			var lines []string
			switch what {
			case "contacts":
				contacts, err := client.session.Contacts(ce.Ctx)
				if err != nil {
					ce.Reply("%s", err)
					return
				}
				for _, p := range contacts {
					lines = append(lines, fmt.Sprintf("%s (%s)", p.Name, p.ID))
				}
			case "groups":
				chats, err := client.session.Chats(ce.Ctx)
				if err != nil {
					ce.Reply("%s", err)
					return
				}
				for _, p := range chats {
					if p.Group {
						lines = append(lines, fmt.Sprintf("%s (%s)", p.Name, p.ID))
					}
				}
			default:
				ce.Reply("Usage: list <contacts|groups>")
				return
			}
			sort.Strings(lines)
			if len(lines) == 0 {
				ce.Reply("No matching entries.")
				return
			}
			ce.ReplyAdvanced(strings.Join(lines, "\n"), false, false)
		}},
		&commands.FullHandler{Name: "sync", RequiresLogin: true, Help: commands.HelpMeta{Section: commands.HelpSectionChats, Args: "<contacts|groups|space> [--create-portals]", Description: "Refresh contacts and chats from the backend."}, Func: func(ce *commands.Event) {
			client, err := commandClient(ce)
			if err != nil {
				ce.Reply("%s", err)
				return
			}
			if len(ce.Args) == 0 {
				ce.Reply("Usage: sync <contacts|groups|space> [--create-portals]")
				return
			}
			switch ce.Args[0] {
			case "contacts":
				profiles, err := client.session.Contacts(ce.Ctx)
				if err != nil {
					ce.Reply("%s", err)
					return
				}
				for _, p := range profiles {
					ghost, err := c.Bridge.GetGhostByID(ce.Ctx, networkid.UserID(p.ID))
					if err != nil {
						ce.Reply("%s", err)
						return
					}
					ghost.UpdateInfo(ce.Ctx, userInfo(client.session, p))
				}
				ce.Reply("Refreshed %d contacts.", len(profiles))
			case "groups", "space":
				chats, err := client.session.Chats(ce.Ctx)
				if err != nil {
					ce.Reply("%s", err)
					return
				}
				count := 0
				for _, chat := range chats {
					if ce.Args[0] == "groups" && !chat.Group {
						continue
					}
					portal, err := c.Bridge.GetPortalByKey(ce.Ctx, client.portalKey(chat.ID))
					if err != nil {
						ce.Reply("%s", err)
						return
					}
					info, err := client.GetChatInfo(ce.Ctx, portal)
					if err != nil {
						ce.Reply("%s", err)
						return
					}
					if portal.MXID == "" && strings.Contains(ce.RawArgs, "--create-portals") {
						err = portal.CreateMatrixRoom(ce.Ctx, client.login, info)
					} else if portal.MXID != "" {
						portal.UpdateInfo(ce.Ctx, info, client.login, nil, time.Time{})
					}
					if err != nil {
						ce.Reply("%s", err)
						return
					}
					count++
				}
				ce.Reply("Refreshed %d chats. Personal spaces are managed by bridgev2.", count)
			default:
				ce.Reply("Usage: sync <contacts|groups|space> [--create-portals]")
			}
		}},
	)
}
func (c *Client) GetContactList(ctx context.Context) ([]*bridgev2.ResolveIdentifierResponse, error) {
	profiles, err := c.session.Contacts(ctx)
	if err != nil {
		return nil, err
	}
	results := make([]*bridgev2.ResolveIdentifierResponse, 0, len(profiles))
	for _, p := range profiles {
		results = append(results, &bridgev2.ResolveIdentifierResponse{UserID: networkid.UserID(p.ID), UserInfo: userInfo(c.session, p)})
	}
	return results, nil
}
func (c *Client) SearchUsers(ctx context.Context, query string) ([]*bridgev2.ResolveIdentifierResponse, error) {
	results, err := c.GetContactList(ctx)
	if err != nil {
		return nil, err
	}
	var found []*bridgev2.ResolveIdentifierResponse
	for _, p := range results {
		if strings.Contains(strings.ToLower(string(p.UserID)+" "+*p.UserInfo.Name), strings.ToLower(query)) {
			found = append(found, p)
		}
	}
	return found, nil
}
func (c *Client) ResolveIdentifier(ctx context.Context, identifier string, createChat bool) (*bridgev2.ResolveIdentifierResponse, error) {
	profile, err := c.session.User(ctx, identifier)
	if err != nil {
		return nil, err
	}
	result := &bridgev2.ResolveIdentifierResponse{UserID: networkid.UserID(profile.ID), UserInfo: userInfo(c.session, profile)}
	if createChat {
		chats, err := c.session.Chats(ctx)
		if err != nil {
			return nil, err
		}
		for _, chat := range chats {
			if !chat.Group && chat.PeerID == profile.ID {
				portal, err := c.connector.Bridge.GetPortalByKey(ctx, c.portalKey(chat.ID))
				if err != nil {
					return nil, err
				}
				info, err := c.GetChatInfo(ctx, portal)
				if err != nil {
					return nil, err
				}
				result.Chat = &bridgev2.CreateChatResponse{PortalKey: c.portalKey(chat.ID), PortalInfo: info}
				return result, nil
			}
		}
		return nil, fmt.Errorf("no existing direct chat for %s; the hook must expose it first", identifier)
	}
	return result, nil
}

var _ bridgev2.ContactListingNetworkAPI = (*Client)(nil)
var _ bridgev2.UserSearchingNetworkAPI = (*Client)(nil)
var _ bridgev2.IdentifierResolvingNetworkAPI = (*Client)(nil)
