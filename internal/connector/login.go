package connector

import (
	"context"
	"errors"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"sync"
)

type Login struct {
	connector *Connector
	user      *bridgev2.User
	mu        sync.Mutex
	auth      backend.Authentication
	canceled  bool
}

func (l *Login) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	if l.connector.Config.Backend == "disabled" {
		return nil, backend.ErrUnavailable
	}
	return &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeUserInput, StepID: "wechat.account", Instructions: "Enter the account reference understood by your WeChat backend (fixture account ID in development).", UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{{ID: "account", Type: bridgev2.LoginInputFieldTypeUsername, Name: "Account reference"}}}}, nil
}
func (l *Login) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	if input["account"] == "" {
		return nil, errors.New("account reference is required")
	}
	auth, err := l.connector.Factory.StartLogin(ctx, input["account"])
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	if l.canceled {
		l.mu.Unlock()
		auth.Cancel()
		return nil, context.Canceled
	}
	l.auth = auth
	l.mu.Unlock()
	challenge := auth.Challenge()
	typ := bridgev2.LoginDisplayTypeNothing
	if challenge.QR != "" {
		typ = bridgev2.LoginDisplayTypeQR
	}
	imageURL := ""
	if len(challenge.Image) > 0 {
		uri, _, err := l.connector.Bridge.Bot.UploadMedia(ctx, "", challenge.Image, "wechat-login.png", "image/png")
		if err != nil {
			l.Cancel()
			return nil, err
		}
		imageURL = string(uri)
		typ = bridgev2.LoginDisplayTypeQR
	}
	return &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeDisplayAndWait, StepID: "wechat.authenticate", Instructions: challenge.Instructions, DisplayAndWaitParams: &bridgev2.LoginDisplayAndWaitParams{Type: typ, Data: challenge.QR, ImageURL: imageURL}}, nil
}
func (l *Login) Wait(ctx context.Context) (*bridgev2.LoginStep, error) {
	l.mu.Lock()
	auth := l.auth
	canceled := l.canceled
	l.mu.Unlock()
	if canceled {
		return nil, context.Canceled
	}
	if auth == nil {
		return nil, errors.New("login has not started")
	}
	session, err := auth.Wait(ctx)
	if err != nil {
		return nil, err
	}
	if err = session.Connect(ctx); err != nil {
		return nil, err
	}
	account, err := session.Self(ctx)
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	if account.ID == "" || account.Profile.ID == "" {
		_ = session.Close()
		return nil, errors.New("backend returned an empty account or user ID")
	}
	l.mu.Lock()
	canceled = l.canceled
	l.mu.Unlock()
	if canceled {
		_ = session.Close()
		return nil, context.Canceled
	}
	login, err := l.user.NewLogin(ctx, &database.UserLogin{ID: networkid.UserLoginID(account.ID), RemoteName: account.Profile.Name, Metadata: &LoginMetadata{AccountID: account.ID, UserID: account.Profile.ID, Backend: l.connector.Config.Backend}}, &bridgev2.NewLoginParams{LoadUserLogin: func(ctx context.Context, login *bridgev2.UserLogin) error {
		login.Client = &Client{connector: l.connector, login: login, session: session}
		return nil
	}})
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	login.Client.Connect(l.connector.Bridge.BackgroundCtx)
	return &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeComplete, StepID: "wechat.complete", Instructions: "Account connected.", CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: login.ID, UserLogin: login}}, nil
}
func (l *Login) Cancel() {
	l.mu.Lock()
	l.canceled = true
	auth := l.auth
	l.mu.Unlock()
	if auth != nil {
		auth.Cancel()
	}
}

var _ bridgev2.LoginProcessUserInput = (*Login)(nil)
var _ bridgev2.LoginProcessDisplayAndWait = (*Login)(nil)
