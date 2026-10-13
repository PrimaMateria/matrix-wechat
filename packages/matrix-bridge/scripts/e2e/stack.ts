// Live E2E: starts the real runtime, Synapse, and bridge; sends only to File Transfer.
// Never creates a fake WeChat runtime or substitutes messages for native history.
import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configSchema } from "../../src/config";
import { generateRegistration } from "../../src/matrix";

const root = resolve(import.meta.dir, "../../../..");
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
const started = new Set<string>();
let ownsNetwork = false;
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
  if (code === 0 && args[1] === "run" && args.includes("--name"))
    started.add(args[args.indexOf("--name") + 1]);
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
async function captureSource(includeHistory: boolean) {
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
  if (!includeHistory) return;
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

export {
  account,
  assert,
  bridgeName,
  capture,
  conversations,
  database,
  directory,
  engine,
  matrix,
  native,
  owner,
  ready,
  registration,
  root,
  run,
  runtimeName,
  secret,
  source,
  token,
  waitFor,
};

export function fileTransferRoom(): string {
  const db = database();
  try {
    const portal = db
      .query<{ room: string }, []>("SELECT room FROM portals WHERE chat='filehelper'")
      .get();
    assert(portal, "File Transfer portal exists");
    return portal.room;
  } finally {
    db.close();
  }
}
export async function delivered(event: string) {
  await waitFor("source-confirmed send", async () => {
    const db = database();
    try {
      return (
        db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(event)
          ?.state === "delivered"
      );
    } finally {
      db.close();
    }
  });
}
export async function botRequest(path: string, body: unknown) {
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

export async function setup(rebuild = false, includeHistory = true) {
  for (const name of [bridgeName, runtimeName, synapseName])
    assert(
      (await run([engine, "container", "exists", name], true)).code !== 0,
      "acceptance container names are unused",
    );
  for (const [override, tag, dockerfile] of [
    [process.env.BRIDGE_IMAGE, image, "packages/matrix-bridge/Dockerfile"],
    [process.env.WECHAT_RUNTIME_IMAGE, runtimeImage, "packages/wechat-runtime/Dockerfile"],
  ]) {
    if (!override && (rebuild || (await run([engine, "image", "exists", tag!], true)).code !== 0)) {
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
  ownsNetwork = true;
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
  await captureSource(includeHistory);
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
}

export async function close() {
  watcher?.kill();
  for (const name of started) {
    const logs = await run([engine, "logs", name], true);
    await Bun.write(`${directory}/${name}.log`, logs.stdout);
    await run([engine, "rm", "--force", name], true);
  }
  if (ownsNetwork) await run([engine, "network", "rm", network], true);
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
