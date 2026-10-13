export type Row = Record<string, any>;
export interface Database {
  id: string;
  path: string;
  readable: boolean;
  encrypted: boolean;
  error?: string;
}
export interface NativeDB {
  databases(): Promise<Database[]>;
  query(
    id: string,
    sql: string,
    limit: number,
  ): Promise<{ columns: string[]; rows: any[][]; truncated: boolean }>;
}
export interface Contact {
  id: string;
  name: string;
  avatar?: string;
  native?: Row;
}
export interface Group extends Contact {
  topic?: string;
  members?: Contact[];
}
export interface Conversation {
  id: string;
  name?: string;
  chat_type: "direct" | "group";
  unread_count: number;
  last_timestamp: number;
}
export interface Message {
  id: string;
  local_key?: string;
  account_id: string;
  chat_id: string;
  chat_type: "direct" | "group";
  sender_id: string;
  kind: string;
  timestamp: number;
  own: boolean;
  text?: string;
  mentions?: string[];
  reply_to?: string;
  location?: { latitude: number; longitude: number; label: string };
  media?: { id: string; kind: string; state: string; name?: string; size?: number };
  native?: Row;
}
export interface Event {
  type: string;
  account_id?: string;
  chat_id?: string;
  message?: Message;
  data?: Row;
}
export interface Status {
  state: "starting" | "awaiting_scan" | "awaiting_confirmation" | "logged_in" | "disconnected";
  account?: { id: string };
  error?: string;
}
export class APIError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function publicFields(value: any): any {
  if (Array.isArray(value)) return value.map(publicFields);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["native", "pid", "build_hash"].includes(k))
        .map(([k, v]) => [k, publicFields(v)]),
    );
  return value;
}
