#!/bin/sh
set -eu
build_tag=${BUILD_TAG:-$(git describe --exact-match --tags 2>/dev/null || printf unknown)}
build_commit=${BUILD_COMMIT:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}
build_time=${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
CGO_ENABLED=1 go build -tags goolm -trimpath -ldflags "-s -w -X main.Tag=$build_tag -X main.Commit=$build_commit -X main.BuildTime=$build_time" "$@" ./cmd/matrix-wechat
