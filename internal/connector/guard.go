package connector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"go.mau.fi/util/dbutil"
	"gopkg.in/yaml.v3"
)

var ErrLegacyState = errors.New("legacy bridge state is not supported; back it up and use a fresh bridgev2 config and database (see docs/upgrading.md)")
var ErrDatabaseType = errors.New("only SQLite is supported: set database.type to sqlite3-fk-wal")

func CheckDatabaseConfig(config dbutil.Config) error {
	if config.Type != "sqlite3-fk-wal" {
		return ErrDatabaseType
	}
	return nil
}

// WriteExampleConfig uses the shipped defaults instead of upstream PostgreSQL
// defaults. It refuses to overwrite any existing config, like mxmain's -e flag.
func WriteExampleConfig(args []string, example string) (bool, error) {
	generate, path := false, "config.yaml"
	for i, arg := range args {
		switch {
		case arg == "-e" || arg == "--generate-example-config":
			generate = true
		case arg == "-c" || arg == "--config":
			if i+1 < len(args) {
				path = args[i+1]
			}
		case strings.HasPrefix(arg, "--config="):
			path = strings.TrimPrefix(arg, "--config=")
		case strings.HasPrefix(arg, "-c="):
			path = strings.TrimPrefix(arg, "-c=")
		}
	}
	if !generate {
		return false, nil
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return true, fmt.Errorf("write example config: %w", err)
	}
	_, err = file.WriteString(example)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	return true, err
}

// CheckLegacyConfig runs before mxmain's config upgrader can rewrite old files.
func CheckLegacyConfig(args []string) error {
	path := "config.yaml"
	for i, arg := range args {
		switch {
		case arg == "-e" || arg == "--generate-example-config" || arg == "-h" || arg == "--help" || arg == "-v" || arg == "--version" || arg == "--version-json":
			return nil
		case arg == "-c" || arg == "--config":
			if i+1 < len(args) {
				path = args[i+1]
			}
		case strings.HasPrefix(arg, "--config="):
			path = strings.TrimPrefix(arg, "--config=")
		}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var raw struct {
		Appservice map[string]any `yaml:"appservice"`
	}
	if err = yaml.Unmarshal(data, &raw); err != nil {
		return err
	}
	if _, legacy := raw.Appservice["database"]; legacy {
		return ErrLegacyState
	}
	return nil
}

// CheckLegacyDatabase only reads schema, before the framework runs upgrades.
func CheckLegacyDatabase(ctx context.Context, db *dbutil.Database) error {
	exists, err := db.TableExists(ctx, "puppet")
	if err != nil {
		return err
	}
	if exists {
		return ErrLegacyState
	}
	exists, err = db.TableExists(ctx, "database_owner")
	if err != nil {
		return err
	}
	if exists {
		var owner string
		err = db.QueryRow(ctx, "SELECT owner FROM database_owner LIMIT 1").Scan(&owner)
		if err != nil {
			return fmt.Errorf("read database owner: %w", err)
		}
		if owner == "matrix-wechat" {
			return ErrLegacyState
		}
	}
	return nil
}
