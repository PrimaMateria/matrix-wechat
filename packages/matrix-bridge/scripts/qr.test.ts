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
      logout: {
        mutate: async () => {
          snapshot.status.state = "awaiting_scan";
          return { success: true as const };
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

test("login prompt requests phone confirmation and never posts a QR", async () => {
  const f = await fixture();
  await f.bridge["command"](f.event, "login prompt");
  expect(f.logins).toEqual([{ mode: "prompt" }]);
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

test("a login outage sends one logout notice and one recovery notice across polls and restarts", async () => {
  const f = await fixture();
  f.snapshot.status.state = "logged_in";
  await f.bridge["status"]();
  f.snapshot.status.state = "logging_out";
  await f.bridge["status"]();
  expect(f.sends).toHaveLength(0);
  for (const state of ["awaiting_confirmation", "signing_in", "awaiting_scan"]) {
    f.snapshot.status.state = state;
    await f.bridge["status"]();
  }
  const restarted = new WeChatBridge(
    f.bridge.config,
    f.bridge.runtime,
    f.bridge.matrix,
    f.bridge.store,
  );
  restarted["management"] = f.event.room_id;
  await restarted["status"]();
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0][3]).toMatchObject({ body: expect.stringContaining("WeChat logged out") });
  f.snapshot.status.state = "logged_in";
  await restarted["status"]();
  await restarted["status"]();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1][3]).toMatchObject({ body: expect.stringContaining("WeChat logged in") });
  expect(f.logins).toHaveLength(0);
  expect(f.uploads).toHaveLength(0);
});

test("logout posts one owner notice after confirmation, and a failed logout posts none", async () => {
  const f = await fixture();
  f.snapshot.status.state = "logged_in";
  await f.bridge["status"]();
  let complete: () => void = () => {};
  const confirmed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.bridge.runtime.rpc.logout.mutate = async () => {
    f.snapshot.status.state = "logging_out";
    await confirmed;
    f.snapshot.status.state = "awaiting_scan";
    return { success: true };
  };
  const request = f.bridge["command"](f.event, "logout");
  await f.bridge["status"]();
  expect(f.sends).toHaveLength(0);
  complete();
  await request;
  await f.bridge["status"]();
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0][1]).toBe(f.event.room_id);
  expect(f.sends[0][3]).toMatchObject({ body: expect.stringContaining("WeChat logged out") });

  f.snapshot.status.state = "logged_in";
  await f.bridge["status"]();
  const notices = f.sends.length;
  f.bridge.runtime.rpc.logout.mutate = async () => {
    f.snapshot.status.state = "logging_out";
    await f.bridge["status"]();
    f.snapshot.status.state = "logged_in";
    throw Error("WeChat did not confirm logout");
  };
  await expect(f.bridge["command"](f.event, "logout")).rejects.toThrow("did not confirm logout");
  await f.bridge["status"]();
  expect(f.sends).toHaveLength(notices);
});
