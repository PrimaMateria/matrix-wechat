// Package matrixwechat contains the default SQLite-only bridge configuration.
package matrixwechat

import _ "embed"

//go:embed example-config.yaml
var ExampleConfig string
