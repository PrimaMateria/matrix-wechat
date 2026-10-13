package wechatlinux

import "context"

func (c *Client) Status(ctx context.Context) (Status, error) {
	var out Status
	err := c.Call(ctx, "status", nil, &out)
	return out, err
}
func (c *Client) Capabilities(ctx context.Context) (Capabilities, error) {
	var out Capabilities
	err := c.Call(ctx, "capabilities", nil, &out)
	return out, err
}
func (c *Client) Login(ctx context.Context, req LoginRequest) (LoginResult, error) {
	var out LoginResult
	err := c.Call(ctx, "login", req, &out)
	return out, err
}
func (c *Client) InspectDB(ctx context.Context) (DatabaseInspection, error) {
	var out DatabaseInspection
	err := c.Call(ctx, "inspect_db", nil, &out)
	return out, err
}
func (c *Client) Contacts(ctx context.Context) (Contacts, error) {
	var out Contacts
	err := c.Call(ctx, "contacts", nil, &out)
	return out, err
}
func (c *Client) Groups(ctx context.Context) (Groups, error) {
	var out Groups
	err := c.Call(ctx, "groups", nil, &out)
	return out, err
}
func (c *Client) History(ctx context.Context, req HistoryRequest) (HistoryResult, error) {
	var out HistoryResult
	err := c.Call(ctx, "history", req, &out)
	return out, err
}
func (c *Client) Media(ctx context.Context, req MediaRequest) (Media, error) {
	var out Media
	err := c.Call(ctx, "media", req, &out)
	return out, err
}
func (c *Client) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	var out SendResult
	err := c.Call(ctx, "send", req, &out)
	return out, err
}
func (c *Client) ChatAction(ctx context.Context, req ChatActionRequest) (ActionResult, error) {
	var out ActionResult
	err := c.Call(ctx, "chat_action", req, &out)
	return out, err
}
func (c *Client) ProfileAction(ctx context.Context, req ProfileActionRequest) (ActionResult, error) {
	var out ActionResult
	err := c.Call(ctx, "profile_action", req, &out)
	return out, err
}
