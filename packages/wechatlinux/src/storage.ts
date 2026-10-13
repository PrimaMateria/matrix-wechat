import { createHash } from "node:crypto";
import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  APIError,
  type Contact,
  type Database,
  type Event,
  type Group,
  type Message,
  type NativeDB,
  type Row,
} from "./types";
export const identifier = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const num = (v: any) => Number(v) || 0;
const md5 = (v: string) => createHash("md5").update(v).digest("hex");
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  processEntities: false,
});
function xml(value: any): Row | undefined {
  if (typeof value !== "string" || value.length > 2097152 || /<!DOCTYPE|<!ENTITY/i.test(value))
    return;
  try {
    return xmlParser.parse(value);
  } catch {
    return;
  }
}
export class Storage {
  private schema = new Map<string, Map<string, string[]>>();
  private snapshot: Map<string, Message> | undefined;
  private snapshotAccount = "";
  private paths = new Set<string>();
  private revokes = new Map<string, Row>();
  constructor(
    private native: NativeDB,
    private account: () => string,
  ) {}
  invalidate() {
    this.schema.clear();
  }
  async databases() {
    const dbs = (await this.native.databases()).filter((d) => d.readable);
    if (!dbs.length) throw new APIError("not_ready", "Account data is still opening");
    return dbs;
  }
  async query(db: Database, sql: string, limit = 50000): Promise<Row[]> {
    const r = await this.native.query(db.id, sql, limit + 1);
    if (r.truncated || r.rows.length > limit)
      throw new APIError("scan_limit", "Read exceeded the safety limit");
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  }
  async tables(db: Database) {
    const cached = this.schema.get(db.path);
    if (cached) return cached;
    const map = new Map<string, string[]>();
    for (const row of await this.query(
      db,
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )) {
      if (/virtual table/i.test(row.sql || "") || /fts/i.test(row.name)) continue;
      map.set(
        row.name,
        (await this.query(db, "PRAGMA table_info(" + identifier(row.name) + ")")).map(
          (r) => r.name,
        ),
      );
    }
    this.schema.set(db.path, map);
    return map;
  }
  async inspect() {
    const out = [];
    for (const d of await this.databases())
      out.push({
        ...d,
        tables: [...(await this.tables(d))].map(([name, columns]) => ({
          name,
          columns,
        })),
      });
    return { databases: out };
  }
  async contacts() {
    const out = new Map<string, Contact>();
    let recognized = false;
    for (const d of await this.databases()) {
      if (!basename(d.path).startsWith("contact")) continue;
      for (const [t, c] of await this.tables(d)) {
        const username = c.includes("username")
          ? "username"
          : c.includes("user_name")
            ? "user_name"
            : "";
        if (!username || !(c.includes("nick_name") || c.includes("remark"))) continue;
        recognized = true;
        for (const r of await this.query(d, "SELECT * FROM " + identifier(t))) {
          if (typeof r[username] !== "string" || !r[username]) continue;
          out.set(r[username], {
            id: r[username],
            name: r.remark || r.nick_name || "",
            avatar: r.big_head_url || r.small_head_url || undefined,
            native: r,
          });
        }
      }
    }
    if (!recognized) throw new APIError("not_ready", "Contacts are still opening");
    return { contacts: [...out.values()] };
  }
  async groups() {
    const { contacts } = await this.contacts();
    const groups = new Map<string, Group>(
      contacts.filter((c) => c.id.endsWith("@chatroom")).map((c) => [c.id, { ...c, members: [] }]),
    );
    const byID = new Map(
      contacts.filter((c) => c.native?.id).map((c) => [String(c.native!.id), c]),
    );
    for (const d of await this.databases()) {
      if (!basename(d.path).startsWith("contact")) continue;
      const tables = await this.tables(d);
      const rooms = new Map<string, string>();
      if (tables.has("chat_room"))
        for (const r of await this.query(d, "SELECT * FROM chat_room")) {
          rooms.set(String(r.id), r.username);
          if (!groups.has(r.username))
            groups.set(r.username, { id: r.username, name: "", members: [] });
          groups.get(r.username)!.native = {
            ...groups.get(r.username)!.native,
            room: r,
          };
        }
      if (tables.has("chat_room_info_detail"))
        for (const r of await this.query(d, "SELECT * FROM chat_room_info_detail")) {
          const g = groups.get(r.username_);
          if (g) {
            g.topic = r.announcement_ || "";
            g.native = { ...g.native, detail: r };
          }
        }
      if (tables.has("chatroom_member"))
        for (const r of await this.query(d, "SELECT * FROM chatroom_member")) {
          const g = groups.get(rooms.get(String(r.room_id)) || ""),
            m = byID.get(String(r.member_id));
          if (g && m) g.members!.push(m);
        }
    }
    return { groups: [...groups.values()] };
  }
  async conversations() {
    let recognized = false;
    const conversations = [];
    for (const d of await this.databases()) {
      if (basename(d.path) !== "session.db") continue;
      const tables = await this.tables(d);
      if (!tables.has("SessionTable")) continue;
      recognized = true;
      for (const r of await this.query(d, "SELECT * FROM SessionTable"))
        if (r.username && !num(r.is_hidden))
          conversations.push({
            id: r.username,
            chat_type: r.username.endsWith("@chatroom") ? ("group" as const) : ("direct" as const),
            unread_count: num(r.unread_count),
            last_timestamp: num(r.sort_timestamp || r.last_timestamp),
          });
    }
    if (!recognized) throw new APIError("not_ready", "Conversations are still opening");
    return { conversations };
  }
  private normalize(
    d: Database,
    t: string,
    row: Row,
    names: Map<string, string>,
    chat: string,
  ): [string, Message] {
    const r = { ...row };
    const decoded = r.__decoded,
      source = r.__source;
    delete r.__decoded;
    delete r.__source;
    const key = JSON.stringify([d.path, t, String(r.local_id)]);
    const server = String(r.server_id || "0");
    const sender = names.get(String(r.real_sender_id)) || "";
    const type = num(r.local_type) % 4294967296;
    const kind: Record<number, string> = {
      1: "text",
      3: "image",
      34: "audio",
      43: "video",
      47: "sticker",
      48: "location",
      10000: "system",
      10002: "system",
    };
    const content = typeof decoded === "string" ? decoded : r.message_content;
    const readable =
      typeof content === "string" &&
      (!num(r.WCDB_CT_message_content) || typeof decoded === "string");
    const m: Message = {
      local_key: digest(key),
      id: server !== "0" ? server : "local:" + digest(key),
      account_id: this.account(),
      chat_id: chat,
      chat_type: chat.endsWith("@chatroom") ? "group" : "direct",
      sender_id: sender,
      kind: kind[type] || "unknown",
      timestamp: num(r.create_time),
      own: !!sender && sender === this.account(),
      native: {
        database: d.path,
        table: t,
        row: r,
        local_id: String(r.local_id),
        content_decoded: readable,
        decoded_content: readable ? content : undefined,
        sender_resolved: !!sender,
      },
    };
    if (["text", "system"].includes(m.kind) && readable) m.text = content;
    const root = readable ? xml(content) : undefined;
    const app = root?.msg?.appmsg || root?.appmsg;
    if (type === 49 && app) {
      if (String(app.type) === "6") m.kind = "file";
      if (String(app.type) === "57") {
        m.kind = "text";
        m.text = app.title || "";
        if (app.refermsg?.svrid) m.reply_to = String(app.refermsg.svrid);
      }
    }
    const location = root?.msg?.location || root?.location;
    if (m.kind === "location" && location) {
      const latitude = Number(location.x),
        longitude = Number(location.y);
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
      )
        m.location = { latitude, longitude, label: location.label || "" };
    }
    const src = typeof source === "string" ? source : !num(r.WCDB_CT_source) ? r.source : undefined;
    const mentions = xml(src)?.msgsource?.atuserlist;
    if (typeof mentions === "string" && mentions) m.mentions = mentions.split(",").filter(Boolean);
    if (["image", "sticker", "video", "audio", "file"].includes(m.kind))
      m.media = { id: m.id, kind: m.kind, state: "pending" };
    return [key, m];
  }
  private async messages(chatFilter?: string) {
    const out = new Map<string, Message>(),
      paths = new Set<string>();
    let foundDB = false;
    for (const d of await this.databases()) {
      if (!/^message_\d+\.db$/.test(basename(d.path))) continue;
      foundDB = true;
      paths.add(d.path);
      const tables = await this.tables(d),
        names = new Map<string, string>();
      if (tables.has("Name2Id"))
        for (const r of await this.query(d, "SELECT rowid AS __id,* FROM Name2Id"))
          names.set(String(r.__id), r.user_name);
      const chats = new Map([...names.values()].map((n) => ["msg_" + md5(n), n]));
      for (const [t, c] of tables) {
        if (!t.toLowerCase().startsWith("msg_")) continue;
        if (chatFilter && t.toLowerCase() !== "msg_" + md5(chatFilter)) continue;
        if (
          !["local_id", "real_sender_id", "create_time", "local_type", "message_content"].every(
            (k) => c.includes(k),
          )
        )
          throw new APIError("unsupported_schema", "Unsupported message schema");
        const chat = chats.get(t.toLowerCase());
        if (!chat) throw new APIError("not_ready", "Conversation mapping is still opening");
        let projection = "*";
        if (c.includes("WCDB_CT_message_content"))
          projection += ",wcdb_decompress(message_content,WCDB_CT_message_content) AS __decoded";
        if (c.includes("WCDB_CT_source"))
          projection += ",wcdb_decompress(source,WCDB_CT_source) AS __source";
        for (const row of await this.query(d, "SELECT " + projection + " FROM " + identifier(t))) {
          const [key, message] = this.normalize(d, t, row, names, chat);
          out.set(key, message);
        }
      }
    }
    if (!foundDB) throw new APIError("not_ready", "Message history is still opening");
    return { messages: out, paths };
  }
  async history(params: Row) {
    const chat = params.chat_id,
      limit = params.limit ?? 50;
    if (typeof chat !== "string" || !chat || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new APIError("invalid_params", "A chat and limit between 1 and 500 are required");
    let rows = [
      ...new Map([...(await this.messages(chat)).messages.values()].map((m) => [m.id, m])).values(),
    ].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
    if (params.cursor) {
      let c: Row;
      try {
        c = JSON.parse(Buffer.from(params.cursor, "base64").toString());
        if (c.chat_id !== chat || typeof c.timestamp !== "number" || typeof c.id !== "string")
          throw Error();
      } catch {
        throw new APIError("invalid_params", "Invalid history cursor");
      }
      rows = rows.filter(
        (m) =>
          m.timestamp < c.timestamp ||
          (m.timestamp === c.timestamp && m.id.localeCompare(c.id) < 0),
      );
    }
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      messages: page,
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                chat_id: chat,
                timestamp: last.timestamp,
                id: last.id,
              }),
            ).toString("base64")
          : undefined,
    };
  }
  async avatar(id: string) {
    if (!id || id.length > 256)
      throw new APIError("invalid_params", "A user or conversation is required");
    for (const db of await this.databases()) {
      if (basename(db.path) !== "head_image.db") continue;
      const rows = await this.query(
        db,
        "SELECT image_buffer FROM head_image WHERE username=" +
          literal(id) +
          " ORDER BY update_time DESC LIMIT 1",
        1,
      );
      const blob = rows[0]?.image_buffer;
      if (blob?.base64) {
        const bytes = Buffer.from(blob.base64, "base64");
        if (bytes.length && bytes.length <= 5 * 1024 * 1024) return bytes;
      }
    }
    throw new APIError("not_found", "Profile picture is not cached yet");
  }
  async message(chat: string, id: string) {
    if (!chat || !id || chat.length > 256 || id.length > 256)
      throw new APIError("invalid_params", "A conversation and message are required");
    const message = [...(await this.messages(chat)).messages.values()].find((m) => m.id === id);
    if (!message) throw new APIError("not_found", "Message not found");
    return message;
  }
  async voice(message: Message) {
    if (message.kind !== "audio")
      throw new APIError("invalid_params", "A voice message is required");
    for (const db of await this.databases()) {
      if (!/^media_\d+\.db$/.test(basename(db.path))) continue;
      const tables = await this.tables(db);
      if (!tables.has("VoiceInfo") || !tables.has("Name2Id")) continue;
      const names = await this.query(
        db,
        "SELECT rowid AS id FROM Name2Id WHERE user_name=" + literal(message.chat_id),
        1,
      );
      if (!names.length) continue;
      const exact = message.id.startsWith("local:")
        ? "local_id=" +
          literal(message.native!.local_id) +
          " AND create_time=" +
          literal(String(message.timestamp))
        : "svr_id=" + literal(message.id);
      const rows = await this.query(
        db,
        "SELECT voice_data,data_index FROM VoiceInfo WHERE chat_name_id=" +
          literal(String(names[0].id)) +
          " AND " +
          exact +
          " ORDER BY data_index",
        128,
      );
      if (!rows.length) continue;
      const chunks = rows.map((r) => Buffer.from(r.voice_data?.base64 || "", "base64"));
      if (chunks.some((b) => !b.length) || chunks.reduce((n, b) => n + b.length, 0) > 1024 * 1024)
        throw new APIError("media_unavailable", "Voice recording is incomplete or too large");
      return Buffer.concat(chunks);
    }
    throw new APIError("media_unavailable", "Voice recording is not downloaded yet");
  }
  private async revoked() {
    const out = new Map<string, Row>();
    for (const d of await this.databases()) {
      if (basename(d.path) !== "general.db" || !(await this.tables(d)).has("revokemessage"))
        continue;
      for (const r of await this.query(d, "SELECT * FROM revokemessage"))
        if (r.to_user_name && r.svr_id && r.svr_id !== "0")
          out.set(JSON.stringify([r.to_user_name, r.svr_id, r.revoke_time]), r);
    }
    return out;
  }
  async changes(): Promise<Event[]> {
    const { messages: now, paths } = await this.messages(),
      revoked = await this.revoked();
    const events: Event[] = [];
    const same = this.snapshotAccount === this.account();
    if (this.snapshot && same) {
      for (const p of this.paths)
        if (!paths.has(p))
          throw new APIError("not_ready", "A message shard is temporarily unavailable");
      const previousIDs = new Map(
        [...this.snapshot.values()]
          .filter((m) => !m.id.startsWith("local:"))
          .map((m) => [m.chat_id + "\0" + m.id, m]),
      );
      const emitted = new Set<string>();
      for (const [key, m] of now) {
        const old = this.snapshot.get(key) || previousIDs.get(m.chat_id + "\0" + m.id),
          id = m.chat_id + "\0" + m.id;
        if (JSON.stringify(old) === JSON.stringify(m) || emitted.has(id)) continue;
        events.push({
          type: old ? "message.updated" : "message",
          account_id: this.account(),
          chat_id: m.chat_id,
          message: m,
          ...(old && old.id !== m.id ? { data: { previous_id: old.id } } : {}),
        });
        emitted.add(id);
      }
      const ids = new Set([...now.values()].map((m) => m.chat_id + "\0" + m.id));
      for (const [key, m] of this.snapshot)
        if (!now.has(key) && !ids.has(m.chat_id + "\0" + m.id))
          events.push({
            type: "message.deleted",
            account_id: this.account(),
            chat_id: m.chat_id,
            data: { message_id: m.id, reason: "storage_disappearance" },
          });
      for (const [key, r] of revoked)
        if (!this.revokes.has(key))
          events.push({
            type: "message.revoked",
            account_id: this.account(),
            chat_id: r.to_user_name,
            data: { message_id: String(r.svr_id) },
          });
    }
    this.snapshot = now;
    this.paths = paths;
    this.snapshotAccount = this.account();
    this.revokes = revoked;
    return events;
  }
}
