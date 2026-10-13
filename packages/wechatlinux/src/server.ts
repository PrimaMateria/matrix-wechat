import { existsSync } from "node:fs";
import { join } from "node:path";
import { privateAPI } from "./private-api";
import { APIError, type Event, publicFields, type Row, type Status } from "./types";
export interface Backend {
  sendImage?(chat: string, bytes: Buffer): Promise<unknown>;
  sendFile?(chat: string, bytes: Buffer, name: string): Promise<unknown>;
  avatar?(id: string): Promise<{ bytes: Buffer; type: string }>;
  media?(chat: string, id: string): Promise<{ bytes: Buffer; type: string; name?: string }>;
  status: Status;
  qr?: Buffer;
  qrAt: number;
  dispatch(method: string, params?: Row): Promise<any>;
  onEvent(fn: (event: Event) => void): () => void;
}
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
};
const readMethods = new Set([
  "status",
  "capabilities",
  "contacts",
  "groups",
  "conversations",
  "history",
]);
async function readBody(request: Request, limit: number, message: string): Promise<Buffer> {
  if (Number(request.headers.get("Content-Length") || 0) > limit)
    throw new APIError("invalid_params", message);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new APIError("invalid_params", message);
      }
      chunks.push(value);
    }
  return Buffer.concat(chunks);
}
export function createHandler(backend: Backend, webRoot = join(import.meta.dir, "../dist/web")) {
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      host = request.headers.get("Host") || url.host;
    let hostname = "";
    try {
      hostname = new URL("http://" + host).hostname;
    } catch {}
    const json = (v: any, status = 200) => Response.json(publicFields(v), { status, headers });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname))
      return json({ error: { code: "invalid_host", message: "Use localhost" } }, 403);
    try {
      if (
        request.method === "POST" &&
        ["/api/send-image", "/api/send-file"].includes(url.pathname)
      ) {
        const isFile = url.pathname === "/api/send-file";
        const origin = request.headers.get("Origin");
        if (origin && new URL(origin).host !== host)
          return json({ error: { code: "invalid_origin", message: "Origin is not allowed" } }, 403);
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.startsWith("multipart/form-data;"))
          throw new APIError("invalid_params", "A multipart upload is required");
        const limit = (isFile ? 64 : 20) * 1024 * 1024 + 16384;
        const form = await new Response(
          new Uint8Array(await readBody(request, limit, "Upload is too large")),
          {
            headers: { "Content-Type": contentType },
          },
        ).formData();
        const chat = form.get("chat_id"),
          file = form.get(isFile ? "file" : "image");
        if (typeof chat !== "string" || !chat || !(file instanceof File))
          throw new APIError("invalid_params", "A conversation and attachment are required");
        if (isFile && backend.sendFile)
          return json(
            await backend.sendFile(chat, Buffer.from(await file.arrayBuffer()), file.name),
          );
        if (!backend.sendImage || isFile) throw new APIError("not_ready", "Upload is unavailable");
        return json(await backend.sendImage(chat, Buffer.from(await file.arrayBuffer())));
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        let unsubscribe = () => {},
          timer: ReturnType<typeof setInterval> | undefined;
        const encoder = new TextEncoder();
        const cleanup = () => {
          unsubscribe();
          if (timer) clearInterval(timer);
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
            unsubscribe = backend.onEvent((event) => {
              try {
                if (controller.desiredSize !== null && controller.desiredSize < 0) {
                  cleanup();
                  controller.close();
                  return;
                }
                controller.enqueue(
                  encoder.encode("data: " + JSON.stringify(publicFields(event)) + "\n\n"),
                );
              } catch {
                cleanup();
              }
            });
            timer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
              } catch {
                cleanup();
              }
            }, 10000);
            request.signal.addEventListener("abort", cleanup, { once: true });
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(stream, {
          headers: {
            ...headers,
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/avatar") {
        if (!backend.avatar) throw new APIError("not_found", "Avatar endpoint is unavailable");
        const asset = await backend.avatar(url.searchParams.get("id") || "");
        return new Response(new Uint8Array(asset.bytes), {
          headers: { ...headers, "Content-Type": asset.type },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/media") {
        if (!backend.media) throw new APIError("not_found", "Media endpoint is unavailable");
        const asset = await backend.media(
          url.searchParams.get("chat_id") || "",
          url.searchParams.get("message_id") || "",
        );
        return new Response(new Uint8Array(asset.bytes), {
          headers: {
            ...headers,
            "Content-Type": asset.type,
            ...(asset.name
              ? {
                  "Content-Disposition":
                    "attachment; filename*=UTF-8''" +
                    encodeURIComponent(asset.name).replace(
                      /['()*]/g,
                      (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
                    ),
                }
              : {}),
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/qr.png") {
        if (!backend.qr || Date.now() - backend.qrAt > 8000)
          return json(
            {
              error: { code: "qr_unavailable", message: "QR is not available" },
            },
            503,
          );
        return new Response(new Uint8Array(backend.qr), {
          headers: { ...headers, "Content-Type": "image/png" },
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/")) {
        const method = url.pathname.slice(5);
        if (!readMethods.has(method))
          return json({ error: { code: "not_found", message: "Unknown endpoint" } }, 404);
        if ([...url.searchParams].length > 8)
          throw new APIError("invalid_params", "Too many parameters");
        const params: Row = Object.fromEntries(url.searchParams);
        if (params.limit !== undefined) params.limit = Number(params.limit);
        return json(await backend.dispatch(method, params));
      }
      if (request.method === "POST" && ["/api/send", "/api/login/retry"].includes(url.pathname)) {
        const origin = request.headers.get("Origin");
        if (origin && new URL(origin).host !== host)
          return json(
            {
              error: {
                code: "invalid_origin",
                message: "Origin is not allowed",
              },
            },
            403,
          );
        if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json")
          return json({ error: { code: "invalid_params", message: "JSON is required" } }, 415);
        const body = await readBody(request, 131072, "Message is too large");
        let params: Row;
        try {
          params = JSON.parse(body.toString());
          if (!params || Array.isArray(params) || typeof params !== "object") throw Error();
        } catch {
          throw new APIError("invalid_params", "Invalid JSON request");
        }
        return json(
          await backend.dispatch(url.pathname === "/api/send" ? "send" : "login.retry", params),
        );
      }
      if (request.method === "GET" && ["/", "/app.js", "/app.css"].includes(url.pathname)) {
        const file = Bun.file(
          join(webRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1)),
        );
        if (!(await file.exists()))
          return json(
            {
              error: { code: "not_found", message: "Build output is missing" },
            },
            404,
          );
        return new Response(file, { headers });
      }
      return json({ error: { code: "not_found", message: "Unknown endpoint" } }, 404);
    } catch (e) {
      const known = e instanceof APIError;
      const code = known ? e.code : "internal_error",
        message = known ? e.message : "The local operation failed";
      return json({ error: { code, message } }, code === "invalid_params" ? 400 : 503);
    }
  };
}
async function main() {
  const { Runtime } = await import("./runtime");
  if (!existsSync("/run/.containerenv") && !existsSync("/.dockerenv"))
    throw new APIError(
      "container_required",
      "Start the container launcher; host WeChat execution is disabled",
    );
  const runtime = new Runtime(),
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 18742,
      idleTimeout: 0,
      fetch: createHandler(runtime),
    });
  const closePrivate = await privateAPI(runtime);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await closePrivate();
    await runtime.close();
    await server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  try {
    await runtime.start();
    console.log("Web: http://127.0.0.1:18742/");
  } catch (e) {
    console.error(e instanceof APIError ? e.code : "startup_failed");
    await closePrivate();
    await runtime.close();
    await server.stop(true);
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
