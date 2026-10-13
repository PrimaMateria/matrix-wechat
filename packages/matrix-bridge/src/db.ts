import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export interface Portal {
  account: string;
  chat: string;
  room: string;
  alias: string;
  name: string;
  history_cursor: string | null;
  imported: number;
  paused: number;
}
export interface Job {
  seq: number;
  source: string;
  key: string;
  payload: string;
  attempts: number;
}
export interface Mapping {
  account: string;
  chat: string;
  remote: string;
  local: string | null;
  event: string;
  sender: string;
  media_pending: number;
  payload: string | null;
}
export interface Outgoing {
  event: string;
  account: string;
  chat: string;
  state: string;
  remote: string | null;
  local: string | null;
  started: number;
  payload: string;
  error: string | null;
}
export class Store {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portals(account TEXT NOT NULL,chat TEXT NOT NULL,room TEXT NOT NULL UNIQUE,alias TEXT NOT NULL UNIQUE,name TEXT NOT NULL,history_cursor TEXT,imported INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,chat));
      CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(source,key));
      CREATE INDEX IF NOT EXISTS pending_inbox ON inbox(done,retry_at,seq);
      CREATE TABLE IF NOT EXISTS messages(account TEXT NOT NULL,chat TEXT NOT NULL,remote TEXT NOT NULL,local TEXT,event TEXT NOT NULL,sender TEXT NOT NULL,media_pending INTEGER NOT NULL DEFAULT 0,payload TEXT,PRIMARY KEY(account,chat,remote));
      CREATE INDEX IF NOT EXISTS message_local ON messages(account,chat,local);
      CREATE INDEX IF NOT EXISTS message_event ON messages(event);
      CREATE TABLE IF NOT EXISTS outgoing(event TEXT PRIMARY KEY,account TEXT NOT NULL,chat TEXT NOT NULL,state TEXT NOT NULL,remote TEXT,local TEXT,started INTEGER NOT NULL,payload TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS ghosts(id TEXT PRIMARY KEY,profile TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS pending_revokes(account TEXT NOT NULL,chat TEXT NOT NULL,remote TEXT NOT NULL,PRIMARY KEY(account,chat,remote));`);
    this.db.run(
      "UPDATE outgoing SET state='uncertain',error='Restart interrupted native sending; not retried' WHERE state='sending'",
    );
  }
  get(key: string): string | undefined {
    return (
      this.db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | null
    )?.value;
  }
  set(key: string, value: string) {
    this.db.run(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, value],
    );
  }
  enqueue(source: string, key: string, payload: unknown) {
    this.db.run("INSERT OR IGNORE INTO inbox(source,key,payload) VALUES(?,?,?)", [
      source,
      key,
      JSON.stringify(payload),
    ]);
  }
  intake(transaction: string, events: unknown[]) {
    this.db.transaction(() => {
      if (this.db.query("SELECT id FROM transactions WHERE id=?").get(transaction)) return;
      for (const event of events) {
        const id = (event as { event_id?: string }).event_id;
        if (id) this.enqueue("matrix", id, event);
      }
      this.db.run("INSERT INTO transactions VALUES(?)", [transaction]);
    })();
  }
  jobs(limit = 100): Job[] {
    return this.db
      .query(
        "SELECT seq,source,key,payload,attempts FROM inbox WHERE done=0 AND retry_at<=? ORDER BY CASE WHEN source='matrix' THEN 0 ELSE 1 END,seq LIMIT ?",
      )
      .all(Date.now(), limit) as Job[];
  }
  done(seq: number) {
    this.db.run("UPDATE inbox SET done=1,payload='',error=NULL WHERE seq=?", [seq]);
  }
  retry(job: Job, error: string) {
    this.db.run("UPDATE inbox SET attempts=attempts+1,retry_at=?,error=? WHERE seq=?", [
      Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)),
      error.slice(0, 500),
      job.seq,
    ]);
  }
  portal(account: string, chat: string): Portal | undefined {
    return this.db.query("SELECT * FROM portals WHERE account=? AND chat=?").get(account, chat) as
      | Portal
      | undefined;
  }
  byRoom(room: string): Portal | undefined {
    return this.db.query("SELECT * FROM portals WHERE room=?").get(room) as Portal | undefined;
  }
  portals(account: string): Portal[] {
    return this.db
      .query("SELECT * FROM portals WHERE account=? ORDER BY chat")
      .all(account) as Portal[];
  }
  mapping(account: string, chat: string, remote: string, local?: string): Mapping | undefined {
    return this.db
      .query(
        "SELECT * FROM messages WHERE account=? AND chat=? AND (remote=? OR (? IS NOT NULL AND local=?)) LIMIT 1",
      )
      .get(account, chat, remote, local ?? null, local ?? null) as Mapping | undefined;
  }
  map(mapping: Mapping) {
    this.db.run(
      "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account,chat,remote) DO UPDATE SET local=excluded.local,event=excluded.event,sender=excluded.sender,media_pending=excluded.media_pending,payload=excluded.payload",
      [
        mapping.account,
        mapping.chat,
        mapping.remote,
        mapping.local,
        mapping.event,
        mapping.sender,
        mapping.media_pending,
        mapping.payload,
      ],
    );
  }
  outgoing(event: string): Outgoing | undefined {
    return this.db.query("SELECT * FROM outgoing WHERE event=?").get(event) as Outgoing | undefined;
  }
  close() {
    this.db.close();
  }
}
