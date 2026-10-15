import { afterEach, expect, test } from "bun:test";
import { APIError } from "wechat-rpc";
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

test("failed login commands finish with their real error and never retry as outgoing messages", async () => {
  const f = await fixture();
  f.bridge.runtime.rpc.login.mutate = async (input) => {
    f.logins.push(input);
    throw new APIError("not_ready", "WeChat cannot request phone confirmation. Use login qr.");
  };
  f.bridge.store.accept({ ...f.event, content: { msgtype: "m.text", body: "login" } });
  await f.bridge["jobs"]();
  await f.bridge["jobs"]();
  expect(f.logins).toEqual([{ mode: "prompt" }]);
  expect(
    f.bridge.store.get<{ state: string }>("SELECT state FROM inbox WHERE id=?", f.event.event_id),
  ).toEqual({ state: "failed" });
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0][3]).toMatchObject({
    body: "Unable to bridge: WeChat cannot request phone confirmation. Use login qr.",
  });
});

test("login commands bypass a full disconnected message backlog", async () => {
  const f = await fixture();
  const portalRoom = "!portal:example.com";
  f.bridge.store.run(
    "INSERT INTO portals(account,chat,room) VALUES(?,?,?)",
    "self",
    "friend",
    portalRoom,
  );
  for (let i = 0; i < 120; i++)
    f.bridge.store.accept({
      ...f.event,
      event_id: `$backlog-${i}`,
      room_id: portalRoom,
      content: { msgtype: "m.text", body: `pending message ${i}` },
    });
  f.bridge.store.accept({ ...f.event, content: { msgtype: "m.text", body: "login qr" } });
  await f.bridge["jobs"]();
  expect(f.logins).toEqual([{ mode: "qr" }]);
  expect(f.uploads).toHaveLength(1);
  expect(
    f.bridge.store.get<{ state: string }>("SELECT state FROM inbox WHERE id=?", f.event.event_id),
  ).toEqual({ state: "done" });
  expect(
    f.bridge.store.get<{ total: number }>(
      "SELECT count(*) AS total FROM inbox WHERE state='queued'",
    ),
  ).toEqual({ total: 120 });
});

test("prefixed commands in portals also bypass the backlog and fail once", async () => {
  const f = await fixture();
  const portalRoom = "!portal:example.com";
  f.bridge.store.run(
    "INSERT INTO portals(account,chat,room) VALUES(?,?,?)",
    "self",
    "friend",
    portalRoom,
  );
  for (let i = 0; i < 110; i++)
    f.bridge.store.accept({
      ...f.event,
      event_id: `$backlog-${i}`,
      room_id: portalRoom,
      content: { msgtype: "m.text", body: "pending" },
    });
  f.bridge.runtime.rpc.login.mutate = async (input) => {
    f.logins.push(input);
    throw new APIError("not_ready", "Choose QR login");
  };
  f.bridge.store.accept({
    ...f.event,
    room_id: portalRoom,
    content: { msgtype: "m.text", body: `${f.bridge.config.bridge.command_prefix} login` },
  });
  await f.bridge["jobs"]();
  await f.bridge["jobs"]();
  expect(f.logins).toEqual([{ mode: "prompt" }]);
  expect(
    f.bridge.store.get<{ state: string }>("SELECT state FROM inbox WHERE id=?", f.event.event_id),
  ).toEqual({ state: "failed" });
});

test("a login outage sends one connection notice and one recovery notice across polls and restarts", async () => {
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
  expect(f.sends[0][3]).toMatchObject({ body: expect.stringContaining("WeChat connection lost") });
  f.snapshot.status.state = "logged_in";
  await restarted["status"]();
  await restarted["status"]();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1][3]).toMatchObject({
    body: expect.stringContaining("WeChat connection restored"),
  });
  expect(f.logins).toHaveLength(0);
  expect(f.uploads).toHaveLength(0);
});

test("a runtime crash reports connection loss once without claiming logout or initiating login", async () => {
  const f = await fixture();
  f.snapshot.status.state = "logged_in";
  await f.bridge["status"]();
  const query = f.bridge.runtime.rpc.status.query;
  f.bridge.runtime.rpc.status.query = async () => {
    throw Error("Runtime unavailable");
  };
  await expect(f.bridge["status"]()).rejects.toThrow("Runtime unavailable");
  await expect(f.bridge["status"]()).rejects.toThrow("Runtime unavailable");
  f.bridge.runtime.rpc.status.query = query;
  for (const state of ["starting", "awaiting_confirmation"]) {
    f.snapshot.status.state = state;
    await f.bridge["status"]();
  }
  expect(f.sends).toHaveLength(1);
  const body = (f.sends[0][3] as { body: string }).body;
  expect(body).toContain("connection lost");
  expect(body).not.toContain("logged out");
  expect(f.logins).toHaveLength(0);
  f.snapshot.status.state = "logged_in";
  await f.bridge["status"]();
  expect(f.sends).toHaveLength(2);
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
test("portal sending permissions restore exactly after logout, recovery and membership changes", async () => {
  const f = await fixture();
  const levels = new Map<string, Record<string, any>>();
  for (const chat of ["contact", "room@chatroom"]) {
    const room = `!${chat}:example.com`;
    f.bridge.store.addPortal("self", chat, room);
    levels.set(room, {
      users: { [f.bridge.config.bridge.owner]: 17, "@other:example.com": 2 },
      events: { "m.room.message": 0 },
    });
  }
  f.bridge.matrix.powerLevels = async (room, content) => {
    if (content) levels.set(room, structuredClone(content));
    return structuredClone(levels.get(room)!);
  };
  Object.assign(f.snapshot.status, { state: "logged_in", account: { id: "self" } });
  await f.bridge["status"]();
  f.snapshot.status.state = "logging_out";
  await f.bridge["status"]();
  for (const level of levels.values())
    expect(level.users).toMatchObject({
      [f.bridge.config.bridge.owner]: -1,
      "@other:example.com": 2,
    });
  f.snapshot.status.state = "logged_in";
  await f.bridge["status"]();
  for (const level of levels.values()) expect(level.users[f.bridge.config.bridge.owner]).toBe(17);
  f.bridge["groups"].set("room@chatroom", { id: "room@chatroom", name: "Group", joined: false });
  await f.bridge["status"]();
  expect(levels.get("!room@chatroom:example.com")!.users[f.bridge.config.bridge.owner]).toBe(-1);
  expect(levels.get("!contact:example.com")!.users[f.bridge.config.bridge.owner]).toBe(17);
  f.bridge["groups"].get("room@chatroom")!.joined = true;
  await f.bridge["status"]();
  expect(levels.get("!room@chatroom:example.com")!.users[f.bridge.config.bridge.owner]).toBe(17);
});
