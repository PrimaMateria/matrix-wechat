import { chmod, lstat, unlink } from "node:fs/promises";
import type { Runtime } from "./runtime";
import { type APIRequest, apiRequestSchema } from "./schemas";

const LIMIT = 8 * 1024 * 1024;
// Private diagnostics/development API on the ignored, mode-0700 state mount.
// No raw query, key export, script evaluation, or attach operation is exposed.
export async function privateAPI(runtime: Runtime, path = "/home/wechat/api.sock") {
  try {
    const s = await lstat(path);
    if (!s.isSocket() || s.uid !== process.getuid?.()) throw Error("Unsafe socket path");
    let alive = false;
    try {
      const probe = await Bun.connect({
        unix: path,
        socket: {
          data() {},
          open(s) {
            alive = true;
            s.end();
          },
          close() {},
          error() {},
        },
      });
      probe.end();
    } catch {}
    if (alive) throw Error("Private API already running");
    await unlink(path);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const buffers = new WeakMap<object, Buffer>();
  const listener = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        buffers.set(socket, Buffer.alloc(0));
      },
      data(socket, chunk) {
        let buffer = Buffer.concat([buffers.get(socket) || Buffer.alloc(0), chunk]);
        if (buffer.length > LIMIT) {
          socket.end();
          return;
        }
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          const frame = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          let request: APIRequest;
          try {
            request = apiRequestSchema.parse(JSON.parse(frame.toString()));
          } catch {
            socket.end();
            return;
          }
          void runtime
            .dispatch(request.method, request.params)
            .then((result) => {
              const response = Buffer.from(JSON.stringify({ id: request.id, result }) + "\n");
              if (response.length > LIMIT || socket.write(response) !== response.length)
                socket.end();
            })
            .catch((e) => {
              socket.write(
                JSON.stringify({
                  id: request.id,
                  error: {
                    code: e.code || "internal_error",
                    message: e.message || "Private operation failed",
                  },
                }) + "\n",
              );
            });
        }
        buffers.set(socket, buffer);
      },
      close(socket) {
        buffers.delete(socket);
      },
      error() {},
    },
  });
  await chmod(path, 0o600);
  return async () => {
    listener.stop(true);
    try {
      await unlink(path);
    } catch {}
  };
}
