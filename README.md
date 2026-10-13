# Matrix–WeChat

A Bun/TypeScript Matrix appservice bridge using `matrix-appservice-bridge` and the existing instrumented WeChat Linux 4.1.13 runtime. The executable starts the actual pinned WeChat client, its web UI, and the Matrix appservice in one container.

One deployment bridges one saved WeChat account for one configured Matrix owner. Conversation and message mappings, contact ghosts, history cursors, incoming work, and pending sends are stored with Bun's native `bun:sqlite` connector. Database writes use WAL. Existing account files remain under `data/wechat`; bridge state lives under `data/bridge`.

## Configure and start

```sh
mkdir -p data/bridge
cp example-config.yaml data/bridge/config.yaml
# Edit homeserver.address/domain, appservice.address, and bridge.owner.
docker compose build
docker compose run --rm bridge -g
```

Register `data/bridge/registration.yaml` in your homeserver's appservice configuration and restart the homeserver. The `appservice.address` must be reachable from the homeserver; `homeserver.address` must be reachable from the bridge. Put both containers on a shared Docker network when using container names in these URLs.

```sh
docker compose up -d
```

Both ports are exposed by the image and published on localhost by Compose:

| Port | Service |
| --- | --- |
| `18742` | WeChat web UI: http://127.0.0.1:18742/ |
| `17778` | Matrix appservice, authenticated using registration tokens |

The bridge invites the configured owner to a management room. Native saved-account login is resumed automatically; WeChat may require approval on the phone. With no saved login, the web UI and management room show the client's QR code. The existing host-side ADB watcher can approve the desktop-login prompt:

```sh
bun packages/wechat-runtime/scripts/adb-login.ts --watch
```

Both Dockerfiles download the original validated AppImage from the [pinned client release](https://github.com/yamada-sexta/matrix-wechat/releases/tag/wechat-client-4.1.13-4526180b), with three bounded attempts. The AppImage hash comes from the native ABI profile; its hash and the extracted executable hash are checked during build and startup. To use another mirror of the same artifact, set the `WECHAT_APPIMAGE_URL` build argument; the hash pin still applies. The client installation is read-only; persistent account data is writable. The client is Linux amd64. Matrix rooms are unencrypted; enabling encryption stops bridging for that room and produces an explicit notice.

## Bridged behavior

After login, the bridge creates private Matrix rooms for every visible WeChat conversation and imports the full locally cached history oldest first, in resumable pages. New conversation activity also creates rooms. Import and live reconciliation share persistent message mappings; local message IDs that gain server IDs keep their original Matrix event.

Incoming support covers text, replies, mentions, images, stickers/animated GIFs, cached MP4 video, voice decoded to WAV, files, locations, safe shared links, and system notices/tickles. Cached contact/group avatars, names, announcements, and roster snapshots are mirrored. Media bytes come from the existing verified native decoding/resolution paths. Missing cached attachments produce a readable placeholder and are retried. Explicit revocation records redact the corresponding Matrix event; disappearance from storage does not imply revocation.

Outgoing support covers text, text replies referencing existing messages, JPEG/PNG/GIF images, files, and MP4 through the existing file-upload route. Native callback success means queue acknowledgement. The bridge waits for a matching source record with a nonzero server ID, maps that record to the original Matrix event, and suppresses its echo. Ambiguous or interrupted sends are reported as uncertain and are never automatically resubmitted.

Sticker sending remains excluded. Voice/location sending, native mention construction, native revocation, group/profile mutations, presence, and uncached-media download initiation are unavailable. Outgoing text retains literal mention text but does not construct native mention notifications. Leaving a Matrix room does not leave the WeChat group. Native group sends and sustained global reception still require separate live acceptance; implemented parsing is not proof of runtime verification.

## Commands

Commands are accepted only from `bridge.owner`. Send these in the management room, or prefix them with `!wechat` in a portal:

- `help`, `status`, `capabilities`
- `login saved`, `login qr`
- `list contacts`, `list groups`
- `start-chat <cached WeChat contact or conversation ID>`
- `sync`

CLI options include `-c <config>`, `-r <registration>`, `-g` (generate registration), `-e` (write example configuration), `--check-config`, and `--version`. Configuration and registration generation refuse to overwrite existing files. Use a fresh bridge database; the former Go bridge configuration/database is not migrated.

## Development and live validation

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run test
bun run build
podman build -t localhost/matrix-wechat:dev .
```

`bun run test:matrix` is a live acceptance run, requiring the existing `wechatlinux-demo` container to be logged in with the actual saved account and File Transfer available. It uses an isolated, pinned Synapse server, imports real native conversation history, compares uploaded media against native bytes, checks both exposed ports, restarts the bridge to verify exact mapping preservation, and verifies text, quoted replies, images, files, and MP4 delivery to File Transfer. Outbound media uses actual cached account bytes and verifies the delivered native checksum. It also verifies owner-only sending and encrypted-room rejection through real Synapse events. Set `BRIDGE_IMAGE` or `WECHATLINUX_CONTAINER` to override the image/container names. The default container engine is rootless Podman.

The acceptance run temporarily stops the standalone WeChat container so only one client owns the account directory, then restores it. Login approval may be required after each restart. Private logs, Matrix databases, and proof summaries are saved under ignored `data/matrix-acceptance/`; personal history never becomes a checked-in test fixture. CI runs static checks and the existing storage/media tests during container build, plus CLI/port smoke checks; the real-account acceptance run is opt-in.

Source is AGPL-3.0.
