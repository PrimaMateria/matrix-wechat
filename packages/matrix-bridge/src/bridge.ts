import type { Config } from "./config";
import { incoming, outboundText, saveMapping } from "./content";
import { type Mapping, type Outgoing, type Portal, Store } from "./db";
import { digest, Matrix } from "./matrix";
import {
  type Chat,
  type Contact,
  type Event,
  type MatrixEvent,
  type Message,
  type SendRequest,
  type Session,
  Unsupported,
} from "./types";

export class WeChatBridge {
  private unsubscribe?: () => void;
  private running = false;
  private pumping?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private syncedAt = 0;
  private contacts = new Map<string, Contact>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly session: Session,
    readonly matrix = new Matrix(config),
  ) {}
  async start() {
    await this.matrix.start(this.store);
    this.unsubscribe = this.session.onEvent((event) => {
      if (!this.running) return;
      // Normalized events contain no raw database records or native credentials.
      this.store.enqueue("wechat", digest(JSON.stringify(event)), event);
      void this.tick();
    });
    this.running = true;
    // Re-read retained history on each restart to recover offline inserts/updates.
    this.store.db.run("UPDATE portals SET imported=0,history_cursor=NULL");
    this.timer = setInterval(() => void this.tick(), 1000);
    await this.session.start();
    void this.tick();
  }
  async close() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.pumping;
    await this.session.close();
    await this.matrix.close();
  }
  private account() {
    const account = this.session.status.account?.id;
    if (
      this.session.status.state !== "logged_in" ||
      !account ||
      this.store.get("disconnected") === "true"
    )
      return undefined;
    const bound = this.store.get("account");
    if (bound && bound !== account)
      throw Error("WeChat account changed; refusing to reuse another account's rooms");
    if (!bound) this.store.set("account", account);
    return account;
  }
  tick(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.pump()
      .catch((error) =>
        console.error("Bridge worker:", error instanceof Error ? error.message : "failed"),
      )
      .finally(() => {
        this.pumping = undefined;
      });
    return this.pumping;
  }
  private async pump() {
    if (!this.running) return;
    this.store.set("connection", this.session.status.state);
    await this.loginUpdate();
    let account: string | undefined;
    try {
      account = this.account();
    } catch (error) {
      this.store.set("connection", String(error));
    }
    // Management commands remain usable while WeChat is offline or importing.
    for (const job of this.store.jobs()) {
      try {
        const payload = JSON.parse(job.payload);
        if (job.source === "matrix") await this.fromMatrix(payload);
        else if (job.source === "wechat") {
          if (payload.message || payload.type === "message.revoked") {
            if (!account || (payload.account_id && payload.account_id !== account)) continue;
            if (payload.message) {
              const portal =
                this.store.portal(account, payload.message.chat_id) ||
                (await this.portal(account, {
                  id: payload.message.chat_id,
                  name: payload.message.chat_id,
                  group: payload.message.chat_type === "group",
                  members: [],
                }));
              if (!portal?.imported) continue;
              await this.fromWeChat(payload.message);
            } else
              await this.revoke(account, payload.chat_id, String(payload.data?.message_id || ""));
          }
        }
        this.store.done(job.seq);
      } catch (error) {
        this.store.retry(job, error instanceof Error ? error.message : "Operation failed");
      }
    }
    if (!account) return;
    if (Date.now() - this.syncedAt > this.config.bridge.reconcile_seconds * 1000) {
      await this.sync(account);
      this.syncedAt = Date.now();
      this.store.db.run("UPDATE portals SET imported=0 WHERE account=?", [account]);
    }
    for (const portal of this.store.portals(account)) {
      if (!this.running || portal.imported || portal.paused) continue;
      try {
        if (await this.pauseEncrypted(portal)) continue;
        const page = await this.session.history(
          portal.chat,
          portal.history_cursor || undefined,
          this.config.bridge.history_batch_size,
        );
        for (const message of page.messages) {
          if (!this.running) return;
          if (message.account_id !== account || message.chat_id !== portal.chat)
            throw Error("History crossed an account or chat boundary");
          await this.fromWeChat(message);
        }
        this.store.db.run(
          "UPDATE portals SET history_cursor=?,imported=? WHERE account=? AND chat=?",
          [page.cursor || portal.history_cursor, page.done ? 1 : 0, account, portal.chat],
        );
      } catch (error) {
        this.store.set(
          "history_error",
          error instanceof Error ? error.message : "History import failed",
        );
      }
    }
  }
  async ghost(account: string, id: string) {
    const user = this.matrix.ghost(account, id),
      profile = this.contacts.get(id),
      name = profile?.name || (id === account ? "WeChat (you)" : id),
      previous = this.store.db.query("SELECT profile FROM ghosts WHERE id=?").get(user) as {
        profile: string;
      } | null;
    if (!previous || previous.profile !== name) {
      await this.matrix.register(user);
      await this.matrix.sdk.getIntent(user).setDisplayName(name);
      try {
        const asset = await this.session.avatar(id);
        await this.matrix.sdk.getIntent(user).setAvatarUrl(await this.matrix.upload(asset));
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["not_found", "media_unavailable"].includes(String(error.code))
        )
          throw error;
      }
      this.store.db.run(
        "INSERT INTO ghosts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile",
        [user, name],
      );
    }
    return user;
  }
  private async sync(account: string) {
    this.contacts = new Map(
      (await this.session.contacts()).map((contact) => [contact.id, contact]),
    );
    for (const chat of await this.session.chats()) {
      const portal = await this.portal(account, chat);
      if (await this.pauseEncrypted(portal)) continue;
      if (portal.name !== chat.name) {
        await this.matrix.state(portal.room, "m.room.name", { name: chat.name });
        this.store.db.run("UPDATE portals SET name=? WHERE account=? AND chat=?", [
          chat.name,
          account,
          chat.id,
        ]);
      }
      if (chat.topic !== undefined)
        await this.matrix.state(portal.room, "m.room.topic", { topic: chat.topic });
      const members = new Set([...chat.members.map((member) => member.id), account]);
      for (const member of members)
        await this.matrix.join(portal.room, await this.ghost(account, member));
      if (chat.group) {
        const joined = await this.matrix.intent.matrixClient.getJoinedRoomMembers(portal.room);
        const wanted = new Set([...members].map((member) => this.matrix.ghost(account, member)));
        for (const user of joined)
          if (user.startsWith("@" + this.config.appservice.prefix) && !wanted.has(user))
            await this.matrix.sdk.getIntent(user).leave(portal.room);
      }
    }
  }
  private async portal(account: string, chat: Chat): Promise<Portal> {
    const existing = this.store.portal(account, chat.id);
    if (existing) return existing;
    const alias = this.matrix.alias(account, chat.id);
    let room: string;
    try {
      room = await this.matrix.intent.resolveRoom(alias);
    } catch (error: any) {
      if (
        error.errcode !== "M_NOT_FOUND" &&
        error.statusCode !== 404 &&
        error.status !== 404 &&
        error.body?.errcode !== "M_NOT_FOUND"
      )
        throw error;
      const result = await this.matrix.intent.createRoom({
        options: {
          visibility: "private",
          preset: "private_chat",
          name: chat.name,
          room_alias_name: alias.slice(1, alias.indexOf(":")),
          invite: [this.config.bridge.owner],
          is_direct: !chat.group,
          power_level_content_override: {
            users: { [this.matrix.bot]: 100, [this.config.bridge.owner]: 50 },
            invite: 50,
            redact: 50,
            state_default: 50,
            events: { "m.room.encryption": 100 },
          },
          initial_state: [
            {
              type: "m.bridge",
              state_key: "wechat://" + digest(JSON.stringify([account, chat.id])),
              content: {
                bridgebot: this.matrix.bot,
                creator: this.matrix.bot,
                protocol: { id: "wechat", displayname: "WeChat" },
                channel: { id: chat.id, displayname: chat.name },
              },
            },
          ],
        },
      });
      room = result.room_id;
    }
    this.store.db.run(
      "INSERT OR IGNORE INTO portals(account,chat,room,alias,name) VALUES(?,?,?,?,?)",
      [account, chat.id, room, alias, chat.name],
    );
    return this.store.portal(account, chat.id)!;
  }
  private async pauseEncrypted(portal: Portal) {
    if (portal.paused) return true;
    if (!(await this.matrix.encrypted(portal.room))) return false;
    this.store.db.run("UPDATE portals SET paused=1 WHERE account=? AND chat=?", [
      portal.account,
      portal.chat,
    ]);
    const management = this.store.get("management");
    if (management && !(await this.matrix.encrypted(management)))
      await this.notice(
        management,
        `Bridging paused for ${portal.name}: encrypted rooms are unsupported.`,
        "encrypted-" + digest(portal.room),
      );
    return true;
  }
  private async fromWeChat(message: Message) {
    const account = this.account();
    if (!account || message.account_id !== account) return;
    let portal = this.store.portal(account, message.chat_id);
    if (!portal)
      portal = await this.portal(account, {
        id: message.chat_id,
        name: message.chat_id,
        group: message.chat_type === "group",
        members: [],
      });
    if (await this.pauseEncrypted(portal)) return;
    const existing = this.store.mapping(account, message.chat_id, message.id, message.local_key);
    if (existing) {
      if (existing.remote !== message.id) this.store.map({ ...existing, remote: message.id });
      return;
    }
    if (message.own) {
      // Only a native ID/local key can definitively identify a Matrix echo.
      // Content/timestamp matching is ambiguous with sends from the web UI.
      const out = this.store.db
        .query(
          "SELECT * FROM outgoing WHERE account=? AND chat=? AND (remote=? OR (? IS NOT NULL AND local=?)) LIMIT 1",
        )
        .get(
          account,
          message.chat_id,
          message.id,
          message.local_key ?? null,
          message.local_key ?? null,
        ) as Outgoing | null;
      if (out) {
        saveMapping(this.store, message, out.event, this.config.bridge.owner);
        this.store.db.run("UPDATE outgoing SET state='confirmed',remote=? WHERE event=?", [
          message.id,
          out.event,
        ]);
        return;
      }
    }
    const sender =
      message.kind === "system" || !message.sender_id
        ? this.matrix.bot
        : await this.ghost(account, message.sender_id);
    await this.matrix.join(portal.room, sender);
    const converted = await incoming(message, this.session, this.matrix, this.store);
    const result = await this.matrix.send(
      portal.room,
      sender,
      converted.content,
      "wechat-" +
        digest(JSON.stringify([account, message.chat_id, message.local_key || message.id])),
      message.timestamp * 1000,
      converted.type,
    );
    saveMapping(this.store, message, result.event_id, sender, converted.pending);
    const revoked = this.store.db
      .query("SELECT remote FROM pending_revokes WHERE account=? AND chat=? AND remote=?")
      .get(account, message.chat_id, message.id);
    if (revoked) await this.revoke(account, message.chat_id, message.id);
  }
  private async revoke(account: string, chat: string, remote: string) {
    if (!chat || !remote) return;
    const portal = this.store.portal(account, chat),
      message = this.store.mapping(account, chat, remote);
    if (!portal || !message) {
      this.store.db.run("INSERT OR IGNORE INTO pending_revokes VALUES(?,?,?)", [
        account,
        chat,
        remote,
      ]);
      return;
    }
    if (await this.pauseEncrypted(portal)) return;
    await this.matrix.redact(
      portal.room,
      message.event,
      "revoke-" + digest(JSON.stringify([account, chat, remote])),
    );
    this.store.db.run(
      "UPDATE messages SET media_pending=0,payload=NULL WHERE account=? AND chat=? AND remote=?",
      [account, chat, remote],
    );
    this.store.db.run("DELETE FROM pending_revokes WHERE account=? AND chat=? AND remote=?", [
      account,
      chat,
      remote,
    ]);
  }
  private async fromMatrix(event: MatrixEvent) {
    if (event.sender !== this.config.bridge.owner) return;
    if (
      event.type === "m.room.member" &&
      event.state_key === this.matrix.bot &&
      event.content.membership === "invite"
    ) {
      await this.matrix.join(event.room_id, this.matrix.bot);
      if (await this.matrix.encrypted(event.room_id)) return;
      this.store.set("management", event.room_id);
      await this.notice(
        event.room_id,
        "WeChat bridge ready.\n\nLogin options:\n• login qr — scan a new QR code on your phone\n• login reprompt — retry the saved desktop login and request phone confirmation\n\nSend help for commands. History import includes all messages retained by the Linux client.",
        event.event_id,
      );
      return;
    }
    if (event.type !== "m.room.message" && event.type !== "m.room.redaction") return;
    if (await this.matrix.encrypted(event.room_id)) return;
    const portal = this.store.byRoom(event.room_id),
      body = String(event.content.body || ""),
      prefix = this.config.bridge.command_prefix;
    const management = this.store.get("management");
    if (
      event.type === "m.room.message" &&
      (event.room_id === management || body.startsWith(prefix + " "))
    ) {
      try {
        await this.command(
          event,
          body.startsWith(prefix + " ") ? body.slice(prefix.length + 1) : body,
        );
      } catch (error) {
        await this.notice(
          event.room_id,
          error instanceof Error ? error.message : "Command failed",
          event.event_id,
        );
      }
      return;
    }
    if (!portal || portal.paused || this.store.outgoing(event.event_id)) return;
    if (event.type === "m.room.redaction") {
      await this.notice(
        event.room_id,
        "Revoking messages is not supported by the WeChat package.",
        event.event_id,
      );
      return;
    }
    const account = this.account();
    if (!account || account !== portal.account) throw Error("WeChat is offline");
    const request: SendRequest = { transaction: event.event_id, chat: portal.chat, kind: "text" };
    try {
      if (event.content["m.relates_to"]?.rel_type === "m.replace")
        throw new Unsupported("Editing messages is not supported by the WeChat package");
      if (event.content.file) throw new Unsupported("Encrypted attachments are unsupported");
      const kind = event.content.msgtype;
      if (["m.text", "m.emote", "m.location"].includes(kind))
        request.text =
          kind === "m.location"
            ? [body, event.content.geo_uri].filter(Boolean).join("\n")
            : outboundText(event.content);
      else if (["m.image", "m.file"].includes(kind)) {
        request.kind = kind === "m.image" ? "image" : "file";
        request.name = String(event.content.filename || body || "attachment");
        request.bytes = await this.matrix.download(String(event.content.url));
      } else
        throw new Unsupported(
          `Sending ${kind || event.type} is not supported by the WeChat package`,
        );
      const reply = event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
      if (reply && request.kind === "text") {
        const parent = this.store.db
          .query("SELECT remote FROM messages WHERE account=? AND chat=? AND event=? LIMIT 1")
          .get(account, portal.chat, reply) as { remote: string } | null;
        if (parent && /^\d+$/.test(parent.remote)) request.reply_to = parent.remote;
      }
      const saved = { ...request, bytes: undefined };
      this.store.db.run(
        "INSERT INTO outgoing(event,account,chat,state,started,payload) VALUES(?,?,?,'sending',?,?)",
        [event.event_id, account, portal.chat, Date.now(), JSON.stringify(saved)],
      );
      const result = await this.session.send(request);
      this.store.db.run("UPDATE outgoing SET state=?,remote=?,local=? WHERE event=?", [
        result.acknowledgement === "confirmed" ? "confirmed" : "queued",
        result.id ?? null,
        result.local_key ?? null,
        event.event_id,
      ]);
      if (result.id)
        this.store.map({
          account,
          chat: portal.chat,
          remote: result.id,
          local: result.local_key || null,
          event: event.event_id,
          sender: event.sender,
          media_pending: 0,
          payload: null,
        });
      if (result.acknowledgement !== "confirmed")
        await this.notice(
          event.room_id,
          "WeChat accepted the message for processing; remote delivery is not yet confirmed.",
          event.event_id,
        );
    } catch (error) {
      const pending = this.store.outgoing(event.event_id);
      if (pending)
        this.store.db.run("UPDATE outgoing SET state=?,error=? WHERE event=?", [
          error instanceof Unsupported ? "failed" : "uncertain",
          error instanceof Error ? error.message : "Send failed",
          event.event_id,
        ]);
      await this.notice(
        event.room_id,
        (error instanceof Error ? error.message : "Send failed") +
          (pending && !(error instanceof Unsupported)
            ? ". Delivery is uncertain; this send will not be retried automatically."
            : ""),
        event.event_id,
      );
    }
  }
  private notice(room: string, text: string, key: string) {
    return this.matrix.send(
      room,
      this.matrix.bot,
      { msgtype: "m.notice", body: text },
      "notice-" + digest(key),
    );
  }
  private async command(event: MatrixEvent, text: string) {
    const [name, ...args] = text.trim().split(/\s+/),
      account = this.account();
    let reply: string;
    if (name === "help")
      reply =
        "Commands: help, status, login qr, login reprompt, disconnect, contacts, groups, open <chat ID>, sync, history, retry-media.\n\nLogin options:\n• login qr — scan a new QR code\n• login reprompt — retry the saved desktop login and request phone confirmation\n\nUse !wechat before commands in chat rooms. Outbound: text, images, files and replies. Encrypted rooms are unsupported.";
    else if (["status", "ping"].includes(name))
      reply = `WeChat: ${this.session.status.state}; bound account: ${this.store.get("account") || "none"}; capabilities: ${JSON.stringify(this.session.capabilities())}`;
    else if (name === "disconnect" || name === "logout") {
      this.store.set("disconnected", "true");
      reply = "Matrix bridging disconnected. The Linux client's saved login is preserved.";
    } else if (name === "login") {
      if (!args[0]) {
        await this.notice(
          event.room_id,
          "Choose a login method:\n• login qr — scan a QR code\n• login reprompt — request phone confirmation for the saved account",
          event.event_id,
        );
        return;
      }
      if (!["saved", "reprompt", "qr"].includes(args[0]))
        throw Error("Use login qr or login reprompt");
      this.store.set("disconnected", "false");
      await this.session.login(args[0] === "qr" ? "qr" : "saved");
      this.store.set(
        "pending_login",
        JSON.stringify({ room: event.room_id, event: event.event_id, state: "" }),
      );
      this.syncedAt = 0;
      reply =
        args[0] === "qr"
          ? "QR login requested. I will send the current QR here when it is ready."
          : "Saved login retry requested. Confirm the desktop login on your phone. If WeChat requires a QR code, I will send it here.";
    } else if (name === "contacts")
      reply =
        (await this.session.contacts())
          .map((contact) => `${contact.name}: ${contact.id}`)
          .join("\n") || "No contacts";
    else if (name === "groups")
      reply =
        (await this.session.chats())
          .filter((chat) => chat.group)
          .map((chat) => `${chat.name}: ${chat.id}`)
          .join("\n") || "No groups";
    else if (name === "sync") {
      this.syncedAt = 0;
      reply = "Contact/group synchronization and missed-message recovery queued.";
    } else if (name === "history") {
      const portals = this.store.portals(account || this.store.get("account") || "");
      const rows = this.store.db.query("SELECT COUNT(*) AS count FROM messages").get() as {
        count: number;
      };
      reply = `${rows.count} mapped messages; ${portals.filter((portal) => !portal.imported).length} rooms importing; ${portals.filter((portal) => portal.paused).length} paused. ${this.store.get("history_error") || ""}`;
    } else if (name === "open" || name === "start-chat") {
      if (!account || !args[0]) throw Error("Use open <WeChat chat ID> while connected");
      const chat = (await this.session.chats()).find((chat) => chat.id === args[0]) || {
        id: args[0],
        name: args[0],
        group: args[0].endsWith("@chatroom"),
        members: [],
      };
      const portal = await this.portal(account, chat);
      await this.matrix.intent.invite(portal.room, this.config.bridge.owner);
      reply = `Chat: https://matrix.to/#/${encodeURIComponent(portal.room)}`;
    } else if (name === "retry-media") {
      if (!account) throw Error("WeChat is offline");
      const rows = this.store.db
        .query("SELECT * FROM messages WHERE account=? AND media_pending=1 LIMIT 100")
        .all(account) as Mapping[];
      let recovered = 0;
      for (const mapping of rows) {
        const portal = this.store.portal(account, mapping.chat);
        if (!portal || (await this.pauseEncrypted(portal))) continue;
        const message = JSON.parse(mapping.payload!) as Message,
          converted = await incoming(message, this.session, this.matrix, this.store);
        if (converted.pending) continue;
        if (converted.type === "m.sticker") {
          const result = await this.matrix.send(
            portal.room,
            mapping.sender,
            converted.content,
            "retry-" + digest(mapping.event),
            message.timestamp * 1000,
            converted.type,
          );
          await this.matrix.redact(
            portal.room,
            mapping.event,
            "placeholder-" + digest(mapping.event),
          );
          saveMapping(this.store, message, result.event_id, mapping.sender);
        } else {
          await this.matrix.send(
            portal.room,
            mapping.sender,
            {
              ...converted.content,
              "m.new_content": converted.content,
              "m.relates_to": { rel_type: "m.replace", event_id: mapping.event },
            },
            "retry-" + digest(mapping.event),
          );
          saveMapping(this.store, message, mapping.event, mapping.sender);
        }
        recovered++;
      }
      reply = `Recovered ${recovered} attachments; checked up to 100 pending messages. Run again to continue.`;
    } else reply = "Unknown command. Send help.";
    await this.notice(event.room_id, reply, event.event_id);
  }
  private async loginUpdate() {
    const pending = this.store.get("pending_login");
    if (!pending) return;
    const login = JSON.parse(pending) as {
      room: string;
      event: string;
      state: string;
      qr?: string;
    };
    if (await this.matrix.encrypted(login.room)) {
      this.store.set("pending_login", "");
      return;
    }
    const state = this.session.status.state;
    if (state !== login.state) {
      const labels: Record<string, string> = {
        starting: "Starting WeChat…",
        signing_in: "Signing in…",
        awaiting_scan: "Waiting for QR scan…",
        awaiting_confirmation: "Confirm the desktop login on your phone.",
        logged_in: "WeChat account connected. Retained-history import is running.",
        disconnected: "WeChat disconnected. Retry login qr or login reprompt.",
      };
      await this.notice(login.room, labels[state], login.event + "-" + state);
      login.state = state;
    }
    if (this.session.qr && Date.now() - this.session.qrAt < 8000) {
      const hash = digest(this.session.qr.toString("base64"));
      if (hash !== login.qr) {
        const url = await this.matrix.upload({
          bytes: this.session.qr,
          type: "image/png",
          name: "wechat-login.png",
        });
        await this.matrix.send(
          login.room,
          this.matrix.bot,
          { msgtype: "m.image", body: "WeChat login QR — scan with your phone", url },
          "qr-" + digest(login.event + hash),
        );
        login.qr = hash;
      }
    }
    this.store.set("pending_login", state === "logged_in" ? "" : JSON.stringify(login));
  }
}
