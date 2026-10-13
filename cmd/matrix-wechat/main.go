package main

import (
	"context"
	"fmt"
	matrixwechat "github.com/yamada-sexta/matrix-wechat"
	"github.com/yamada-sexta/matrix-wechat/internal/connector"
	_ "go.mau.fi/util/dbutil/litestream"
	"maunium.net/go/mautrix/bridgev2/matrix/mxmain"
	_ "maunium.net/go/mautrix/crypto/goolm"
	"os"
)

var Tag, Commit, BuildTime = "unknown", "unknown", "unknown"

func main() {
	if handled, err := connector.WriteExampleConfig(os.Args[1:], matrixwechat.ExampleConfig); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("Wrote SQLite example config")
		return
	}
	if err := connector.CheckLegacyConfig(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	br := &mxmain.BridgeMain{Name: "matrix-wechat", URL: "https://github.com/yamada-sexta/matrix-wechat", Description: "A Matrix-WeChat puppeting bridge.", Version: "0.3.0", Connector: connector.New()}
	br.PostInit = func() {
		if err := connector.CheckLegacyDatabase(context.Background(), br.DB); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	br.InitVersion(Tag, Commit, BuildTime)
	br.PreInit()
	if err := connector.CheckDatabaseConfig(br.Config.Database); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	br.Init()
	br.Start()
	exitCode := br.WaitForInterrupt()
	br.Stop()
	os.Exit(exitCode)
}
