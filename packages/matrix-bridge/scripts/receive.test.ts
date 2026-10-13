import { afterEach, expect, test } from "bun:test";
import { WeChatBridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import type { Matrix } from "../src/matrix";
import type { Message } from "../src/messages";
import { type MatrixEvent, Store } from "../src/store";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture() {
  const config = await loadConfig(
    new URL("../../../example-config.yaml", import.meta.url).pathname,
  );
  const store = new Store(":memory:");
  stores.push(store);
  store.addPortal("self", "contact", "!room:example.com");
  const sends: unknown[][] = [];
  let encryptionChecks = 0;
  const matrix = {
    bot: "@wechatbot:example.com",
    ownerToken: "owner-secret",
    encrypted: async () => {
      encryptionChecks++;
      return false;
    },
    send: async (...args: unknown[]) => {
      sends.push(args);
      return `$event${sends.length}`;
    },
  } as unknown as Matrix;
  const bridge = new WeChatBridge(config, {} as WeChatBridge["runtime"], matrix, store);
  bridge["connection"] = { state: "logged_in", account: { id: "self" } };
  const portal = store.portal("self", "contact")!;
  const message: Message = {
    id: "1",
    account_id: "self",
    chat_id: "contact",
    chat_type: "direct",
    sender_id: "self",
    kind: "text",
    timestamp: 12345,
    own: true,
    text: "from WeChat",
  };
  return {
    bridge,
    config,
    store,
    sends,
    portal,
    message,
    encryptionChecks: () => encryptionChecks,
  };
}

test("own WeChat messages mirror as the real owner and remain editable", async () => {
  const f = await fixture();
  await f.bridge["receive"](f.message, f.portal);
  await f.bridge["receive"]({ ...f.message, text: "updated" }, f.portal);
  expect(f.sends).toHaveLength(2);
  expect(f.sends[0][0]).toBe(f.config.bridge.owner);
  expect(f.sends[1][3]).toMatchObject({
    "m.relates_to": { rel_type: "m.replace", event_id: "$event1" },
  });
  expect(f.store.mapping("self", "contact", "1")?.sender).toBe(f.config.bridge.owner);
});

test("double-puppet echoes never enter the outgoing queue", async () => {
  const f = await fixture();
  const event: MatrixEvent = {
    event_id: "$echo",
    room_id: f.portal.room,
    sender: f.config.bridge.owner,
    type: "m.room.message",
    content: { body: "from WeChat", "fi.mau.double_puppet_source": "matrix-wechat" },
  };
  f.bridge.accept(event);
  expect(f.store.queued()).toHaveLength(0);
  f.bridge.accept({ ...event, event_id: "$user", content: { body: "from Matrix" } });
  expect(f.store.queued()).toHaveLength(1);
});

test("room encryption checks are reused during import and encryption events take effect immediately", async () => {
  const f = await fixture();
  for (let i = 0; i < 100; i++) expect(await f.bridge.usable(f.portal.room)).toBe(true);
  expect(f.encryptionChecks()).toBe(1);
  f.bridge.accept({
    event_id: "$encryption",
    room_id: f.portal.room,
    sender: "@someone:example.com",
    type: "m.room.encryption",
    state_key: "",
    content: { algorithm: "m.megolm.v1.aes-sha2" },
  });
  expect(await f.bridge.usable(f.portal.room)).toBe(false);
});
