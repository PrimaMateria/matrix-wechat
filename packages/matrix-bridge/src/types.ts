import type { Contact, Event, Group, Message, Status } from "../../wechatlinux/src/types";

export type { Contact, Event, Group, Message, Status };
export interface Asset {
  bytes: Buffer;
  type: string;
  name?: string;
}
export interface Chat {
  id: string;
  name: string;
  group: boolean;
  topic?: string;
  members: Contact[];
}
export interface HistoryPage {
  messages: Message[];
  cursor?: string;
  done: boolean;
}
export interface SendRequest {
  transaction: string;
  chat: string;
  kind: "text" | "image" | "file";
  text?: string;
  bytes?: Buffer;
  name?: string;
  reply_to?: string;
}
export interface SendResult {
  id?: string;
  local_key?: string;
  timestamp?: number;
  acknowledgement: "confirmed" | "native_handler";
}
export interface Session {
  status: Status;
  qr?: Buffer;
  qrAt: number;
  start(): Promise<void>;
  close(): Promise<void>;
  login(mode: "saved" | "qr"): Promise<void>;
  contacts(): Promise<Contact[]>;
  chats(): Promise<Chat[]>;
  history(chat: string, cursor?: string, limit?: number): Promise<HistoryPage>;
  media(chat: string, id: string): Promise<Asset>;
  avatar(id: string): Promise<Asset>;
  send(request: SendRequest): Promise<SendResult>;
  onEvent(fn: (event: Event) => void): () => void;
  capabilities(): { send: string[]; replies: boolean; mentions: boolean; revoke: boolean };
}
export interface MatrixEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  origin_server_ts?: number;
  redacts?: string;
  content: Record<string, any>;
}
export class Unsupported extends Error {}
