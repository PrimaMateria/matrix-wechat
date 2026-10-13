import { afterEach, expect, test } from "bun:test";
import { WeChatBridge } from "../src/bridge";
import { loadConfig } from "../src/config";
import type { Matrix } from "../src/matrix";
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
  const snapshot = { status: { state: "awaiting_scan" }, qrAt: 1, qrAvailable: true };
  const logins: { mode: string }[] = [];
  const uploads: Buffer[] = [];
  const sends: unknown[][] = [];
  const runtime = {
    rpc: {
      status: { query: async () => snapshot },
      login: {
        mutate: async (input: { mode: string }) => {
          logins.push(input);
        },
      },
    },
    asset: async () => ({ bytes: Buffer.from("QR image") }),
  } as unknown as WeChatBridge["runtime"];
  const matrix = {
    encrypted: async () => false,
    upload: async (asset: { bytes: Buffer }) => {
      uploads.push(asset.bytes);
      return "mxc://example.com/qr";
    },
    send: async (...args: unknown[]) => {
      sends.push(args);
    },
  } as unknown as Matrix;
  const bridge = new WeChatBridge(config, runtime, matrix, store);
  bridge["management"] = "!management:example.com";
  const event: MatrixEvent = {
    event_id: "$command",
    room_id: "!management:example.com",
    sender: config.bridge.owner,
    type: "m.room.message",
    content: {},
  };
  return { bridge, snapshot, logins, uploads, sends, event };
}

test("polling never initiates login or posts QR images and connection notices", async () => {
  const f = await fixture();
  for (const state of ["awaiting_scan", "awaiting_confirmation", "signing_in", "awaiting_scan"]) {
    f.snapshot.status.state = state;
    f.snapshot.qrAt++;
    await f.bridge["status"]();
  }
  expect(f.logins).toHaveLength(0);
  expect(f.uploads).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
});

test("login qr sends one image only in response to that command", async () => {
  const f = await fixture();
  await f.bridge["command"](f.event, "login qr");
  for (let i = 0; i < 3; i++) {
    f.snapshot.qrAt++;
    await f.bridge["status"]();
  }
  expect(f.logins).toEqual([{ mode: "qr" }]);
  expect(f.uploads).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0][3]).toMatchObject({ msgtype: "m.image" });
});

test("login prompt requests saved-account approval and never posts a QR", async () => {
  const f = await fixture();
  await f.bridge["command"](f.event, "login prompt");
  expect(f.logins).toEqual([{ mode: "saved" }]);
  expect(f.uploads).toHaveLength(0);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0][3]).toMatchObject({ msgtype: "m.notice" });
});

test("login commands do not request another login for an active session", async () => {
  const f = await fixture();
  f.snapshot.status.state = "logged_in";
  await f.bridge["command"](f.event, "login qr");
  expect(f.logins).toHaveLength(0);
  expect(f.uploads).toHaveLength(0);
  expect(f.sends[0][3]).toMatchObject({ body: "WeChat is already logged in." });
});
