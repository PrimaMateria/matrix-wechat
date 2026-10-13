import type { Runtime } from "../../wechatlinux/src/runtime";
import type { Backend } from "../../wechatlinux/src/server";
import { APIError, publicFields } from "../../wechatlinux/src/types";
import type {
  Asset,
  Chat,
  Contact,
  Event,
  HistoryPage,
  Message,
  SendRequest,
  SendResult,
  Session,
  Status,
} from "./types";
import { Unsupported } from "./types";

export class WeChatSession implements Session {
  constructor(readonly runtime: Runtime) {}
  get status() {
    return this.runtime.status;
  }
  get qr() {
    return this.runtime.qr;
  }
  get qrAt() {
    return this.runtime.qrAt;
  }
  start() {
    return this.runtime.start();
  }
  close() {
    return this.runtime.close();
  }
  async login(mode: "saved" | "qr") {
    await this.runtime.dispatch("login.retry", { mode });
  }
  async contacts(): Promise<Contact[]> {
    return publicFields((await this.runtime.dispatch("contacts")).contacts);
  }
  async chats(): Promise<Chat[]> {
    const contacts = await this.contacts(),
      groups = publicFields((await this.runtime.dispatch("groups")).groups) as Chat[],
      conversations = (await this.runtime.dispatch("conversations")).conversations;
    const ids = await this.runtime.operation(() => this.runtime.store.bridgeChats());
    const byID = new Map(contacts.map((contact) => [contact.id, contact]));
    const all = new Set<string>([...ids, ...conversations.map((chat: { id: string }) => chat.id)]);
    return [...all].map((id) => {
      const group = groups.find((group) => group.id === id),
        contact = byID.get(id);
      return {
        id,
        name:
          group?.name ||
          contact?.name ||
          conversations.find((chat: { id: string }) => chat.id === id)?.name ||
          id,
        group: id.endsWith("@chatroom"),
        topic: group?.topic,
        members: group?.members || (contact ? [contact] : []),
      };
    });
  }
  async history(chat: string, cursor?: string, limit = 200): Promise<HistoryPage> {
    return publicFields(
      await this.runtime.operation(() => this.runtime.store.bridgeHistory(chat, cursor, limit)),
    );
  }
  media(chat: string, id: string) {
    return this.runtime.media(chat, id);
  }
  avatar(id: string) {
    return this.runtime.avatar(id);
  }
  onEvent(fn: (event: Event) => void) {
    return this.runtime.onEvent((event) => fn(publicFields(event)));
  }
  capabilities() {
    return { send: ["text", "image", "file"], replies: true, mentions: false, revoke: false };
  }
  async send(request: SendRequest): Promise<SendResult> {
    let response: any;
    if (request.kind === "text")
      response = await this.runtime.dispatch("send", {
        chat_id: request.chat,
        kind: "text",
        text: request.text,
        reply_to: request.reply_to,
      });
    else if (request.kind === "image" && request.bytes)
      response = await this.runtime.sendImage(request.chat, request.bytes);
    else if (request.kind === "file" && request.bytes)
      response = await this.runtime.sendFile(
        request.chat,
        request.bytes,
        request.name || "attachment",
      );
    else throw new Unsupported("This send type is not supported by the WeChat package");
    const id =
      response.message_id &&
      /^\d+$/.test(String(response.message_id)) &&
      String(response.message_id) !== "0"
        ? String(response.message_id)
        : undefined;
    return {
      id,
      timestamp: response.timestamp,
      acknowledgement: id ? "confirmed" : "native_handler",
    };
  }
}

// Development fixtures use the same normalized contract and never launch WeChat.
export interface Fixture {
  account: string;
  contacts: Contact[];
  chats: Chat[];
  messages: Message[];
  media?: Record<string, { base64: string; type: string; name?: string }>;
}
export class FakeSession implements Session, Backend {
  status: Status;
  qrAt = 0;
  qr?: Buffer;
  sent: SendRequest[] = [];
  private subscribers = new Set<(event: Event) => void>();
  constructor(readonly fixture: Fixture) {
    this.status = { state: "logged_in", account: { id: fixture.account } };
  }
  async start() {}
  async close() {}
  async login() {}
  async contacts() {
    return this.fixture.contacts;
  }
  async chats() {
    return this.fixture.chats;
  }
  async history(chat: string, cursor?: string, limit = 200): Promise<HistoryPage> {
    const rows = this.fixture.messages
        .filter((message) => message.chat_id === chat)
        .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
      offset = Number(cursor || 0);
    return {
      messages: rows.slice(offset, offset + limit),
      cursor: String(offset + Math.min(limit, rows.length - offset)),
      done: offset + limit >= rows.length,
    };
  }
  async media(_chat: string, id: string): Promise<Asset> {
    const asset = this.fixture.media?.[id];
    if (!asset) throw new APIError("media_unavailable", "Fixture attachment unavailable");
    return { bytes: Buffer.from(asset.base64, "base64"), type: asset.type, name: asset.name };
  }
  async avatar(): Promise<Asset> {
    throw new APIError("not_found", "No fixture avatar");
  }
  capabilities() {
    return { send: ["text", "image", "file"], replies: true, mentions: false, revoke: false };
  }
  onEvent(fn: (event: Event) => void) {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
  emit(event: Event) {
    for (const fn of this.subscribers) fn(event);
  }
  async send(request: SendRequest): Promise<SendResult> {
    this.sent.push(request);
    const id = String(100000 + this.sent.length),
      message: Message = {
        id,
        account_id: this.fixture.account,
        chat_id: request.chat,
        chat_type: request.chat.endsWith("@chatroom") ? "group" : "direct",
        sender_id: this.fixture.account,
        kind: request.kind,
        own: true,
        timestamp: Date.now() / 1000,
        text: request.text,
        reply_to: request.reply_to,
      };
    this.fixture.messages.push(message);
    queueMicrotask(() =>
      this.emit({
        type: "message",
        account_id: this.fixture.account,
        chat_id: request.chat,
        message,
      }),
    );
    return { id, acknowledgement: "confirmed", timestamp: message.timestamp };
  }
  async sendImage(chat: string, bytes: Buffer) {
    return this.send({ transaction: "web", chat, kind: "image", bytes });
  }
  async sendFile(chat: string, bytes: Buffer, name: string) {
    return this.send({ transaction: "web", chat, kind: "file", bytes, name });
  }
  async dispatch(method: string, params: Record<string, any> = {}) {
    if (method === "status") return this.status;
    if (method === "capabilities")
      return {
        capabilities: this.capabilities().send.map((kind) => ({
          name: "send." + kind,
          status: "fixture",
        })),
      };
    if (method === "contacts") return { contacts: await this.contacts() };
    if (method === "groups") return { groups: this.fixture.chats.filter((chat) => chat.group) };
    if (method === "conversations")
      return {
        conversations: this.fixture.chats.map((chat) => ({
          ...chat,
          chat_type: chat.group ? "group" : "direct",
          unread_count: 0,
          last_timestamp: 0,
        })),
      };
    if (method === "history") {
      const page = await this.history(params.chat_id, params.cursor, params.limit);
      return {
        messages: page.messages.reverse(),
        next_cursor: page.done ? undefined : page.cursor,
      };
    }
    if (method === "login.retry") return { success: true };
    if (method === "send")
      return this.send({
        transaction: "web",
        chat: params.chat_id,
        kind: "text",
        text: params.text,
      });
    throw new Unsupported("Unknown fixture method");
  }
}
