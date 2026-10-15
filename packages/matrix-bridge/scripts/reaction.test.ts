import { afterEach, expect, test } from "bun:test";
import { WeChatBridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import { outgoing } from "../src/convert";
import type { Matrix } from "../src/matrix";
import type { Message } from "../src/messages";
import { type MatrixEvent, Store } from "../src/store";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(emoji = "👍🏽") {
  const config = await loadConfig(
      new URL("../../../example-config.yaml", import.meta.url).pathname,
    ),
    store = new Store(":memory:");
  stores.push(store);
  store.addPortal("self", "contact", "!room:example.com");
  const original: Message = {
    id: "1234567890123456789",
    account_id: "self",
    chat_id: "contact",
    chat_type: "direct",
    sender_id: "contact",
    kind: "text",
    timestamp: Date.now() / 1000,
    own: false,
    text: "react to this",
  };
  store.saveMapping(original, "$original", "@ghost:example.com", "original");
  const calls: Record<string, unknown>[] = [],
    notices: unknown[][] = [];
  const runtime = {
    rpc: {
      recent: { query: async () => [original] },
      send: {
        mutate: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { success: true };
        },
      },
    },
  } as unknown as WeChatBridge["runtime"];
  const matrix = {
    encrypted: async () => false,
    send: async (...args: unknown[]) => notices.push(args),
  } as unknown as Matrix;
  const bridge = new WeChatBridge(config, runtime, matrix, store);
  bridge["connection"] = { state: "logged_in", account: { id: "self" } };
  const event: MatrixEvent = {
    event_id: "$reaction",
    room_id: "!room:example.com",
    sender: config.bridge.owner,
    type: "m.reaction",
    content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$original", key: emoji } },
  };
  return { bridge, store, original, calls, notices, event };
}

test("a reaction sends an exact quoted emoji reply and confirms delivery without echoing it", async () => {
  const f = await fixture();
  f.bridge.accept(f.event);
  await f.bridge["jobs"]();
  expect(f.calls).toEqual([
    { chat_id: "contact", kind: "text", text: "👍🏽", reply_to: f.original.id },
  ]);
  expect(f.store.pending("self", "contact")[0]).toMatchObject({
    id: "$reaction",
    state: "submitted",
    fingerprint: JSON.stringify(["text", "👍🏽", f.original.id]),
  });
  const echo: Message = {
    ...f.original,
    id: "2234567890123456789",
    own: true,
    sender_id: "self",
    text: "👍🏽",
    reply_to: f.original.id,
  };
  await f.bridge["confirmPending"]("contact", [f.original, echo]);
  expect(
    f.store.get<{ state: string }>("SELECT state FROM inbox WHERE id=?", f.event.event_id),
  ).toEqual({ state: "delivered" });
  expect(await f.bridge["receive"](echo, f.store.portal("self", "contact")!)).toBe(true);
  f.bridge.accept(f.event);
  await f.bridge["jobs"]();
  expect(f.calls).toHaveLength(1);
  expect(f.notices).toHaveLength(0);
});

test("reaction keys preserve joined emoji, variation selectors, flags and keycaps", () => {
  for (const key of ["👩🏽‍💻", "❤️", "🇨🇦", "1️⃣"])
    expect(
      outgoing(
        { "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key } },
        "m.reaction",
      ),
    ).toEqual({ kind: "text", text: key, reply: "$target" });
});

test("reaction targets cannot resolve through another chat or account", async () => {
  const f = await fixture();
  f.store.run("DELETE FROM messages");
  f.store.saveMapping(
    { ...f.original, chat_id: "elsewhere" },
    "$original",
    "@ghost:example.com",
    "other",
  );
  f.store.saveMapping(
    { ...f.original, account_id: "other" },
    "$original",
    "@ghost:example.com",
    "other",
  );
  f.bridge.accept(f.event);
  await f.bridge["jobs"]();
  expect(f.calls).toHaveLength(0);
  expect(f.notices[0][3]).toMatchObject({
    body: expect.stringContaining("no confirmed WeChat server ID"),
  });
});

test("disconnected reactions wait for login and send once after recovery", async () => {
  const f = await fixture();
  f.bridge["connection"] = { state: "disconnected" };
  f.bridge.accept(f.event);
  await f.bridge["jobs"]();
  await f.bridge["jobs"]();
  expect(f.calls).toHaveLength(0);
  expect(f.store.queued()).toHaveLength(1);
  expect(f.notices).toHaveLength(1);
  f.bridge["connection"] = { state: "logged_in", account: { id: "self" } };
  await f.bridge["jobs"]();
  await f.bridge["jobs"]();
  expect(f.calls).toHaveLength(1);
});

test("malformed reaction relations fail before a native send", () => {
  for (const relation of [
    null,
    { rel_type: "m.replace", event_id: "$target", key: "👍" },
    { rel_type: "m.annotation", event_id: "", key: "👍" },
    { rel_type: "m.annotation", event_id: "$target", key: " " },
    { rel_type: "m.annotation", event_id: "$target", key: 42 },
  ])
    expect(() => outgoing({ "m.relates_to": relation }, "m.reaction")).toThrow(
      "A reaction requires",
    );
});
