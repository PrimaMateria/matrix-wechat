# Matrix–WeChat

A Bun/TypeScript Matrix bridge using `matrix-appservice-bridge` and the existing pinned WeChat Linux runtime. The bridge follows whichever WeChat account is currently logged into the runtime, for one configured Matrix owner.

The services run in **two separate containers**:

| Package | Responsibility | Dockerfile | Ports |
| --- | --- | --- | --- |
| `packages/wechat-runtime` | Runs WeChat, owns account files, exposes its authenticated API and optional React web UI | `packages/wechat-runtime/Dockerfile` | `18742` web UI, `18743` internal API |
| `packages/matrix-bridge` | Matrix appservice, room mappings, history cursors, and send tracking | `packages/matrix-bridge/Dockerfile` | `17778` appservice |
| `packages/wechat-rpc` | Shared tRPC contract, types, and client; no container | — | — |

The bridge calls the runtime over HTTP. It does not launch WeChat, access account files, or import native runtime code. Bridge state is stored with `bun:sqlite` under `data/bridge`; WeChat account state stays under `data/wechat`. The web UI belongs to the runtime container.

## Configure and start

```sh
mkdir -p data/bridge
cp example-config.yaml data/bridge/config.yaml
# Create a shared API secret once. This refuses to overwrite an existing .env.
bun -e 'import {writeFileSync} from "node:fs"; writeFileSync(".env", "WECHAT_API_TOKEN=" + crypto.randomUUID() + "\n", {flag:"wx", mode:0o600})'
```

Edit `data/bridge/config.yaml`: set `homeserver.address`, `homeserver.domain`, `appservice.address`, and `bridge.owner`. `wechat.address` defaults to `http://wechat-runtime:18743` on the Compose network. Both services receive the same `WECHAT_API_TOKEN` from `.env`; the token is separate from Matrix registration tokens.

```sh
docker compose build
docker compose run --rm --no-deps bridge -g
```

Register `data/bridge/registration.yaml` with your homeserver and restart it. `appservice.address` must be reachable from the homeserver; `homeserver.address` must be reachable from the bridge. Join the homeserver to the Compose network when these URLs use container names.

```sh
docker compose up -d
```

Open http://127.0.0.1:18742/ for WeChat login and chat inspection. Compose publishes the web UI and appservice on localhost; API port `18743` stays on the container network. To disable the web UI, put `WECHAT_WEB_UI=false` in `.env` and recreate the runtime container. The default is enabled. Disabling the UI does not disable the authenticated API or Matrix login commands.

The bridge invites its configured owner to a management room. Saved-account login resumes automatically; WeChat may require approval on the phone. With no saved account, the web UI and management room show the native QR code. The optional host-side ADB watcher can approve the desktop-login prompt:

```sh
bun packages/wechat-runtime/scripts/adb-login.ts --watch
```

The watcher uses the local web API and requires the web UI listener to be enabled. See [runtime documentation](packages/wechat-runtime/README.md) for standalone use and the pinned client build.

## Bridged behavior

After login, the bridge creates private Matrix rooms for visible WeChat conversations and imports the full locally cached history oldest first, in resumable pages. It polls normalized history through tRPC and reconciles recent updates and revocations. Persistent cursors and mappings survive either service restarting. Restarting the bridge leaves the WeChat client and web UI running.

Incoming messages include text, replies, mentions, images, stickers/GIFs, cached MP4 video, voice decoded to WAV, files, locations, system notices, shared links, and WeChat Channels cards. Article cards include a compact thumbnail beside their title and description; Channels retain a video cover and show video only when the existing runtime can provide playable bytes. Cached names, avatars, group announcements, and rosters are mirrored.

Transfers and red packets are **read only**: Matrix receives a formatted card with the available amount, memo or greeting, and a read-only label. The bridge cannot collect a transfer or open a red packet. Card layouts use [Matrix-supported HTML](https://spec.matrix.org/v1.19/client-server-api/#mroommessage-msgtypes), with plain-text fallbacks and link-preview metadata for clients that support it; appearance varies by Matrix client.

Missing cached media produces a readable placeholder and is retried. Explicit revocations redact the corresponding Matrix event; disappearance from storage does not imply revocation.

Outgoing support covers text, text replies, JPEG/PNG/GIF images, files, and MP4 through the existing file-upload route. Native acknowledgement is not delivery confirmation: the bridge waits for a matching source record with a server ID and suppresses its echo. Ambiguous or interrupted sends are reported as uncertain and are never automatically resubmitted, including when an API connection fails during a send.

Sticker/voice/location sending, native mention construction, native revocation, group/profile mutations, presence, encrypted Matrix rooms, and uncached-media download initiation are unsupported. Unplayable Channels video remains a cover card. Leaving a Matrix room does not leave its WeChat group. No additional native capabilities are implemented here.

## Commands

Only `bridge.owner` can issue commands. Send them in the management room, or prefix them with `!wechat` in a portal:

- `help`, `status`, `capabilities`
- `login saved`, `login qr`
- `list contacts`, `list groups`
- `start-chat <cached contact or conversation ID>`
- `sync`

CLI options: `-c <config>`, `-r <registration>`, `-g` (generate registration), `-e` (write example configuration), `--check-config`, and `--version`. Generation refuses to overwrite existing files. The former Go configuration/database is not migrated.

## Development and images

Run dependency installation from the repository root; all three packages share its Bun lockfile.

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run test
bun run build
podman build -f packages/matrix-bridge/Dockerfile -t localhost/matrix-wechat:dev .
podman build -f packages/wechat-runtime/Dockerfile -t localhost/wechatlinux-demo:dev .
```

Both Dockerfiles use the repository root as their build context. CI builds and publishes separate `ghcr.io/yamada-sexta/matrix-wechat` and `ghcr.io/yamada-sexta/matrix-wechat-runtime` images. Only the runtime image contains the pinned amd64 WeChat client, Frida, and GUI dependencies; the bridge needs no native-client capabilities or WeChat data volume.

`bun run test:matrix` runs [the end-to-end script](packages/matrix-bridge/scripts/e2e.ts). It builds both local images, starts separate runtime, Synapse, and bridge containers, registers a test Matrix owner and appservice, and starts the ADB login watcher. Scan the QR manually if no saved account is available. It checks history/media, rich cards, restart deduplication and runtime outage recovery, and **sends real text, replies, images, files, and video only to File Transfer**. The account must have a cached File Transfer conversation and cached image, file, and MP4 examples; those actual bytes are reused for sending. Red packets and transfers are never sent or collected. If running, it temporarily stops the standalone `wechatlinux-demo` container to prevent concurrent access to account files, then restores it. Login approval may be needed. Override images with `BRIDGE_IMAGE` and `WECHAT_RUNTIME_IMAGE`; override the existing container with `WECHATLINUX_CONTAINER`. Private artifacts stay under ignored `data/matrix-acceptance/`.
