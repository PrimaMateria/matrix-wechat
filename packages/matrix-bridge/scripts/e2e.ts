// Live E2E: starts the real runtime, Synapse, and bridge; sends only to File Transfer.
// Never creates a fake WeChat runtime or substitutes messages for native history.
import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configSchema } from "../src/config";
import { generateRegistration } from "../src/matrix";
import { hash } from "../src/store";

const root = resolve(import.meta.dir, "../../..");
const engine = "podman";
const original = process.env.WECHATLINUX_CONTAINER || "wechatlinux-demo";
const image = process.env.BRIDGE_IMAGE || "localhost/matrix-wechat:dev";
const runtimeImage = process.env.WECHAT_RUNTIME_IMAGE || "localhost/wechatlinux-demo:dev";
const apiToken = crypto.randomUUID();
const synapseImage = "docker.io/matrixdotorg/synapse:v1.162.0";
const directory = resolve(root, "data/matrix-acceptance", crypto.randomUUID());
const bridgeName = "matrix-wechat-acceptance",
  synapseName = "matrix-wechat-synapse",
  runtimeName = "matrix-wechat-runtime-acceptance",
  network = "matrix-wechat-acceptance";
const server = "acceptance.local",
  owner = `@owner:${server}`;
let restored = false,
  stoppedOriginal = false;
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});
process.on("SIGTERM", () => {
  interrupted = true;
});
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(`${directory}/bridge`, { mode: 0o700 });
await mkdir(`${directory}/synapse`, { mode: 0o700 });
async function run(args: string[], allowFailure = false) {
  const process = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0 && !allowFailure) {
    await Bun.write(`${directory}/command-error.log`, stderr);
    throw new Error(`${args.slice(0, 2).join(" ")} failed (${code}); details saved privately`);
  }
  return { code, stdout };
}
async function waitFor(label: string, predicate: () => Promise<boolean>, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let progress = Date.now();
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Acceptance interrupted; restoring the original runtime");
    try {
      if (await predicate()) return;
    } catch {}
    if (Date.now() - progress > 20000) {
      console.log(`Waiting for ${label}`);
      progress = Date.now();
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function assert(value: unknown, scenario: string): asserts value {
  if (!value) throw new Error(`Acceptance failed: ${scenario}`);
}
async function native(path: string) {
  const response = await fetch(`http://127.0.0.1:18742${path}`, {
    signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, "native HTTP response");
  return response.json() as Promise<any>;
}
let account = "";
let conversations: { id: string }[] = [];
const source: any[] = [];
async function captureSource() {
  const status = await native("/api/status");
  assert(
    status.state === "logged_in" && status.account?.id,
    "existing WeChat account is logged in",
  );
  account = status.account.id as string;
  conversations = (await native("/api/conversations")).conversations as { id: string }[];
  assert(
    conversations.some((c) => c.id === "filehelper"),
    "real File Transfer conversation is available",
  );
  source.length = 0;
  for (const conversation of conversations) {
    let cursor: string | undefined;
    do {
      const page = await native(
        `/api/history?chat_id=${encodeURIComponent(conversation.id)}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      source.push(...page.messages);
      cursor = page.next_cursor;
    } while (cursor);
  }
  assert(source.length > 0, "real native history is available");
  console.log(`Live source: ${conversations.length} conversations, ${source.length} messages`);
}
const config = configSchema.parse({
  homeserver: { address: `http://${synapseName}:8008`, domain: server },
  appservice: { address: `http://${bridgeName}:17778`, registration: "/data/registration.yaml" },
  wechat: { address: `http://${runtimeName}:18743` },
  bridge: { owner },
  database: { path: "/data/matrix-wechat.db" },
});
const registration = generateRegistration(config);
const secret = crypto.randomUUID();
await Bun.write(`${directory}/bridge/config.yaml`, Bun.YAML.stringify(config));
await Bun.write(
  `${directory}/bridge/registration.yaml`,
  Bun.YAML.stringify(registration.getOutput()),
);
await Bun.write(
  `${directory}/synapse/registration.yaml`,
  Bun.YAML.stringify(registration.getOutput()),
);
await Bun.write(
  `${directory}/synapse/homeserver.yaml`,
  Bun.YAML.stringify({
    server_name: server,
    public_baseurl: "http://127.0.0.1:18008/",
    report_stats: false,
    listeners: [
      {
        port: 8008,
        bind_addresses: ["0.0.0.0"],
        type: "http",
        tls: false,
        resources: [{ names: ["client"], compress: false }],
      },
    ],
    database: { name: "sqlite3", args: { database: "/data/homeserver.db" } },
    signing_key_path: "/data/signing.key",
    media_store_path: "/data/media_store",
    registration_shared_secret: secret,
    trusted_key_servers: [],
    app_service_config_files: ["/data/registration.yaml"],
    log_config: "/data/log.config",
  }),
);
await Bun.write(
  `${directory}/synapse/log.config`,
  Bun.YAML.stringify({
    version: 1,
    handlers: { console: { class: "logging.StreamHandler" } },
    root: { level: "WARNING", handlers: ["console"] },
  }),
);
for (const file of [
  "bridge/config.yaml",
  "bridge/registration.yaml",
  "synapse/registration.yaml",
  "synapse/homeserver.yaml",
  "synapse/log.config",
])
  await chmod(`${directory}/${file}`, 0o600);
let watcher: ReturnType<typeof Bun.spawn> | undefined;
let token = "";
async function matrix(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`http://127.0.0.1:18008${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = (await response.json()) as any;
  assert(response.ok, `Matrix ${method} ${path.split("/").slice(0, 5).join("/")}`);
  return result;
}
function database() {
  return new Database(`${directory}/bridge/matrix-wechat.db`, { readonly: true });
}
async function ready() {
  if ((await native("/api/status")).state !== "logged_in") return false;
  const db = database();
  try {
    const rooms = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM portals WHERE imported=1")
      .get()!.n;
    return rooms >= conversations.length;
  } finally {
    db.close();
  }
}
async function capture() {
  const db = database();
  try {
    return db.query<any, []>("SELECT * FROM messages ORDER BY chat,id").all();
  } finally {
    db.close();
  }
}
async function joinPortals() {
  const db = database();
  const rooms = db.query<{ room: string }, []>("SELECT room FROM portals").all();
  db.close();
  for (const { room } of rooms)
    await matrix(`/_matrix/client/v3/join/${encodeURIComponent(room)}`, "POST", {});
}
for (const name of [bridgeName, runtimeName, synapseName])
  assert(
    (await run([engine, "container", "exists", name], true)).code !== 0,
    "acceptance container names are unused",
  );
try {
  for (const [override, tag, dockerfile] of [
    [process.env.BRIDGE_IMAGE, image, "packages/matrix-bridge/Dockerfile"],
    [process.env.WECHAT_RUNTIME_IMAGE, runtimeImage, "packages/wechat-runtime/Dockerfile"],
  ]) {
    if (!override) {
      console.log(`Building ${dockerfile}`);
      const result = await run([engine, "build", "-f", dockerfile!, "-t", tag!, "."]);
      await Bun.write(
        `${directory}/${dockerfile!.includes("matrix-bridge") ? "bridge" : "runtime"}-build.log`,
        result.stdout,
      );
    }
  }
  if ((await run([engine, "image", "exists", synapseImage], true)).code !== 0)
    await run([engine, "pull", synapseImage]);
  await run([engine, "network", "create", network]);
  await run([
    engine,
    "run",
    "-d",
    "--name",
    synapseName,
    "--network",
    network,
    "--userns",
    "keep-id:uid=991,gid=991",
    "--user",
    "991:991",
    "-p",
    "127.0.0.1:18008:8008",
    "-v",
    `${directory}/synapse:/data:Z`,
    synapseImage,
  ]);
  await waitFor(
    "Synapse",
    async () => (await fetch("http://127.0.0.1:18008/_matrix/client/versions")).ok,
  );
  const { nonce } = await matrix("/_synapse/admin/v1/register");
  const password = crypto.randomUUID();
  const mac = new Bun.CryptoHasher("sha1", secret)
    .update(`${nonce}\0owner\0${password}\0admin`)
    .digest("hex");
  token = (
    await matrix("/_synapse/admin/v1/register", "POST", {
      nonce,
      username: "owner",
      password,
      admin: true,
      mac,
    })
  ).access_token;
  const existing = await run([engine, "inspect", "--format", "{{.State.Running}}", original], true);
  if (existing.code === 0 && existing.stdout.trim() === "true") {
    await run([engine, "stop", "--time", "20", original]);
    stoppedOriginal = true;
  }
  await mkdir(`${root}/data/wechat`, { recursive: true, mode: 0o700 });
  await run([
    engine,
    "run",
    "-d",
    "--name",
    runtimeName,
    "--network",
    network,
    "--userns",
    "keep-id:uid=1000,gid=1000",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SYS_PTRACE",
    "--cap-add",
    "SYS_CHROOT",
    "--security-opt",
    "no-new-privileges",
    "--shm-size",
    "256m",
    "-p",
    "127.0.0.1:18742:18742",
    "-e",
    `WECHAT_API_TOKEN=${apiToken}`,
    "-v",
    `${root}/data/wechat:/home/wechat:Z`,
    runtimeImage,
  ]);
  watcher = Bun.spawn(["bun", "packages/wechat-runtime/scripts/adb-login.ts", "--watch"], {
    cwd: root,
    stdout: Bun.file(`${directory}/adb.log`),
    stderr: Bun.file(`${directory}/adb-errors.log`),
  });
  console.log(
    "WeChat login: the ADB watcher approves phone prompts. Scan the QR at http://127.0.0.1:18742/ if needed.",
  );
  await waitFor(
    "WeChat login",
    async () => (await native("/api/status")).state === "logged_in",
    600000,
  );
  await captureSource();
  await run([
    engine,
    "run",
    "-d",
    "--name",
    bridgeName,
    "--network",
    network,
    "--userns",
    "keep-id:uid=1000,gid=1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-p",
    "127.0.0.1:17778:17778",
    "-e",
    `WECHAT_API_TOKEN=${apiToken}`,
    "-v",
    `${directory}/bridge:/data:Z`,
    image,
  ]);
  await waitFor("native login and full history import", ready, 240000);
  assert((await native("/api/status")).account.id === account, "saved native account is preserved");
  assert((await fetch("http://127.0.0.1:18742/")).ok, "web UI port 18742");
  const ping = await fetch(
    `http://127.0.0.1:17778/_matrix/app/v1/transactions/${crypto.randomUUID()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.getHomeserverToken()}`,
        "Content-Type": "application/json",
      },
      body: '{"events":[]}',
    },
  );
  assert(ping.ok, "authenticated Matrix appservice port 17778");
  await joinPortals();
  let mappings = await capture();
  let media = 0,
    thumbnails = 0,
    unavailable = 0;
  const kinds = new Set<string>();
  for (const message of source) {
    const mapping = mappings.find(
      (m) => m.account === account && m.chat === message.chat_id && m.id === message.id,
    );
    assert(mapping, "every native cached message has a SQLite mapping");
    const db = database();
    const { room } = db
      .query<any, [string]>("SELECT room FROM portals WHERE chat=?")
      .get(message.chat_id);
    db.close();
    const event = await matrix(
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(mapping.event)}`,
    );
    assert(
      !("native" in event.content) && !("build_hash" in event.content),
      "private native metadata never crosses to Matrix",
    );
    if (message.kind === "text")
      assert(
        event.content.body === message.text || event.content.body.endsWith(message.text),
        "actual native text survives conversion",
      );
    if (message.payment)
      assert(
        event.content.msgtype === "m.notice" &&
          event.content.format === "org.matrix.custom.html" &&
          event.content.body.includes("Read only"),
        "native payments arrive as read-only rich cards",
      );
    if (message.link?.thumbnail) {
      const thumbnail =
        event.content["com.beeper.linkpreviews"]?.[0]?.["og:image"] ||
        event.content.formatted_body?.match(/src="(mxc:[^"]+)"/)?.[1];
      assert(thumbnail, "shared card has a Matrix thumbnail");
      const [, host, id] = thumbnail.match(/^mxc:\/\/([^/]+)\/(.+)$/);
      const uploaded = await fetch(
        `http://127.0.0.1:18008/_matrix/client/v1/media/download/${host}/${id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const nativeThumbnail = await fetch(
        `http://127.0.0.1:18742/api/thumbnail?chat_id=${encodeURIComponent(message.chat_id)}&message_id=${encodeURIComponent(message.id)}`,
      );
      assert(
        uploaded.ok &&
          nativeThumbnail.ok &&
          hash(new Uint8Array(await uploaded.arrayBuffer())) ===
            hash(new Uint8Array(await nativeThumbnail.arrayBuffer())),
        "shared card thumbnail exactly matches native bytes",
      );
      if (message.kind === "link")
        assert(
          event.content.formatted_body?.includes("<td>"),
          "article thumbnail sits beside its text",
        );
      thumbnails++;
    }
    if (event.content.url) {
      const asset = event.content.url.match(/^mxc:\/\/([^/]+)\/(.+)$/);
      assert(asset, "received media is uploaded to Matrix");
      const response = await fetch(
        `http://127.0.0.1:18008/_matrix/client/v1/media/download/${asset[1]}/${asset[2]}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert(response.ok, "authenticated Matrix media download");
      const sourceResponse = await fetch(
        `http://127.0.0.1:18742/api/media?chat_id=${encodeURIComponent(message.chat_id)}&message_id=${encodeURIComponent(message.id)}`,
      );
      assert(sourceResponse.ok, "native media is available");
      assert(
        hash(new Uint8Array(await response.arrayBuffer())) ===
          hash(new Uint8Array(await sourceResponse.arrayBuffer())),
        "Matrix media exactly matches real native media bytes",
      );
      media++;
    } else if (mapping.media_retry) unavailable++;
    kinds.add(message.kind);
  }
  console.log(
    `Imported real history: ${mappings.length} SQLite mappings; ${media} exact media matches; ${unavailable} explicit unavailable attachments; kinds: ${[...kinds].join(", ")}`,
  );
  const before = mappings.map((m) => [m.chat, m.id, m.event]);
  await run([engine, "restart", "--time", "20", bridgeName]);
  await waitFor("bridge restart and history reconciliation", ready, 240000);
  mappings = await capture();
  assert(
    JSON.stringify(before) === JSON.stringify(mappings.map((m) => [m.chat, m.id, m.event])),
    "restart preserves exact message mappings without replay",
  );
  console.log("Restart deduplication passed against the real account");
  const db = database();
  const { room } = db.query<any, []>("SELECT room FROM portals WHERE chat='filehelper'").get();
  db.close();
  const text = `Matrix bridge live acceptance ${crypto.randomUUID()} — Unicode 回复`;
  const sent = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: text },
  );
  await waitFor("source-confirmed self-send", async () => {
    const db = database();
    try {
      return Boolean(
        db
          .query<any, [string]>("SELECT id FROM inbox WHERE id=? AND state='delivered'")
          .get(sent.event_id),
      );
    } finally {
      db.close();
    }
  });
  const sourceSelf = (await native("/api/history?chat_id=filehelper&limit=500")).messages.find(
    (m: any) => m.text === text,
  );
  assert(
    sourceSelf?.own && /^\d+$/.test(sourceSelf.id) && sourceSelf.id !== "0",
    "native server ID confirms the Matrix self-send",
  );
  const reply = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    {
      msgtype: "m.text",
      body: "Live Matrix quote acceptance 回复",
      "m.relates_to": { "m.in_reply_to": { event_id: sent.event_id } },
    },
  );
  await waitFor("source-confirmed native quote", async () => {
    const db = database();
    try {
      return Boolean(
        db
          .query<any, [string]>("SELECT id FROM inbox WHERE id=? AND state='delivered'")
          .get(reply.event_id),
      );
    } finally {
      db.close();
    }
  });
  assert(
    (await native("/api/history?chat_id=filehelper&limit=500")).messages.some(
      (m: any) => m.reply_to === sourceSelf.id && m.own && /^\d+$/.test(m.id),
    ),
    "Matrix reply references the exact native server ID",
  );
  console.log("Actual Matrix → WeChat text and quoted reply delivery passed (File Transfer only)");
  const sentMedia: string[] = [];
  for (const kind of ["image", "file", "video"]) {
    const candidate = source.find(
      (message) =>
        message.kind === kind &&
        mappings.some(
          (mapping) =>
            mapping.chat === message.chat_id && mapping.id === message.id && !mapping.media_retry,
        ),
    );
    assert(candidate, `real cached ${kind} is available for outbound acceptance`);
    const asset = await fetch(
      `http://127.0.0.1:18742/api/media?chat_id=${encodeURIComponent(candidate.chat_id)}&message_id=${encodeURIComponent(candidate.id)}`,
    );
    assert(asset.ok, `actual ${kind} cache read`);
    const bytes = new Uint8Array(await asset.arrayBuffer());
    const mime = asset.headers.get("Content-Type") || "application/octet-stream";
    const extension =
      kind === "video"
        ? "mp4"
        : kind === "file"
          ? "bin"
          : mime === "image/png"
            ? "png"
            : mime === "image/gif"
              ? "gif"
              : "jpg";
    const name = `native-cache-${crypto.randomUUID()}.${extension}`;
    const upload = await fetch(
      `http://127.0.0.1:18008/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
        body: bytes,
      },
    );
    assert(upload.ok, `real ${kind} Matrix upload`);
    const mxc = ((await upload.json()) as any).content_uri;
    const event = await matrix(
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
      "PUT",
      {
        msgtype: kind === "image" ? "m.image" : kind === "video" ? "m.video" : "m.file",
        body: name,
        filename: name,
        url: mxc,
        info: { mimetype: mime, size: bytes.length },
      },
    );
    let nativeID = "";
    await waitFor(`source-confirmed native ${kind} upload`, async () => {
      const db = database();
      try {
        const result = db
          .query<any, [string]>(
            "SELECT messages.id FROM inbox JOIN messages ON messages.event=inbox.id WHERE inbox.id=? AND inbox.state='delivered'",
          )
          .get(event.event_id);
        nativeID = result?.id || "";
        return Boolean(nativeID);
      } finally {
        db.close();
      }
    });
    assert(/^\d+$/.test(nativeID) && nativeID !== "0", `native ${kind} has an exact server ID`);
    const received = await fetch(
      `http://127.0.0.1:18742/api/media?chat_id=filehelper&message_id=${encodeURIComponent(nativeID)}`,
    );
    assert(
      received.ok && hash(new Uint8Array(await received.arrayBuffer())) === hash(bytes),
      `actual ${kind} upload bytes survive native delivery`,
    );
    sentMedia.push(kind);
  }
  console.log(
    "Actual Matrix → WeChat image, file and MP4 delivery passed with matching native bytes",
  );
  await run([engine, "stop", "--time", "20", runtimeName]);
  const recoveryText = `Runtime restart recovery ${crypto.randomUUID()}`;
  const recovery = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: recoveryText },
  );
  await waitFor("queued send during runtime outage", async () => {
    const db = database();
    try {
      return (
        db.query<any, [string]>("SELECT state FROM inbox WHERE id=?").get(recovery.event_id)
          ?.state === "queued"
      );
    } finally {
      db.close();
    }
  });
  await run([engine, "start", runtimeName]);
  await waitFor(
    "send after runtime login resumes",
    async () => {
      const db = database();
      try {
        return (
          db.query<any, [string]>("SELECT state FROM inbox WHERE id=?").get(recovery.event_id)
            ?.state === "delivered"
        );
      } finally {
        db.close();
      }
    },
    240000,
  );
  assert(
    (await native("/api/history?chat_id=filehelper&limit=500")).messages.filter(
      (m: any) => m.own && m.text === recoveryText,
    ).length === 1,
    "a queued Matrix send survives runtime restart and is delivered exactly once",
  );
  console.log("Runtime outage and login recovery passed against File Transfer");
  async function botRequest(path: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:18008${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${registration.getAppServiceToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert(response.ok, "bot's authenticated Matrix operation");
  }
  const guestNonce = (await matrix("/_synapse/admin/v1/register")).nonce;
  const guestPassword = crypto.randomUUID();
  const guestMac = new Bun.CryptoHasher("sha1", secret)
    .update(`${guestNonce}\0observer\0${guestPassword}\0notadmin`)
    .digest("hex");
  const guest = await matrix("/_synapse/admin/v1/register", "POST", {
    nonce: guestNonce,
    username: "observer",
    password: guestPassword,
    admin: false,
    mac: guestMac,
  });
  await botRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`, {
    user_id: guest.user_id,
  });
  const guestJoin = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/join/${encodeURIComponent(room)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guest.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert(guestJoin.ok, "second Matrix user joins the real portal");
  const forbiddenText = `Permission acceptance ${crypto.randomUUID()}`;
  const guestSend = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${guest.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ msgtype: "m.text", body: forbiddenText }),
    },
  );
  assert(guestSend.ok, "second Matrix user sends a real event");
  const guestEvent = (await guestSend.json()) as any;
  // Synapse reserves this event type for the room's elevated users, even without state_key.
  const falseEncryption = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.encryption/${crypto.randomUUID()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.getAppServiceToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ algorithm: "m.megolm.v1.aes-sha2" }),
    },
  );
  assert(falseEncryption.ok, "bot sends a real non-state encryption event");
  const marker = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: `Owner permission barrier ${crypto.randomUUID()}` },
  );
  await waitFor("owner event after unauthorized sender", async () => {
    const db = database();
    try {
      return Boolean(
        db
          .query<any, [string]>("SELECT id FROM inbox WHERE id=? AND state='delivered'")
          .get(marker.event_id),
      );
    } finally {
      db.close();
    }
  });
  const permissionsDB = database();
  assert(
    !permissionsDB.query<any, [string]>("SELECT id FROM inbox WHERE id=?").get(guestEvent.event_id),
    "only the configured owner can enqueue native sends",
  );
  permissionsDB.close();
  assert(
    !(await native("/api/history?chat_id=filehelper&limit=500")).messages.some(
      (m: any) => m.text === forbiddenText,
    ),
    "unauthorized Matrix messages never reach WeChat",
  );
  await botRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/kick`, {
    user_id: guest.user_id,
  });
  const encryption = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.encryption/`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.getAppServiceToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ algorithm: "m.megolm.v1.aes-sha2" }),
    },
  );
  assert(encryption.ok, "actual portal is marked encrypted");
  const encryptedText = `Encryption acceptance ${crypto.randomUUID()}`;
  const rejected = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: encryptedText },
  );
  await waitFor("encrypted room rejection", async () => {
    const db = database();
    try {
      return Boolean(
        db
          .query<any, [string]>("SELECT id FROM inbox WHERE id=? AND state='failed'")
          .get(rejected.event_id),
      );
    } finally {
      db.close();
    }
  });
  assert(
    !(await native("/api/history?chat_id=filehelper&limit=500")).messages.some(
      (m: any) => m.text === encryptedText,
    ),
    "encrypted-room messages never reach WeChat",
  );
  console.log(
    "Owner-only sending and encrypted-room rejection passed against Synapse and native source history",
  );
  await Bun.write(
    `${directory}/proof.json`,
    JSON.stringify(
      {
        verified_at: new Date().toISOString(),
        conversations: conversations.length,
        messages: source.length,
        media,
        thumbnails,
        unavailable,
        kinds: [...kinds],
        restart_deduplication: true,
        runtime_outage_recovery: true,
        native_text: true,
        native_reply: true,
        native_media: sentMedia,
        owner_permissions: true,
        encryption_rejection: true,
        web_port: 18742,
        matrix_port: 17778,
      },
      null,
      2,
    ),
  );
} finally {
  watcher?.kill();
  for (const name of [bridgeName, runtimeName, synapseName]) {
    const logs = await run([engine, "logs", name], true);
    await Bun.write(`${directory}/${name}.log`, logs.stdout);
    await run([engine, "rm", "--force", name], true);
  }
  await run([engine, "network", "rm", network], true);
  if (stoppedOriginal) {
    interrupted = false;
    await run([engine, "start", original]);
    restored = true;
    watcher = Bun.spawn(["bun", "packages/wechat-runtime/scripts/adb-login.ts", "--watch"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitFor(
        "restored original WeChat runtime",
        async () => (await native("/api/status")).state === "logged_in",
      );
    } finally {
      watcher.kill();
    }
  }
  console.log(
    `Private acceptance artifacts: ${directory}; original runtime ${restored ? "restored" : "unchanged"}`,
  );
}
