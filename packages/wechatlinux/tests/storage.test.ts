import { Database as SQLite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Storage } from "../src/storage";
import type { Database, NativeDB } from "../src/types";

class Fixture implements NativeDB {
  connections = new Map<string, SQLite>();
  visible: Database[] = [];
  truncated = false;
  add(name: string) {
    const db = new SQLite(":memory:", { safeIntegers: true }),
      id = String(this.connections.size + 1);
    this.connections.set(id, db);
    this.visible.push({
      id,
      path: "/fixture/db_storage/" + name,
      encrypted: true,
      readable: true,
    });
    return db;
  }
  async databases() {
    return this.visible;
  }
  async query(id: string, sql: string, limit: number) {
    sql = sql
      .replaceAll("wcdb_decompress(message_content,WCDB_CT_message_content)", "message_content")
      .replaceAll("wcdb_decompress(source,WCDB_CT_source)", "source");
    const stmt = this.connections.get(id)!.query(sql),
      rows = stmt.all() as Record<string, unknown>[];
    const value = (v: unknown) =>
      typeof v === "bigint"
        ? String(v)
        : v instanceof Uint8Array
          ? { base64: Buffer.from(v).toString("base64") }
          : v;
    return {
      columns: stmt.columnNames,
      rows: rows.slice(0, limit).map((row) => stmt.columnNames.map((c) => value(row[c]))),
      truncated: this.truncated || rows.length > limit,
    };
  }
}
function setup() {
  const native = new Fixture(),
    db = native.add("message/message_0.db"),
    chat = "test_friend",
    table = "Msg_" + createHash("md5").update(chat).digest("hex");
  db.run("CREATE TABLE Name2Id(user_name TEXT,is_session INTEGER)");
  db.run("INSERT INTO Name2Id VALUES('test_friend',1),('test_self',1)");
  db.run(
    "CREATE TABLE " +
      table +
      "(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER)",
  );
  const store = new Storage(native, () => "test_self");
  const insert = (local: number, server: bigint, text = "hello", kind = 1) =>
    db.run("INSERT INTO " + table + " VALUES(?,?,?,2,100,?,0)", [local, server, kind, text]);
  return { native, db, chat, table, store, insert };
}
test("native IDs remain exact and history identifies own messages", async () => {
  const { store, chat, insert } = setup();
  insert(1, 9223372036854775806n);
  const page = await store.history({ chat_id: chat });
  expect(page.messages[0].id).toBe("9223372036854775806");
  expect(page.messages[0].own).toBe(true);
  expect(page.messages[0].text).toBe("hello");
});
test("initial history is not replayed as live events; inserts and ID changes are emitted once", async () => {
  const { store, db, table, insert } = setup();
  expect(await store.changes()).toEqual([]);
  insert(1, 0n);
  const add = await store.changes();
  expect(add[0].type).toBe("message");
  const local = add[0].message!.id;
  db.run("UPDATE " + table + " SET server_id=9223372036854775806");
  const change = await store.changes();
  expect(change[0].type).toBe("message.updated");
  expect(change[0].data?.previous_id).toBe(local);
  expect(await store.changes()).toEqual([]);
});
test("truncated reads and unavailable shards cannot become deletions", async () => {
  const { store, native, insert } = setup();
  insert(1, 5n);
  await store.changes();
  native.truncated = true;
  await expect(store.changes()).rejects.toMatchObject({ code: "scan_limit" });
  native.truncated = false;
  native.visible = [];
  await expect(store.changes()).rejects.toMatchObject({ code: "not_ready" });
});
test("empty message database is a valid empty history", async () => {
  const { store, native, db, table, chat } = setup();
  db.run("DROP TABLE " + table);
  store.invalidate();
  expect((await store.history({ chat_id: chat })).messages).toEqual([]);
  native.visible = [];
  await expect(store.history({ chat_id: chat })).rejects.toMatchObject({
    code: "not_ready",
  });
});
test("history cursors, replies, locations and packed file types", async () => {
  const { store, chat, insert } = setup();
  insert(1, 101n, "first");
  insert(
    2,
    102n,
    "<msg><appmsg><type>57</type><title>reply</title><refermsg><svrid>9223372036854775806</svrid></refermsg></appmsg></msg>",
    49 + 57 * 4294967296,
  );
  insert(3, 103n, '<msg><location x="40" y="-73" label="Place"/></msg>', 48);
  insert(4, 104n, "<msg><appmsg><type>6</type></appmsg></msg>", 49 + 6 * 4294967296);
  const page = await store.history({ chat_id: chat, limit: 2 });
  expect(page.messages.map((m) => m.id)).toEqual(["104", "103"]);
  expect(page.messages[0].kind).toBe("file");
  expect(page.messages[1].location?.longitude).toBe(-73);
  const next = await store.history({ chat_id: chat, cursor: page.next_cursor });
  expect(next.messages[0].reply_to).toBe("9223372036854775806");
  await expect(store.history({ chat_id: chat, cursor: "bad" })).rejects.toMatchObject({
    code: "invalid_params",
  });
});
test("contacts, group roster, announcements and conversations use actual joins", async () => {
  const { native, store } = setup(),
    contact = native.add("contact/contact.db");
  contact.run("CREATE TABLE contact(id INTEGER,username TEXT,nick_name TEXT,remark TEXT)");
  contact.run(
    "INSERT INTO contact VALUES(1,'test_friend','Friend',''),(2,'test@chatroom','Group','')",
  );
  contact.run("CREATE TABLE chat_room(id INTEGER,username TEXT)");
  contact.run("INSERT INTO chat_room VALUES(10,'test@chatroom')");
  contact.run("CREATE TABLE chatroom_member(room_id INTEGER,member_id INTEGER)");
  contact.run("INSERT INTO chatroom_member VALUES(10,1)");
  contact.run("CREATE TABLE chat_room_info_detail(username_ TEXT,announcement_ TEXT)");
  contact.run("INSERT INTO chat_room_info_detail VALUES('test@chatroom','Announcement')");
  const groups = await store.groups();
  expect(groups.groups[0].members?.[0].id).toBe("test_friend");
  expect(groups.groups[0].topic).toBe("Announcement");
  const sessions = native.add("session/session.db");
  sessions.run(
    "CREATE TABLE SessionTable(username TEXT,unread_count INTEGER,last_timestamp INTEGER,is_hidden INTEGER)",
  );
  sessions.run("INSERT INTO SessionTable VALUES('test@chatroom',3,100,0)");
  expect((await store.conversations()).conversations[0]).toMatchObject({
    chat_type: "group",
    unread_count: 3,
  });
});
test("profile pictures are read from the native cache with quoted usernames", async () => {
  const { native, store } = setup(),
    db = native.add("head_image/head_image.db"),
    name = "test'avatar";
  db.run("CREATE TABLE head_image(username TEXT,image_buffer BLOB,update_time INTEGER)");
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  db.run("INSERT INTO head_image VALUES(?,?,1)", [name, image]);
  expect([...(await store.avatar(name))]).toEqual([...image]);
  await expect(store.avatar("missing' OR 1=1 --")).rejects.toMatchObject({
    code: "not_found",
  });
});
test("voice chunks join the media shard chat mapping, preserve exact IDs, and exclude another chat", async () => {
  const { native, store, chat, insert } = setup();
  insert(1, 9223372036854775806n, "<msg/>", 34);
  const db = native.add("message/media_0.db");
  db.run("CREATE TABLE Name2Id(user_name TEXT)");
  db.run("INSERT INTO Name2Id VALUES('other_chat'),('test_friend')");
  db.run(
    "CREATE TABLE VoiceInfo(chat_name_id INTEGER,create_time INTEGER,local_id INTEGER,svr_id INTEGER,voice_data BLOB,data_index INTEGER)",
  );
  db.run("INSERT INTO VoiceInfo VALUES(1,100,1,9223372036854775806,?,0)", [
    Buffer.from("wrong chat"),
  ]);
  for (const [index, value] of [
    [1, "second"],
    [0, "first"],
  ] as const)
    db.run("INSERT INTO VoiceInfo VALUES(2,100,1,9223372036854775806,?,?)", [
      Buffer.from(value),
      index,
    ]);
  const message = (await store.history({ chat_id: chat })).messages[0];
  expect((await store.voice(message)).toString()).toBe("firstsecond");
  await expect(store.voice({ ...message, chat_id: "missing' OR 1=1 --" })).rejects.toMatchObject({
    code: "media_unavailable",
  });
});
