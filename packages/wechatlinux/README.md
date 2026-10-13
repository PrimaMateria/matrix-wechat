# WeChat native API

Container-only WeChat Linux 4.1.13 instrumentation, Bun + TypeScript API, and React chat UI. The native executable is pinned by SHA-256. The parent Matrix bridge remains separate.

```sh
packages/wechatlinux/scripts/container.sh build
packages/wechatlinux/scripts/container.sh --appimage /path/to/WeChatLinux_x86_64.AppImage start
```

Open http://127.0.0.1:18742/. The service resumes the client's saved account automatically. WeChat may require confirmation on the phone. Without a saved account, the page displays the client's QR code.

The Dockerfile installs Bun and locked dependencies and builds the native hook and React UI. Application source is baked into the image. Writable account state is mounted from repository `data/wechat` to container `/home/wechat`. The launcher publishes only `127.0.0.1:18742`, uses private PID/display namespaces, and grants `SYS_PTRACE` for Frida plus `SYS_CHROOT` for the embedded browser sandbox. No host home, display, or IPC is mounted. Server startup rejects host execution.

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
bun test
bun run build
```

HTTP API: `GET /api/status`, `/api/contacts`, `/api/groups`, `/api/conversations`, `/api/history?chat_id=...&limit=50&cursor=...`, `/api/capabilities`; `GET /api/events` provides Server-Sent Events; `POST /api/send` accepts `{ "chat_id": "...", "kind": "text", "text": "..." }`. Native IDs remain decimal strings. Browser responses exclude native raw rows, key material, and paths. Errors use `{ "error": { "code": "...", "message": "..." } }`.

Sending requires native callback validation. Its acknowledgement reports the native handler result, not a remote read receipt. Media downloads and additional send types remain unverified. Incoming updates currently use native database write hooks followed by committed-state reconciliation; a direct global message callback remains unverified. API/schema/investigation notes live in entirely ignored `wechat_api/`.

Git ignores account data, local notes, dependencies, build output, QR images, logs, databases, and captures. No personal data belongs in source, fixtures, or the Docker build context.
