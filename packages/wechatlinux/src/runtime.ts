import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import * as frida from "frida";
import { PNG } from "pngjs";
import { receivedFile, receivedImage } from "./attachments";
import { voiceAudioProcess } from "./audio";
import { imageType, stickerImage } from "./media";
import outbound from "./native/outbound_profile.json";
import profile from "./native/storage_profile.json";
import { Storage } from "./storage";
import { APIError, type Database, type Event, type Row, type Status } from "./types";

const root = join(import.meta.dir, ".."),
  data = process.env.WECHAT_DATA_DIR || "/home/wechat/.cache/wechatlinux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sha(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function privateWrite(path: string, bytes: Uint8Array | string) {
  const temporary = path + ".tmp";
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}
function blobs(v: any): any {
  if (Array.isArray(v)) return v.map(blobs);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && Array.isArray(v.bytes))
      return { base64: Buffer.from(v.bytes).toString("base64") };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blobs(x)]));
  }
  return v;
}
export class Runtime {
  readonly store = new Storage(
    {
      databases: () => this.native("databases"),
      query: async (id, sql, limit) => blobs(await this.native("query", id, sql, limit)),
    },
    () => this.account,
  );
  status: Status = { state: "starting" };
  account = "";
  qr: Buffer | undefined;
  qrAt = 0;
  stopped = false;
  private device?: frida.Device;
  private session?: frida.Session;
  private script?: frida.Script;
  private pid = 0;
  private xvfb?: Bun.Subprocess;
  private display = "";
  private dirty = true;
  private baseline = false;
  private loginRequested = false;
  private lastQR = 0;
  private tickBusy = false;
  private lastLoginRetry = 0;
  private serial: Promise<any> = Promise.resolve();
  private subscribers = new Set<(e: Event) => void>();
  private sendReady = false;
  verified = new Set<string>();
  private uploads = new Map<
    string,
    { path: string; cachedPath: string; size: number; directory?: string }
  >();

  async sendFile(chat: string, bytes: Buffer, name: string) {
    if (
      !chat ||
      chat.length > 256 ||
      !bytes.length ||
      bytes.length > 64 * 1024 * 1024 ||
      !name ||
      name === "." ||
      name === ".." ||
      Buffer.byteLength(name) > 200 ||
      /[/\\\x00-\x1f\x7f]/.test(name)
    )
      throw new APIError("invalid_params", "Choose a file up to 64 MiB with a valid filename");
    return this.operation(async () => {
      if (this.status.state !== "logged_in" || !this.sendReady)
        throw new APIError("not_ready", "WeChat is still initializing");
      if (
        this.uploads.size >= 8 ||
        [...this.uploads.values()].reduce((n, upload) => n + upload.size, 0) + bytes.length >
          64 * 1024 * 1024
      )
        throw new APIError("not_ready", "Too many uploads; try again shortly");
      const token = randomUUID(),
        directory = join(data, "uploads", token),
        path = join(directory, name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const cleanup = async () => {
        this.uploads.delete(token);
        await unlink(path).catch(() => {});
        await rmdir(directory).catch(() => {});
      };
      try {
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await cleanup();
        throw error;
      }
      this.uploads.set(token, { path, cachedPath: path, directory, size: bytes.length });
      const timer = setTimeout(() => void cleanup(), 120000);
      timer.unref();
      const response = await this.native("sendfile", chat, path, name);
      if (response.success !== true) {
        clearTimeout(timer);
        await cleanup();
        throw new APIError("send_failed", response.error_message || "WeChat rejected the file");
      }
      // The native callback acknowledges queueing, before the asynchronous CDN upload.
      // Retain the source until a server ID appears; reconcile without blocking other operations.
      const started = Date.now() / 1000;
      const finish = async () => {
        for (let attempt = 0; attempt < 100 && !this.stopped; attempt++) {
          await sleep(1000);
          try {
            const page = await this.operation(() =>
              this.store.history({ chat_id: chat, limit: 50 }),
            );
            if (
              page.messages.some(
                (m) =>
                  m.own &&
                  m.kind === "file" &&
                  m.media?.name === name &&
                  m.timestamp >= started - 2 &&
                  !m.id.startsWith("local:"),
              )
            ) {
              clearTimeout(timer);
              await cleanup();
              return;
            }
          } catch {}
        }
      };
      void finish();
      this.dirty = true;
      this.verified.add("send.file");
      return { success: true, acknowledgement: "native_handler" };
    });
  }

  async sendImage(chat: string, bytes: Buffer) {
    const type = imageType(bytes);
    if (
      !chat ||
      chat.length > 256 ||
      !bytes.length ||
      bytes.length > 20 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type || "")
    )
      throw new APIError("invalid_params", "Choose a PNG, JPEG, GIF or WebP image up to 20 MiB");
    return this.operation(async () => {
      if (this.status.state !== "logged_in" || !this.sendReady)
        throw new APIError("not_ready", "WeChat is still initializing");
      if (
        this.uploads.size >= 8 ||
        [...this.uploads.values()].reduce((size, asset) => size + asset.size, 0) + bytes.length >
          64 * 1024 * 1024
      )
        throw new APIError("not_ready", "Too many uploads; try again shortly");
      const token = randomUUID();
      const directory = join(data, "uploads"),
        path = join(directory, token + "." + (type === "image/jpeg" ? "jpg" : type!.slice(6)));
      const database = (await this.store.databases()).find(
        (db) => db.path.includes("/" + this.account + "_") && db.path.includes("/db_storage/"),
      );
      if (!database) throw new APIError("not_ready", "Account media storage is still opening");
      const accountRoot = resolve(dirname(database.path), "../..");
      const cachedDirectory = join(
        accountRoot,
        "cache",
        new Date().toISOString().slice(0, 7),
        "HttpResource",
      );
      const cachedPath = join(cachedDirectory, createHash("md5").update(path).digest("hex"));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      await mkdir(cachedDirectory, { recursive: true, mode: 0o700 });
      await writeFile(cachedPath, bytes, { mode: 0o600, flag: "wx" });
      this.uploads.set(token, {
        path,
        cachedPath,
        size: bytes.length,
      });
      const cleanup = async () => {
        this.uploads.delete(token);
        await Promise.all([unlink(path).catch(() => {}), unlink(cachedPath).catch(() => {})]);
      };
      const timer = setTimeout(() => void cleanup(), 120000);
      timer.unref();
      const response = await this.native("sendimage", chat, path);
      clearTimeout(timer);
      await cleanup();
      if (response.success !== true)
        throw new APIError("send_failed", response.error_message || "WeChat rejected the image");
      this.dirty = true;
      this.verified.add("send.image");
      return { success: true, acknowledgement: "native_handler" };
    });
  }
  onEvent(fn: (e: Event) => void) {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
  emit(e: Event) {
    for (const fn of this.subscribers) fn(e);
  }
  private updateStatus(status: Status) {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return;
    this.status = status;
    this.emit({ type: "login.state", data: { status } });
  }
  operation<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(fn);
    this.serial = task.catch(() => {});
    return task;
  }
  async native(method: string, ...args: any[]) {
    if (!this.script || this.stopped) throw new APIError("disconnected", "WeChat is disconnected");
    try {
      return await this.script.exports[method](...args);
    } catch (e) {
      await appendFile(join(data, "native-errors.log"), method + ": " + String(e) + "\n", {
        mode: 0o600,
      });
      throw new APIError("native_error", "Native operation failed");
    }
  }
  async executable() {
    const image = process.env.WECHAT_APPIMAGE || "/home/wechat/WeChatLinux_x86_64.AppImage";
    const imageHash = await sha(image),
      extracted = join(data, "app-" + imageHash.slice(0, 16)),
      executable = join(extracted, "opt/wechat/wechat");
    if (!existsSync(executable)) {
      const handle = openSync(image, "r"),
        buffer = Buffer.alloc(2 * 1024 * 1024);
      let offset = -1;
      try {
        const n = readSync(handle, buffer, 0, buffer.length, 0);
        let start = 0;
        while (start < n) {
          start = buffer.indexOf("hsqs", start);
          if (start < 0) break;
          if (start + 32 < n && buffer.readUInt16LE(start + 28) === 4) {
            offset = start;
            break;
          }
          start += 4;
        }
      } finally {
        closeSync(handle);
      }
      if (offset < 0) throw new APIError("unsupported_build", "Unsupported AppImage");
      const process = Bun.spawn(
        ["unsquashfs", "-no-progress", "-d", extracted, "-o", String(offset), image],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (await process.exited)
        throw new APIError("extraction_failed", "AppImage extraction failed");
    }
    if ((await sha(executable)) !== profile.artifact.sha256)
      throw new APIError("unsupported_build", "WeChat executable does not match the pinned build");
    return executable;
  }
  async start() {
    if (!existsSync("/run/.containerenv") && !existsSync("/.dockerenv"))
      throw new APIError("container_required", "WeChat must run inside its container");
    await mkdir(data, { recursive: true, mode: 0o700 });
    const executable = await this.executable();
    this.xvfb = Bun.spawn(
      ["Xvfb", "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const reader = (this.xvfb.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    this.display = ":" + new TextDecoder().decode(first.value).trim();
    if (this.display === ":") throw new APIError("launch_failed", "Display did not start");
    this.device = await frida.getLocalDevice();
    this.device.output.connect((_pid, _fd, bytes) => {
      if (bytes.length) {
        void stat(join(data, "client-output.log"))
          .then((s) =>
            s.size > 1048576 ? privateWrite(join(data, "client-output.log"), "") : undefined,
          )
          .catch(() => {})
          .then(() => appendFile(join(data, "client-output.log"), bytes, { mode: 0o600 }))
          .catch(() => {});
      }
    });
    this.pid = await this.device.spawn([executable], {
      env: { DISPLAY: this.display, QT_QPA_PLATFORM: "xcb" },
      stdio: frida.Stdio.Pipe,
    });
    this.session = await this.device.attach(this.pid);
    this.session.detached.connect(() => {
      if (!this.stopped) {
        this.updateStatus({ state: "disconnected" });
        this.emit({ type: "connection.closed" });
      }
    });
    const source =
      "const PROFILE=" +
      JSON.stringify(profile) +
      ";\nconst OUTBOUND=" +
      JSON.stringify(outbound) +
      ";\n" +
      (await readFile(join(root, "dist/native/instrument.js"), "utf8"));
    this.script = await this.session.createScript(source);
    let initialized = false,
      initialError = false;
    this.script.message.connect((message) => {
      if (message.type === "send") {
        const p = message.payload;
        if (p.type === "ready") initialized = true;
        else if (p.type === "login_state") {
          console.log("Native login state:", JSON.stringify(p.state));
          this.lastQR = 0;
          this.qr = undefined;
          this.qrAt = 0;
          this.updateStatus({
            state:
              !p.state.active || (p.state.phase === 4 && [3, 4].includes(p.state.request))
                ? "signing_in"
                : [3, 4].includes(p.state.phase)
                  ? "awaiting_confirmation"
                  : "awaiting_scan",
          });
        } else if (p.type === "change_hint") {
          this.dirty = true;
          this.store.invalidate();
        }
      } else if (message.type === "error") {
        initialError = true;
        console.error("Native instrumentation error:", message.description);
      }
    });
    await this.script.load();
    for (let i = 0; i < 50 && !initialized && !initialError; i++) await sleep(100);
    if (!initialized || initialError)
      throw new APIError("initialization_failed", "Native hooks did not initialize");
    await this.device.resume(this.pid);
    console.log("Native WeChat started inside container");
    void this.monitor();
  }
  private async refreshQR() {
    const scan = await this.native("scanqr"),
      matches = new Map<string, Buffer>();
    for (const candidate of scan.candidates) {
      try {
        const bytes = Buffer.from(candidate.bytes),
          png = PNG.sync.read(bytes);
        const gray = new Uint8ClampedArray(png.width * png.height);
        for (let i = 0; i < gray.length; i++)
          gray[i] = (png.data[i * 4] + 2 * png.data[i * 4 + 1] + png.data[i * 4 + 2]) / 4;
        const source = new RGBLuminanceSource(gray, png.width, png.height);
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        const decoder = new MultiFormatReader();
        decoder.setHints(hints);
        const text = decoder.decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
        if (
          ["weixin.qq.com", "login.weixin.qq.com", "login.wechat.com"].includes(
            new URL(text).hostname,
          )
        )
          matches.set(text, bytes);
      } catch {}
    }
    if (matches.size !== 1) return false;
    this.qr = [...matches.values()][0];
    this.qrAt = Date.now();
    await privateWrite(join(data, "login-qr.png"), this.qr);
    this.verified.add("login.qr");
    return true;
  }
  private async monitor() {
    while (!this.stopped) {
      if (!this.tickBusy) {
        this.tickBusy = true;
        try {
          await this.operation(async () => {
            const state = await this.native("status"),
              dbs: Database[] = await this.native("databases");
            const accounts = new Set(
              dbs
                .filter((d) => d.readable)
                .map((d) =>
                  d.path
                    .match(/\/xwechat_files\/([^/]+)\/db_storage\//)?.[1]
                    ?.replace(/_[0-9a-f]{4}$/, ""),
                )
                .filter(Boolean),
            );
            this.account = accounts.size === 1 ? [...accounts][0]! : "";
            if (this.account && !state.login_view_active) {
              this.updateStatus({
                state: "logged_in",
                account: { id: this.account },
              });
              this.qr = undefined;
              if (this.dirty || !this.baseline) {
                this.dirty = false;
                try {
                  const changes = await this.store.changes();
                  this.baseline = true;
                  for (const event of changes) {
                    this.emit(event);
                    if (event.message) this.verified.add("receive." + event.message.kind);
                  }
                } catch (e) {
                  this.dirty = true;
                  if (!(e instanceof APIError) || !["not_ready"].includes(e.code))
                    console.error(
                      "Message reconciliation:",
                      e instanceof APIError ? e.code : "failed",
                    );
                }
              }
              if (!this.sendReady) {
                const probe = await this.native("sendprobe");
                if (probe.success !== false)
                  throw new APIError(
                    "probe_failed",
                    "Native send probe did not reject invalid parameters",
                  );
                this.sendReady = true;
                console.log("Native send callback ABI validated");
              }
            } else {
              if (this.status.state === "logged_in") {
                this.loginRequested = false;
                this.sendReady = false;
              }
              this.baseline = false;
              if (!this.loginRequested && state.login?.phase === 5 && state.login?.can_resume) {
                const result = await this.native("login", "saved");
                this.loginRequested = result.queued === true;
              }
              this.updateStatus({
                state:
                  !state.login?.active ||
                  (state.login?.phase === 4 && [3, 4].includes(state.login?.request))
                    ? "signing_in"
                    : [3, 4].includes(state.login?.phase)
                      ? "awaiting_confirmation"
                      : "awaiting_scan",
              });
              if (state.login?.phase === 0 && Date.now() - this.lastQR > 4000) {
                this.lastQR = Date.now();
                await this.refreshQR();
              }
            }
          });
        } catch (e) {
          if (e instanceof APIError && e.code === "disconnected")
            this.updateStatus({ state: "disconnected" });
          else console.error("Client initialization:", e instanceof APIError ? e.code : "failed");
        } finally {
          this.tickBusy = false;
        }
      }
      await sleep(1500);
    }
  }
  async dispatch(method: string, params: Row = {}) {
    if (method === "status") return this.status;
    if (method === "login.inspect") return this.operation(() => this.native("status"));
    if (method === "capabilities")
      return {
        capabilities: [...this.verified].map((name) => ({
          name,
          status: "verified",
        })),
        sending_ready: this.sendReady,
        event_source: "native_database_write_hooks",
        direct_message_callback: "unverified",
      };
    return this.operation(async () => {
      if (method === "login.retry") {
        if (this.status.state === "logged_in") return { success: true };
        if (Date.now() - this.lastLoginRetry < 5000)
          throw new APIError("not_ready", "Please wait a few seconds before trying again");
        if (params.mode !== "saved" && params.mode !== "qr")
          throw new APIError("invalid_params", "Choose saved login or QR login");
        this.lastLoginRetry = Date.now();
        let result = await this.native("login", params.mode);
        if (!result.queued && result.reason === "qr_required")
          result = await this.native("login", "qr");
        if (!result.queued) throw new APIError("not_ready", "WeChat login is not ready yet");
        this.loginRequested = true;
        this.qr = undefined;
        this.qrAt = 0;
        this.lastQR = 0;
        return { success: true };
      }
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      if (method === "contacts") return this.store.contacts();
      if (method === "groups") return this.store.groups();
      if (method === "conversations") return this.store.conversations();
      if (method === "history") return this.store.history(params);
      if (method === "inspect_db") return this.store.inspect();
      if (method === "send") {
        if (!this.sendReady) throw new APIError("not_ready", "Sending is still initializing");
        if (params.kind !== "text")
          throw new APIError("unverified", "This message type is not yet verified");
        if (
          typeof params.chat_id !== "string" ||
          !params.chat_id ||
          params.chat_id.length > 256 ||
          typeof params.text !== "string" ||
          !params.text.trim() ||
          Buffer.byteLength(params.text) > 65536
        )
          throw new APIError(
            "invalid_params",
            "A conversation and nonempty text up to 64 KiB are required",
          );
        const response = await this.native("sendtext", params.chat_id, params.text);
        if (response.success !== true)
          throw new APIError(
            "send_failed",
            response.error_message || "WeChat rejected the message",
          );
        this.dirty = true;
        this.verified.add("send.text");
        return {
          success: true,
          message_id: response.message_id ? String(response.message_id) : undefined,
          timestamp: response.create_time ? Number(response.create_time) : undefined,
          acknowledgement: "native_handler",
        };
      }
      throw new APIError("unknown_method", "Unknown API method");
    });
  }
  async avatar(id: string) {
    return this.operation(async () => {
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      const bytes = await this.store.avatar(id),
        type = imageType(bytes);
      if (!type) throw new APIError("media_unavailable", "Unsupported profile picture format");
      return { bytes, type };
    });
  }
  async media(chat: string, id: string) {
    const message = await this.operation(async () => {
      if (this.status.state !== "logged_in")
        throw new APIError("not_ready", "WeChat is still signing in");
      const message = await this.store.message(chat, id);
      return {
        message,
        voice: message.kind === "audio" ? await this.store.voice(message) : undefined,
      };
    });
    if (message.voice) return voiceAudioProcess(message.voice);
    if (message.message.kind === "image") return receivedImage(message.message);
    if (message.message.kind === "file") return receivedFile(message.message);
    return stickerImage(message.message, join(data, "media"));
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const upload of this.uploads.values()) {
      await unlink(upload.path).catch(() => {});
      await unlink(upload.cachedPath).catch(() => {});
      if (upload.directory) await rmdir(upload.directory).catch(() => {});
    }
    this.uploads.clear();
    this.qr = undefined;
    try {
      if (this.pid && this.device) await this.device.kill(this.pid);
    } catch {}
    try {
      await this.session?.detach();
    } catch {}
    this.xvfb?.kill();
  }
}
