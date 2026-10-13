import { attachmentChecksum } from "../../wechatlinux/src/attachments";
import { APIError, type Contact, type Conversation, type Event, type Group, type Message, type Status } from "../../wechatlinux/src/types";

export type { Contact, Conversation, Event, Group, Message, Status };
export interface Asset { bytes: Buffer; type: string; name?: string }
export interface HistoryPage { messages: Message[]; cursor: string; done: boolean }
export interface WeChatBackend {
  status: Status;
  qr?: Buffer;
  qrAt: number;
  start(): Promise<void>;
  close(): Promise<void>;
  login(mode: "saved" | "qr"): Promise<void>;
  contacts(): Promise<Contact[]>;
  groups(): Promise<Group[]>;
  conversations(): Promise<Conversation[]>;
  history(chat: string, cursor?: string, limit?: number): Promise<HistoryPage>;
  recent(chat: string): Promise<Message[]>;
  revocations(): Promise<{ chat: string; id: string }[]>;
  media(chat: string, id: string): Promise<Asset>;
  avatar(id: string): Promise<Asset>;
  sendText(chat: string, text: string, reply?: string): Promise<unknown>;
  sendImage(chat: string, bytes: Buffer): Promise<unknown>;
  sendFile(chat: string, bytes: Buffer, name: string): Promise<unknown>;
  onEvent(fn: (event: Event) => void): () => void;
}
export function checksum(bytes: Buffer) { return new Bun.CryptoHasher("md5").update(bytes).digest("hex"); }
export function sendFingerprint(message: Message): string {
  if (message.kind === "text") return JSON.stringify(["text", message.text || "", message.reply_to || ""]);
  try { return JSON.stringify(["attachment", attachmentChecksum(message)]); } catch { return ""; }
}
export function unsupported(operation: string): never {
  throw new APIError("unsupported", `${operation} is not supported by the current WeChat runtime`);
}
export const capabilities = {
  sending: ["text", "text reply", "JPEG/PNG/GIF image", "file", "MP4 via file upload"],
  receiving: ["text", "reply", "mention", "image", "sticker/GIF", "cached video", "voice/WAV", "file", "location", "link", "system", "revocation"],
  unsupported: ["sticker sending", "voice/location sending", "native mention construction", "native revocation", "group/profile mutations", "presence", "uncached media downloads", "Matrix encryption"],
  evidence: "Implementation availability is not proof of delivery. Group sends and sustained native reception still require live acceptance.",
};

export async function nativeBackend() {
  const { Runtime } = await import("../../wechatlinux/src/runtime");
  const runtime = new Runtime();
  const backend: WeChatBackend = {
    get status() { return runtime.status; },
    get qr() { return runtime.qr; },
    get qrAt() { return runtime.qrAt; },
    start: () => runtime.start(), close: () => runtime.close(),
    login: async (mode) => { await runtime.dispatch("login.retry", { mode }); },
    contacts: async () => (await runtime.dispatch("contacts")).contacts,
    groups: async () => (await runtime.dispatch("groups")).groups,
    conversations: async () => (await runtime.dispatch("conversations")).conversations,
    history: (chat, cursor, limit = 200) => runtime.operation(() => runtime.store.bridgeHistory(chat, cursor, limit)),
    recent: (chat) => runtime.operation(() => runtime.store.bridgeRecent(chat, 500)),
    revocations: () => runtime.operation(() => runtime.store.bridgeRevocations()),
    media: (chat, id) => runtime.media(chat, id), avatar: (id) => runtime.avatar(id),
    sendText: (chat, text, reply) => runtime.dispatch("send", { chat_id: chat, kind: "text", text, reply_to: reply }),
    sendImage: (chat, bytes) => runtime.sendImage(chat, bytes),
    sendFile: (chat, bytes, name) => runtime.sendFile(chat, bytes, name),
    onEvent: (fn) => runtime.onEvent(fn),
  };
  return { backend, runtime };
}
