import { expect, test } from "bun:test";
import { createHandler } from "../src/server";
import { APIError, type Event } from "../src/types";

test("file uploads preserve the filename and bytes without accepting remote origins", async () => {
  const calls: any[] = [];
  const handler = createHandler({
    status: { state: "logged_in" },
    qrAt: 0,
    onEvent: () => () => {},
    dispatch: async () => ({}),
    sendFile: async (chat, bytes, name) => {
      calls.push({ chat, bytes, name });
      return { success: true };
    },
  });
  const form = () => {
    const body = new FormData();
    body.set("chat_id", "filehelper");
    body.set("file", new File(["file content"], "report 文档.txt"));
    return body;
  };
  const request = (origin: string) =>
    new Request("http://127.0.0.1/api/send-file", {
      method: "POST",
      body: form(),
      headers: { Origin: origin },
    });
  expect((await handler(request("https://attacker.example"))).status).toBe(403);
  expect(calls).toHaveLength(0);
  expect((await handler(request("http://127.0.0.1"))).status).toBe(200);
  expect(calls[0]).toEqual({
    chat: "filehelper",
    bytes: Buffer.from("file content"),
    name: "report 文档.txt",
  });
});

test("image uploads enforce local origin and bounded multipart input before sending", async () => {
  const calls: any[] = [];
  const handler = createHandler({
    status: { state: "logged_in" },
    qrAt: 0,
    onEvent: () => () => {},
    dispatch: async () => ({}),
    sendImage: async (chat, bytes) => {
      calls.push({ chat, bytes });
      return { success: true };
    },
  });
  const form = () => {
    const f = new FormData();
    f.set("chat_id", "filehelper");
    f.set("image", new File([Uint8Array.from([137, 80, 78, 71])], "test.png"));
    return f;
  };
  const response = await handler(
    new Request("http://127.0.0.1/api/send-image", {
      method: "POST",
      body: form(),
      headers: { Origin: "http://127.0.0.1" },
    }),
  );
  expect(response.status).toBe(200);
  expect(calls[0].chat).toBe("filehelper");
  expect([...calls[0].bytes]).toEqual([137, 80, 78, 71]);
  expect(
    (
      await handler(
        new Request("http://attacker.example/api/send-image", { method: "POST", body: form() }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1/api/send-image", {
          method: "POST",
          body: form(),
          headers: { Origin: "http://attacker.example" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1/api/send-image", {
          method: "POST",
          body: "",
          headers: {
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": String(21 * 1024 * 1024),
          },
        }),
      )
    ).status,
  ).toBe(400);
  expect(calls).toHaveLength(1);
});
test("file media is served as a download, with a safely encoded native filename", async () => {
  const handler = createHandler({
    status: { state: "logged_in" },
    qrAt: 0,
    onEvent: () => () => {},
    dispatch: async () => ({}),
    media: async () => ({
      bytes: Buffer.from("document"),
      type: "application/octet-stream",
      name: "report's 文档.txt",
    }),
  });
  const r = await handler(
    new Request("http://127.0.0.1/api/media?chat_id=filehelper&message_id=123"),
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Disposition")).toContain("filename*=UTF-8''report%27s%20");
  expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await r.text()).toBe("document");
});

function setup() {
  const subscribers = new Set<(event: Event) => void>(),
    calls: any[] = [];
  const backend = {
    status: { state: "logged_in" as const },
    qrAt: 0,
    async dispatch(method: string, params: any) {
      calls.push({ method, params });
      if (method === "history" && params.limit === 0)
        throw new APIError("invalid_params", "Bad limit");
      return {
        messages: [
          {
            id: "9223372036854775806",
            text: "<script>x</script>",
            native: { secret: "private" },
          },
        ],
      };
    },
    onEvent(fn: (event: Event) => void) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
  return { handler: createHandler(backend), calls, subscribers };
}
test("HTTP history preserves exact IDs and excludes private native fields", async () => {
  const { handler, calls } = setup();
  const r = await handler(
    new Request("http://127.0.0.1/api/history?chat_id=test%40chatroom&limit=50"),
  );
  expect(r.status).toBe(200);
  expect(calls[0].params).toEqual({ chat_id: "test@chatroom", limit: 50 });
  const text = await r.text();
  expect(text).toContain("9223372036854775806");
  expect(text).not.toContain("secret");
});
test("reject DNS rebinding, foreign-origin mutations and oversized bodies", async () => {
  const { handler, calls } = setup();
  expect((await handler(new Request("http://attacker.example/api/status"))).status).toBe(403);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1/api/send", {
          method: "POST",
          headers: {
            Origin: "https://attacker.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "x".repeat(150000) }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(calls).toHaveLength(0);
});
test("sending accepts only explicit JSON POST and passes real recipient/text", async () => {
  const { handler, calls } = setup();
  expect((await handler(new Request("http://127.0.0.1/api/send"))).status).toBe(404);
  const p = { chat_id: "filehelper", kind: "text", text: "test" };
  expect(
    (
      await handler(
        new Request("http://127.0.0.1/api/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1",
          },
          body: JSON.stringify(p),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls[0]).toEqual({ method: "send", params: p });
});
test("login and logout require local JSON mutation controls", async () => {
  for (const [method, params] of [
    ["login", { mode: "qr" }],
    ["logout", {}],
  ] as const) {
    const { handler, calls } = setup();
    const request = (origin: string) =>
      new Request(`http://127.0.0.1/api/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(params),
      });
    expect((await handler(request("http://attacker.example"))).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await handler(request("http://127.0.0.1"))).status).toBe(200);
    expect(calls[0]).toEqual({ method, params });
  }
});
test("SSE uses normalized events and unsubscribes on disconnect", async () => {
  const { handler, subscribers } = setup();
  const response = await handler(new Request("http://127.0.0.1/api/events")),
    reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
  for (const fn of subscribers)
    fn({
      type: "message",
      data: { native: { secret: "private" }, message_id: "123" },
    });
  const line = new TextDecoder().decode((await reader.read()).value);
  expect(line).toContain("123");
  expect(line).not.toContain("secret");
  await reader.cancel();
  expect(subscribers.size).toBe(0);
});
