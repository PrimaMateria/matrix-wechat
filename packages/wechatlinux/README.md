# WeChat native API

Container-only WeChat Linux 4.1.13 instrumentation, Bun + TypeScript API, and React chat UI. The native executable is pinned by SHA-256.

```sh
packages/wechatlinux/scripts/container.sh build
packages/wechatlinux/scripts/container.sh start
```

Open http://127.0.0.1:18742/. The service resumes the client's saved account automatically. WeChat may require confirmation on the phone. Without a saved account, the page displays the client's QR code.

The Dockerfile downloads the original vendor AppImage from the repository's [pinned client release](https://github.com/yamada-sexta/matrix-wechat/releases/tag/wechat-client-4.1.13-4526180b), retries transient failures up to three times, checks the SHA-256 from the native ABI profile, and extracts and verifies the executable during build. `WECHAT_APPIMAGE_URL` can override the download mirror while retaining the same hash pin. The expected AppImage hash is `4526180bca980128791599af122ff4795002a5715a510f6a65480e2be6874244`. A changed download fails the build. Both hashes are checked again before startup. The client installation is read-only to the runtime user; the image contains no account data.

The build runs lint, type checking and tests, then builds the native hook and React UI with locked Bun dependencies. CI builds the same amd64 Dockerfile and checks the bundled client without launching WeChat. Writable account state is mounted from repository `data/wechat` to container `/home/wechat`. The launcher publishes only `127.0.0.1:18742`, uses private PID/display namespaces, and grants `SYS_PTRACE` for Frida plus `SYS_CHROOT` for the embedded browser sandbox. No host home, display, or IPC is mounted. Server startup rejects host execution.

```sh
packages/wechatlinux/scripts/container.sh stop
packages/wechatlinux/scripts/container.sh start
packages/wechatlinux/scripts/container.sh logs --tail 30
```

Stop/start preserves state. Rebuild and stop/start after source changes; no manual copying into a running container is needed.

Development checks do not launch WeChat:

```sh
cd packages/wechatlinux
bun install --frozen-lockfile
bun run check
bun run lint
bun test
bun run build
```

HTTP API: `GET /api/status`, `/api/contacts`, `/api/groups`, `/api/conversations`, `/api/history?chat_id=...&limit=50&cursor=...`, `/api/capabilities`; `GET /api/events` provides Server-Sent Events; `POST /api/send` accepts `{ "chat_id": "...", "kind": "text", "text": "..." }`. Native IDs remain decimal strings. Browser responses exclude native raw rows, key material, and paths. Errors use `{ "error": { "code": "...", "message": "..." } }`.

Text and quoted replies use native send handlers; image and file uploads use native upload handlers. A send acknowledgement reports the native handler result; delivery is verified from source history with a server ID. Receiving supports cached images, MP4 videos, files, profile pictures, stickers/GIFs, and decoded voice audio. Video reads verify message size and checksum, with a 64 MiB limit. Use the File button or `POST /api/send-file` for MP4 uploads: WeChat may classify them as native video messages, as verified with an H.264 sample. Uncached video downloading and other video formats remain unverified. Other send types remain unverified. Incoming updates use native database write hooks followed by committed-state reconciliation; a direct global message callback remains unverified. API/schema/investigation notes live in entirely ignored `wechat_api/`.

Native ABI metadata lives in `src/native/*_profile.toml`. Bun's TOML reader loads the runtime profiles, and Zod validates their hashes, addresses, and instruction bytes before injection. Zod also validates login and text-send parameters at the shared runtime boundary for HTTP and the private socket. Vendor payloads and the API wire protocol retain XML/JSON. Bun's SQLite connector runs the storage fixtures; encrypted account databases are read through the client's native WCDB connection.

`bun run check` checks the Bun/React app and the Frida hook separately. The native directory's TypeScript configuration supplies Frida globals and the injected profile types without browser or Bun globals.

Git ignores account data, local notes, dependencies, build output, QR images, logs, databases, and captures. No personal data belongs in source, fixtures, or the Docker build context.

To approve desktop login requests from an ADB-connected phone, run this on the host while the container runs:

```sh
bun packages/wechatlinux/scripts/adb-login.ts --watch
```

The watcher checks the local API for a pending phone confirmation, matches WeChat's desktop login prompt through Android UI automation, and presses its login button. When WeChat hides accessibility controls, it checks the exact desktop-login activity and locates the large green button from an in-memory screenshot. It waits when the phone is locked. Use `ANDROID_SERIAL` when multiple ADB devices are connected. Omit `--watch` for one check; Ctrl+C stops the watcher. UI dumps are temporary files on the phone and are deleted after each check; account and conversation text are not logged.
