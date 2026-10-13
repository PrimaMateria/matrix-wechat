package connector

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"
	"maunium.net/go/mautrix/bridgev2/database"
)

func testDatabase(t *testing.T) *dbutil.Database {
	t.Helper()
	db, err := dbutil.NewFromConfig("megabridge/matrix-wechat", dbutil.Config{Type: "sqlite3-fk-wal", URI: "file:" + filepath.Join(t.TempDir(), "test.db") + "?_txlock=immediate", MaxOpenConns: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
func TestDatabaseInitializationAndLegacyGuard(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	if err := CheckLegacyDatabase(ctx, db); err != nil {
		t.Fatal(err)
	}
	bridgeDB := database.New("", (&Connector{}).GetDBMetaTypes(), db)
	if err := bridgeDB.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if err := CheckLegacyDatabase(ctx, db); err != nil {
		t.Fatal(err)
	}
	db = testDatabase(t)
	if _, err := db.Exec(ctx, "CREATE TABLE puppet (uin TEXT); INSERT INTO puppet VALUES ('preserve')"); err != nil {
		t.Fatal(err)
	}
	if err := CheckLegacyDatabase(ctx, db); !errors.Is(err, ErrLegacyState) {
		t.Fatal(err)
	}
	var value string
	if err := db.QueryRow(ctx, "SELECT uin FROM puppet").Scan(&value); err != nil || value != "preserve" {
		t.Fatal("legacy data changed", value, err)
	}
}
func TestLegacyConfigGuardDoesNotRewrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	data := []byte("appservice:\n  database:\n    uri: file:old.db\n")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"-c", path}, {"--config=" + path}} {
		if err := CheckLegacyConfig(args); !errors.Is(err, ErrLegacyState) {
			t.Fatal(err)
		}
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(data) {
		t.Fatal("legacy config rewritten")
	}
	if err := os.WriteFile(path, []byte("network:\n  backend: disabled\ndatabase:\n  uri: file:new.db\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CheckLegacyConfig([]string{"-c", path}); err != nil {
		t.Fatal(err)
	}
}
