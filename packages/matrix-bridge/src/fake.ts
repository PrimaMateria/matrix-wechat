import { APIError } from "../../wechatlinux/src/types";
import type { Asset, Contact, Conversation, Event, Group, HistoryPage, Message, Status, WeChatBackend } from "./backend";
import { checksum } from "./backend";

export interface Fixture {
  account: string;
  contacts: Contact[];
  groups: Group[];
  conversations: Conversation[];
  messages: Message[];
  assets?: Record<string, { base64: string; type: string; name?: string }>;
}
export class FakeBackend implements WeChatBackend {
  status: Status;
  qr?: Buffer;
  qrAt = 0;
  readonly messages: Message[];
  readonly assets = new Map<string, Asset>();
  readonly revoked: { chat: string; id: string }[] = [];
  readonly sends: { chat: string; kind: string; text?: string; reply?: string; bytes?: Buffer; name?: string }[] = [];
  private subscribers = new Set<(event: Event) => void>();
  private nextID = 9007199254740993n;
  constructor(readonly fixture: Fixture) {
    this.status = { state: "logged_in", account: { id: fixture.account } };
    this.messages = fixture.messages.map((message) => ({ ...message, account_id: fixture.account, chat_type: message.chat_id.endsWith("@chatroom") ? "group" : "direct", own: message.sender_id === fixture.account }));
    for (const [key, asset] of Object.entries(fixture.assets || {})) this.assets.set(key, { bytes: Buffer.from(asset.base64, "base64"), type: asset.type, name: asset.name });
  }
  async start() {}
  async close() {}
  async login(_mode: "saved" | "qr") {}
  async contacts() { return this.fixture.contacts; }
  async groups() { return this.fixture.groups; }
  async conversations() { return this.fixture.conversations; }
  async history(chat: string, cursor?: string, limit = 200): Promise<HistoryPage> {
    let after = 0;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (value.account !== this.fixture.account || value.chat !== chat || !Number.isInteger(value.after) || value.after < 0) throw Error();
        after = value.after;
      } catch { throw new APIError("invalid_params", "Invalid fixture cursor"); }
    }
    const all = this.messages.filter((message) => message.chat_id === chat);
    const page = all.slice(after, after + limit);
    return { messages: page, cursor: Buffer.from(JSON.stringify({ account: this.fixture.account, chat, after: after + page.length })).toString("base64url"), done: after + page.length >= all.length };
  }
  async recent(chat: string) { return this.messages.filter((message) => message.chat_id === chat).slice(-500).reverse(); }
  async revocations() { return this.revoked; }
  async media(chat: string, id: string) {
    const asset = this.assets.get(`${chat}:${id}`);
    if (!asset) throw new APIError("media_unavailable", "Fixture media is unavailable");
    return asset;
  }
  async avatar(id: string) {
    const asset = this.assets.get(`avatar:${id}`);
    if (!asset) throw new APIError("not_found", "Fixture avatar is unavailable");
    return asset;
  }
  emit(event: Event) { for (const fn of this.subscribers) fn(event); }
  add(message: Message) { this.messages.push(message); this.emit({ type: "message", account_id: this.fixture.account, chat_id: message.chat_id, message }); }
  async sendText(chat: string, text: string, reply?: string) {
    this.sends.push({ chat, kind: "text", text, reply });
    this.add({ id: String(this.nextID++), account_id: this.fixture.account, chat_id: chat, chat_type: chat.endsWith("@chatroom") ? "group" : "direct", sender_id: this.fixture.account, own: true, timestamp: Date.now() / 1000, kind: "text", text, reply_to: reply });
    return { success: true, acknowledgement: "native_handler", message_id: "0" };
  }
  private attachment(chat: string, bytes: Buffer, type: string, name: string, kind: string) {
    const id = String(this.nextID++);
    this.assets.set(`${chat}:${id}`, { bytes, type, name });
    const md5 = checksum(bytes);
    this.add({ id, account_id: this.fixture.account, chat_id: chat, chat_type: chat.endsWith("@chatroom") ? "group" : "direct", sender_id: this.fixture.account, own: true, timestamp: Date.now() / 1000, kind, media: { id, kind, name, size: bytes.length, state: "ready" }, native: { decoded_content: kind === "video" ? `<msg><videomsg md5="${md5}"/></msg>` : kind === "image" ? `<msg><img md5="${md5}"/></msg>` : `<msg><appmsg><md5>${md5}</md5></appmsg></msg>` } });
    return { success: true, acknowledgement: "native_handler" };
  }
  async sendImage(chat: string, bytes: Buffer) { this.sends.push({ chat, kind: "image", bytes }); return this.attachment(chat, bytes, "image/png", "image.png", "image"); }
  async sendFile(chat: string, bytes: Buffer, name: string) {
    this.sends.push({ chat, kind: "file", bytes, name });
    const video = bytes.subarray(4, 8).toString() === "ftyp";
    return this.attachment(chat, bytes, video ? "video/mp4" : "application/octet-stream", name, video ? "video" : "file");
  }
  onEvent(fn: (event: Event) => void) { this.subscribers.add(fn); return () => { this.subscribers.delete(fn); }; }
}
