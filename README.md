# matrix-wechat

A Go Matrix–WeChat bridge built on **mautrix bridgev2**.

The Matrix side has been migrated to mautrix v0.31.0. The new WeChat hook is being developed separately. The default backend is **disabled**; the included fake backend exercises the bridge without contacting WeChat.

## Build and test

Requires Go 1.27.2, a C compiler (SQLite and SILK), and FFmpeg for incoming SILK audio. Matrix encryption uses pure-Go Olm; libolm is not required.

```sh
./build.sh -o build/matrix-wechat
go test -tags goolm -race ./...
go vet -tags goolm ./...
```

For live acceptance tests against an isolated Synapse container:

```sh
python3 scripts/matrix-smoke.py build/matrix-wechat
```

The acceptance test checks encrypted direct/group rooms, shared articles and replies, authenticated encrypted media, outbound messages, double puppeting, and restart deduplication. It removes its disposable server afterwards.

## Configure

Copy `example-config.yaml` to `config.yaml`. Set the homeserver address/domain, appservice address, and `bridge.permissions`. The shipped example uses a fresh `matrix-wechat-v2.db`. SQLite is the only supported database.

```sh
build/matrix-wechat -g -c config.yaml -r registration.yaml
# Register registration.yaml with your homeserver and restart it.
build/matrix-wechat -c config.yaml -r registration.yaml
```

For Docker, set `appservice.hostname: 0.0.0.0` and an address reachable from the homeserver. See [compose.yaml](compose.yaml). First startup copies the example; the next startup generates registration once configuration is complete.

## Development fixtures

Explicitly select the fake backend:

```yaml
network:
    backend: fake
    fake_fixtures:
        - fixtures/demo.json
    max_media_size: 52428800
```

Invite `@wechatbot:your-domain` to a private room. Send `login`, then `demo` when prompted for the account reference. The fixture produces a DM and group with text, a shared article, a reply, a file, and a location. Connection notices identify it as a development fixture.

The bridge converts incoming text, images, stickers, video, audio, files, locations, shared cards, replies, mentions, and revocations. Cards preserve title, description, publisher/source, URL, and optional thumbnail, with plain-text fallback and safe HTML. Outgoing support is advertised from backend capabilities. HTML links and bundled Matrix link previews are preserved for the hook.

Useful commands: `help`, `login`, `logout`, `ping`, `list contacts`, `list groups`, `search`, `start-chat`, `sync contacts`, `sync groups --create-portals`, `delete-portal`, and `login-matrix`. Outside the management room, prefix commands with `!wechat`.

## Hook integration and layout

- `cmd/matrix-wechat`: executable and build metadata.
- `internal/connector`: bridgev2 integration and message conversion.
- `pkg/backend`: transport-independent Go contract for the new hook.
- `pkg/backend/fake` and `fixtures`: deterministic development backend.
- `integration`, `scripts`, and `.github`: acceptance tests and release tooling.

[Backend contract](docs/backend.md) · [Upgrade and rollback](docs/upgrading.md)

CI publishes amd64/arm64 images to `ghcr.io/yamada-sexta/matrix-wechat`: `master` and commit tags for rolling builds, version tags and `latest` for stable releases. Prereleases do not change `latest`. Version tags also produce Linux binary assets and checksums.

The source remains AGPL-3.0. WeChat client packaging, Wine, Android, and the reverse-engineered hook are outside this migration.
