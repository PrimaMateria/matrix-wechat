import { imageType } from "../../wechatlinux/src/media";
import type { Runtime } from "../../wechatlinux/src/runtime";
import { APIError } from "../../wechatlinux/src/types";
import type { Config } from "./config";
import { ghostID, incoming, messageFingerprint, outgoing } from "./convert";
import type { MatrixTransport } from "./matrix";
import {
  type Asset,
  type Contact,
  type Conversation,
  capabilities,
  checksum,
  type Group,
  type Message,
  sendFingerprint,
  unsupported,
} from "./messages";
import { hash, type Inbox, type Mapping, type MatrixEvent, type Portal, Store } from "./store";

const mediaKinds = new Set(["image", "sticker", "audio", "video", "file"]);
const pendingTimeout = 120000;
export class WeChatBridge {
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private lastMetadata = 0;
  private management = "";
  private contacts = new Map<string, Contact>();
  private groups = new Map<string, Group>();
  private joined = new Set<string>();
  private encryption = new Map<string, boolean>();
  private rotation = 0;
  lastError = "";
  constructor(
    readonly config: Config,
    readonly runtime: Runtime,
    readonly matrix: MatrixTransport,
    readonly store: Store,
    readonly fatal: () => void = () => {},
  ) {}
  private async contactsList(): Promise<Contact[]> {
    return (await this.runtime.dispatch("contacts")).contacts;
  }
  private async groupsList(): Promise<Group[]> {
    return (await this.runtime.dispatch("groups")).groups;
  }
  private async conversationsList(): Promise<Conversation[]> {
    return (await this.runtime.dispatch("conversations")).conversations;
  }
  get account() {
    return this.runtime.status.account?.id || "";
  }
  ghost(id: string) {
    return ghostID(this.account, id, this.config.homeserver.domain);
  }
  accept(event: MatrixEvent) {
    if (!event.event_id || !event.room_id || !event.sender || !event.content) return;
    if (
      event.type === "m.room.encryption" &&
      (this.store.portalForRoom(event.room_id) || event.room_id === this.store.meta("management"))
    ) {
      this.encryption.set(event.room_id, true);
      this.store.setMeta(`encrypted:${event.room_id}`, "true");
      this.store.accept(event);
      return;
    }
    if (event.sender !== this.config.bridge.owner) return;
    if (
      !this.store.portalForRoom(event.room_id) &&
      event.room_id !== this.store.meta("management")
    ) {
      if (
        event.type !== "m.room.member" ||
        event.state_key !== this.matrix.bot ||
        event.content.membership !== "invite"
      )
        return;
    }
    this.store.accept(event);
  }
  async start() {
    this.management =
      this.store.meta("management") ||
      (await this.matrix.createRoom(
        `management:${this.config.bridge.owner}`,
        "WeChat bridge",
        this.config.bridge.owner,
        true,
      ));
    this.store.setMeta("management", this.management);
    this.unsubscribe = this.runtime.onEvent((event) => {
      if (event.message) this.store.queue(event.message);
      if (
        event.type === "message.revoked" &&
        event.account_id &&
        event.chat_id &&
        event.data?.message_id
      )
        this.store.run(
          "INSERT OR IGNORE INTO revocations VALUES(?,?,?)",
          event.account_id,
          event.chat_id,
          String(event.data.message_id),
        );
      if (event.type === "connection.closed") this.fatal();
      // Deletion is deliberately ignored: cache disappearance is not revocation.
    });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    while (this.busy) await Bun.sleep(25);
  }
  async notice(room: string, text: string, key: string) {
    await this.matrix.send(
      this.matrix.bot,
      room,
      "m.room.message",
      { msgtype: "m.notice", body: text },
      hash(key),
    );
  }
  async usable(room: string) {
    if (this.store.meta(`encrypted:${room}`)) return false;
    const encrypted = this.encryption.get(room) || (await this.matrix.encrypted(room));
    if (encrypted) {
      this.encryption.set(room, true);
      this.store.setMeta(`encrypted:${room}`, "true");
      await this.notice(
        room,
        "Encrypted Matrix rooms are unsupported. Bridging for this room is stopped.",
        `encrypted-room:${room}`,
      );
    }
    return !encrypted;
  }
  private async status() {
    const state = this.runtime.status.state;
    if (this.store.meta("connection_state") !== state) {
      const generation = Number(this.store.meta("connection_generation") || "0") + 1;
      await this.notice(
        this.management,
        `WeChat: ${state.replaceAll("_", " ")}.`,
        `connection:${generation}:${state}`,
      );
      this.store.setMeta("connection_generation", String(generation));
      this.store.setMeta("connection_state", state);
    }
    if (
      state === "awaiting_scan" &&
      (await this.usable(this.management)) &&
      this.runtime.qr &&
      this.runtime.qrAt > Number(this.store.meta("qr_at") || "0")
    ) {
      const mxc = await this.matrix.upload({
        bytes: this.runtime.qr,
        type: "image/png",
        name: "wechat-login.png",
      });
      await this.matrix.send(
        this.matrix.bot,
        this.management,
        "m.room.message",
        {
          msgtype: "m.image",
          body: "Scan with WeChat, then approve on your phone",
          url: mxc,
          info: { mimetype: "image/png", size: this.runtime.qr.length },
        },
        hash(`qr:${this.runtime.qrAt}`),
      );
      this.store.setMeta("qr_at", String(this.runtime.qrAt));
    }
  }
  private async assetUpload(bytes: Buffer, type: string, name?: string) {
    const key = hash(`${this.account}:${type}:${name || ""}:${hash(bytes)}`);
    const existing = this.store.get<{ mxc: string }>("SELECT mxc FROM uploads WHERE key=?", key);
    if (existing) return existing.mxc;
    const mxc = await this.matrix.upload({ bytes, type, name });
    this.store.run("INSERT OR REPLACE INTO uploads VALUES(?,?)", key, mxc);
    return mxc;
  }
  private async ensureGhost(id: string) {
    const mxid = this.ghost(id),
      contact = this.contacts.get(id);
    let avatar: string | undefined;
    try {
      const asset = await this.runtime.avatar(id);
      avatar = await this.assetUpload(asset.bytes, asset.type);
    } catch (error) {
      if (!(error instanceof APIError) || !["not_found", "media_unavailable"].includes(error.code))
        throw error;
    }
    const name = contact?.name || id;
    const previous = this.store.get<{ profile: string }>(
      "SELECT profile FROM ghosts WHERE account=? AND id=?",
      this.account,
      id,
    );
    const profile = JSON.stringify({
      name,
      avatar: avatar ?? JSON.parse(previous?.profile || "{}").avatar,
    });
    this.store.run(
      "INSERT OR IGNORE INTO ghosts(account,id,mxid) VALUES(?,?,?)",
      this.account,
      id,
      mxid,
    );
    if (previous?.profile !== profile) {
      await this.matrix.profile(mxid, name, avatar);
      this.store.run(
        "UPDATE ghosts SET profile=? WHERE account=? AND id=?",
        profile,
        this.account,
        id,
      );
    }
    return mxid;
  }
  private async joinGhost(room: string, id: string) {
    const key = `${room}:${id}`;
    if (this.joined.has(key)) return this.ghost(id);
    const mxid = await this.ensureGhost(id);
    await this.matrix.membership(room, mxid, true);
    this.joined.add(key);
    return mxid;
  }
  async ensurePortal(chat: string, name?: string) {
    const existing = this.store.portal(this.account, chat);
    if (existing) return existing;
    const room = await this.matrix.createRoom(
      JSON.stringify([this.account, chat]),
      name || this.groups.get(chat)?.name || this.contacts.get(chat)?.name || chat,
      this.config.bridge.owner,
      !chat.endsWith("@chatroom"),
    );
    this.store.addPortal(this.account, chat, room);
    return this.store.portal(this.account, chat)!;
  }
  private async metadata() {
    this.contacts = new Map((await this.contactsList()).map((contact) => [contact.id, contact]));
    this.groups = new Map((await this.groupsList()).map((group) => [group.id, group]));
    const conversations = await this.conversationsList();
    for (const conversation of conversations)
      await this.ensurePortal(conversation.id, conversation.name);
    for (const portal of this.store.portals(this.account)) {
      if (!(await this.usable(portal.room))) continue;
      const group = this.groups.get(portal.chat),
        contact = this.contacts.get(portal.chat);
      const name =
        group?.name ||
        contact?.name ||
        conversations.find((c) => c.id === portal.chat)?.name ||
        portal.chat;
      let avatar: string | undefined;
      try {
        const asset = await this.runtime.avatar(portal.chat);
        avatar = await this.assetUpload(asset.bytes, asset.type);
      } catch (error) {
        if (
          !(error instanceof APIError) ||
          !["not_found", "media_unavailable"].includes(error.code)
        )
          throw error;
      }
      const previous = JSON.parse(portal.metadata || "{}");
      const members = [
        ...new Set([
          this.account,
          ...(group ? (group.members || []).map((m) => m.id) : [portal.chat]),
        ]),
      ];
      const metadata = JSON.stringify({
        name,
        topic: group?.topic || "",
        avatar: avatar ?? previous.avatar,
        members,
      });
      if (portal.metadata !== metadata) {
        await this.matrix.metadata(portal.room, name, group?.topic || "", avatar);
        for (const id of members) await this.joinGhost(portal.room, id);
        for (const id of previous.members || [])
          if (!members.includes(id)) {
            await this.matrix.membership(portal.room, this.ghost(id), false);
            this.joined.delete(`${portal.room}:${id}`);
          }
        this.store.run(
          "UPDATE portals SET metadata=? WHERE account=? AND chat=?",
          metadata,
          this.account,
          portal.chat,
        );
      }
    }
    // Existing participant profiles can change without any roster change.
    for (const ghost of this.store.all<{ id: string }>(
      "SELECT id FROM ghosts WHERE account=?",
      this.account,
    ))
      await this.ensureGhost(ghost.id);
    this.lastMetadata = Date.now();
  }
  private async content(message: Message) {
    let asset: Asset | undefined, mxc;
    let missingMedia = false;
    if (mediaKinds.has(message.kind)) {
      try {
        asset = await this.runtime.media(message.chat_id, message.id);
      } catch (error) {
        if (
          !(error instanceof APIError) ||
          !["not_found", "media_unavailable"].includes(error.code)
        )
          throw error;
        missingMedia = true;
      }
      if (asset) mxc = await this.assetUpload(asset.bytes, asset.type, asset.name);
    }
    return {
      ...incoming(message, {
        asset,
        mxc,
        missingMedia,
        replyEvent: message.reply_to
          ? this.store.mapping(this.account, message.chat_id, message.reply_to)?.event
          : undefined,
        ghost: (id) => this.ghost(id),
        owner: this.config.bridge.owner,
      }),
      missingMedia,
    };
  }
  private held(message: Message) {
    if (!message.own) return false;
    // Correlation runs against authoritative recent source records before ingestion.
    return this.store
      .pending(this.account, message.chat_id)
      .some(
        (pending) =>
          pending.started > Date.now() - pendingTimeout &&
          !JSON.parse(pending.baseline).includes(message.id) &&
          message.timestamp * 1000 >= pending.started - 5000,
      );
  }
  private async receive(message: Message, portal: Portal) {
    if (message.account_id !== this.account || !(await this.usable(portal.room))) return false;
    const fingerprint = messageFingerprint(message);
    const existing = this.store.mapping(
      this.account,
      message.chat_id,
      message.id,
      message.local_key,
    );
    if (!existing && this.held(message)) return false;
    if (existing?.redacted) return true;
    if (existing && existing.fingerprint === fingerprint && !existing.media_retry) {
      if (existing.id !== message.id)
        this.store.saveMapping(message, existing.event, existing.sender, fingerprint);
      return true;
    }
    const sender =
      existing?.sender ||
      (message.kind === "system" || !message.sender_id
        ? this.matrix.bot
        : await this.joinGhost(portal.room, message.sender_id));
    const converted = await this.content(message);
    if (existing?.fingerprint === fingerprint && converted.missingMedia) return true;
    // An echoed Matrix event belongs to the owner: don't impersonate them to edit it.
    if (existing?.sender === this.config.bridge.owner) {
      this.store.saveMapping(message, existing.event, existing.sender, fingerprint);
      return true;
    }
    const originalType = existing ? this.store.meta(`message_type:${existing.event}`) : undefined;
    const edit = existing && originalType !== "m.sticker" && converted.type !== "m.sticker";
    const content = edit
      ? {
          ...converted.content,
          "m.new_content": converted.content,
          "m.relates_to": { rel_type: "m.replace", event_id: existing.event },
          body: `* ${converted.content.body}`,
        }
      : converted.content;
    const operation = hash(
      JSON.stringify([this.account, message.chat_id, message.local_key || message.id]),
    );
    const revision = this.store.revision(
      operation,
      JSON.stringify([
        fingerprint,
        converted.missingMedia,
        existing?.fingerprint,
        existing?.event,
        existing?.media_retry,
      ]),
    );
    const event = await this.matrix.send(
      sender,
      portal.room,
      converted.type,
      content,
      hash(`${operation}:${revision}`),
      message.timestamp * 1000,
    );
    if (existing && !edit)
      await this.matrix.redact(
        portal.room,
        existing.event,
        hash(`replace:${existing.event}:${event}`),
      );
    this.store.saveMapping(
      message,
      edit ? existing.event : event,
      sender,
      fingerprint,
      converted.missingMedia,
    );
    this.store.setMeta(`message_type:${edit ? existing.event : event}`, converted.type);
    return true;
  }
  private async confirmPending(chat: string, recent: Message[]) {
    for (const pending of this.store.pending(this.account, chat)) {
      const baseline = new Set<string>(JSON.parse(pending.baseline));
      const candidates = [
        ...new Map(
          recent
            .filter(
              (message) =>
                message.own &&
                !message.id.startsWith("local:") &&
                !baseline.has(message.id) &&
                !baseline.has(message.local_key || "") &&
                message.timestamp * 1000 >= pending.started - 5000 &&
                message.timestamp * 1000 <= pending.started + pendingTimeout &&
                sendFingerprint(message) === pending.fingerprint,
            )
            .map((message) => [message.id, message]),
        ).values(),
      ];
      if (candidates.length === 1) {
        const message = candidates[0];
        const claimed = this.store.mapping(this.account, chat, message.id, message.local_key);
        if (!claimed || claimed.event === pending.id) {
          this.store.db.transaction(() => {
            this.store.saveMapping(
              message,
              pending.id,
              this.config.bridge.owner,
              messageFingerprint(message),
            );
            this.store.run("UPDATE inbox SET state='delivered' WHERE id=?", pending.id);
          })();
          continue;
        }
      }
      if (Date.now() - pending.started >= pendingTimeout && !pending.notice) {
        const event: MatrixEvent = JSON.parse(pending.payload);
        await this.notice(
          event.room_id,
          "WeChat delivery is uncertain. The bridge will not resend this message automatically.",
          `uncertain:${pending.id}`,
        );
        this.store.run("UPDATE inbox SET state='uncertain',notice=1 WHERE id=?", pending.id);
      }
    }
  }
  private async reconcile(portal: Portal) {
    if (!(await this.usable(portal.room))) return;
    const recent = await this.runtime.operation(() =>
      this.runtime.store.bridgeRecent(portal.chat, 500),
    );
    await this.confirmPending(portal.chat, recent);
    const page = await this.runtime.operation(() =>
      this.runtime.store.bridgeHistory(portal.chat, portal.cursor || undefined, 200),
    );
    for (const message of page.messages)
      if (!(await this.receive(message, portal))) this.store.queue(message);
    this.store.progress(this.account, portal.chat, page.cursor, page.done);
    // ID promotion and source updates don't necessarily advance a history keyset.
    if (page.done) {
      for (const message of recent.slice().reverse())
        if (!(await this.receive(message, portal))) this.store.queue(message);
      for (const row of this.store.all<{ key: string; payload: string }>(
        "SELECT key,payload FROM incoming WHERE account=? AND chat=? ORDER BY rowid LIMIT 200",
        this.account,
        portal.chat,
      )) {
        if (await this.receive(JSON.parse(row.payload), portal))
          this.store.run("DELETE FROM incoming WHERE key=?", row.key);
      }
    }
  }
  private async redactions() {
    for (const revoke of await this.runtime.operation(() => this.runtime.store.bridgeRevocations()))
      this.store.run(
        "INSERT OR IGNORE INTO revocations VALUES(?,?,?)",
        this.account,
        revoke.chat,
        revoke.id,
      );
    for (const revoke of this.store.all<{ chat: string; id: string }>(
      "SELECT chat,id FROM revocations WHERE account=?",
      this.account,
    )) {
      const portal = this.store.portal(this.account, revoke.chat),
        mapping = this.store.mapping(this.account, revoke.chat, revoke.id);
      if (!portal || !mapping || mapping.redacted || !(await this.usable(portal.room))) continue;
      await this.matrix.redact(
        portal.room,
        mapping.event,
        hash(`revoke:${this.account}:${revoke.chat}:${revoke.id}`),
      );
      this.store.run(
        "UPDATE messages SET redacted=1,media_retry=0 WHERE account=? AND chat=? AND event=?",
        this.account,
        revoke.chat,
        mapping.event,
      );
    }
  }
  private async retryMedia() {
    for (const row of this.store.all<Mapping>(
      "SELECT * FROM messages WHERE account=? AND media_retry=1 AND redacted=0 ORDER BY rowid LIMIT 10",
      this.account,
    )) {
      const portal = this.store.portal(this.account, row.chat);
      if (portal) await this.receive(JSON.parse(row.payload), portal);
    }
  }
  private async command(event: MatrixEvent, text: string) {
    const [command, ...args] = text.trim().split(/\s+/);
    let response = "";
    if (command === "help")
      response =
        "Commands: help, login [saved|qr], status, capabilities, list contacts, list groups, start-chat <WeChat ID>, sync. Native mentions are received; outgoing text does not construct native mentions. Leaving a Matrix room does not leave the WeChat group.";
    else if (command === "status")
      response = `WeChat: ${this.runtime.status.state}. Rooms: ${this.store.portals(this.account).length}. History imports pending: ${this.store.portals(this.account).filter((p) => !p.imported).length}.${this.lastError ? ` Last reconciliation error: ${this.lastError}.` : ""}`;
    else if (command === "capabilities") response = JSON.stringify(capabilities, null, 2);
    else if (command === "login") {
      const mode = args[0] || "saved";
      if (!["saved", "qr"].includes(mode)) throw new Error("Use login saved or login qr");
      await this.runtime.dispatch("login.retry", { mode });
      response = "Login requested. Scan the QR if shown and approve on your phone.";
    } else if (command === "list" && args[0] === "contacts")
      response =
        (await this.contactsList()).map((c) => `${c.id}: ${c.name}`).join("\n") ||
        "No cached contacts.";
    else if (command === "list" && args[0] === "groups")
      response =
        (await this.groupsList()).map((g) => `${g.id}: ${g.name}`).join("\n") ||
        "No cached groups.";
    else if (command === "start-chat" && args.length === 1) {
      if (this.runtime.status.state !== "logged_in") throw new Error("WeChat is not logged in");
      const known =
        (await this.contactsList()).some((c) => c.id === args[0]) ||
        (await this.conversationsList()).some((c) => c.id === args[0]);
      if (!known) throw new Error("Choose a cached contact or conversation ID");
      const portal = await this.ensurePortal(args[0]);
      response = `Opened https://matrix.to/#/${portal.room}`;
    } else if (command === "sync") {
      this.lastMetadata = 0;
      response = "Conversation discovery and cached-history synchronization requested.";
    } else response = "Unknown command. Send help for available commands.";
    await this.notice(event.room_id, response, `command:${event.event_id}`);
  }
  private async sendJob(job: Inbox) {
    const event: MatrixEvent = JSON.parse(job.payload);
    if (event.type === "m.room.encryption") {
      this.encryption.set(event.room_id, true);
      await this.notice(
        event.room_id,
        "Encrypted Matrix rooms are unsupported. Bridging for this room is stopped.",
        `encryption:${event.event_id}`,
      );
      return "done";
    }
    if (event.type === "m.room.member") {
      if (event.state_key === this.matrix.bot && event.content.membership === "invite") {
        await this.matrix.membership(event.room_id, this.matrix.bot, true);
        if (!this.store.portalForRoom(event.room_id)) {
          if (!(await this.usable(event.room_id)))
            throw new Error("Encrypted management rooms are unsupported");
          this.management = event.room_id;
          this.store.setMeta("management", this.management);
          await this.notice(
            event.room_id,
            "WeChat bridge management. Send help for commands.",
            `management:${event.event_id}`,
          );
        }
      }
      return "done";
    }
    if (!(await this.usable(event.room_id)))
      throw new Error("Encrypted Matrix rooms are unsupported");
    if (event.type === "m.room.message" && typeof event.content.body === "string") {
      const body = event.content.body;
      if (
        body.startsWith(`${this.config.bridge.command_prefix} `) ||
        event.room_id === this.management
      ) {
        await this.command(
          event,
          body.startsWith(`${this.config.bridge.command_prefix} `)
            ? body.slice(this.config.bridge.command_prefix.length + 1)
            : body,
        );
        return "done";
      }
    }
    const portal = this.store.portalForRoom(event.room_id);
    if (!portal || portal.account !== this.account)
      throw new Error("This room is not connected to the current WeChat account");
    if (event.type === "m.room.encrypted") unsupported("Encrypted messages");
    if (event.type !== "m.room.message") unsupported(`Sending ${event.type}`);
    if (this.runtime.status.state !== "logged_in")
      throw new APIError("not_ready", "WeChat is disconnected; send is waiting for login");
    // At most one unresolved native send per chat makes identical-send correlation safe.
    if (
      this.store
        .pending(this.account, portal.chat)
        .some(
          (p) =>
            p.state !== "uncertain" || !p.notice || Date.now() - p.started < pendingTimeout + 5000,
        )
    )
      return "wait";
    const message = outgoing(event.content);
    let bytes: Buffer | undefined;
    let name = "",
      reply: string | undefined;
    if (message.kind === "text" && message.reply) {
      reply = this.store.eventMapping(this.account, portal.chat, message.reply)?.id;
      if (!reply || !/^\d{1,20}$/.test(reply))
        throw new Error("Reply target has no confirmed WeChat server ID in this conversation");
    }
    if (message.kind !== "text") {
      const asset = await this.matrix.download(
        message.url,
        message.kind === "image" ? 20 * 1024 * 1024 : 64 * 1024 * 1024,
      );
      bytes = asset.bytes;
      name = message.name;
      if (
        !bytes.length ||
        name === "." ||
        name === ".." ||
        Buffer.byteLength(name) > 200 ||
        /[/\\\x00-\x1f\x7f]/.test(name)
      )
        throw new Error("Invalid attachment filename or empty attachment");
      if (
        message.kind === "image" &&
        !["image/png", "image/jpeg", "image/gif"].includes(imageType(bytes) || "")
      )
        unsupported("This image format; upload it as a file instead");
      if (message.video && bytes.subarray(4, 8).toString() !== "ftyp")
        unsupported("Video formats other than MP4");
    }
    const fingerprint =
      message.kind === "text"
        ? JSON.stringify(["text", message.text, reply || ""])
        : JSON.stringify(["attachment", checksum(bytes!)]);
    const baseline = (
      await this.runtime.operation(() => this.runtime.store.bridgeRecent(portal.chat, 500))
    ).flatMap((m) => [m.id, m.local_key || m.id]);
    this.store.run(
      "UPDATE inbox SET state='sending',account=?,chat=?,fingerprint=?,baseline=?,started=? WHERE id=?",
      this.account,
      portal.chat,
      fingerprint,
      JSON.stringify(baseline),
      Date.now(),
      job.id,
    );
    try {
      if (message.kind === "text")
        await this.runtime.dispatch("send", {
          chat_id: portal.chat,
          kind: "text",
          text: message.text,
          reply_to: reply,
        });
      else if (message.kind === "image") await this.runtime.sendImage(portal.chat, bytes!);
      else await this.runtime.sendFile(portal.chat, bytes!, name);
    } catch (error) {
      // Explicit preflight/rejection errors are safe failures; unknown native errors may have sent.
      const safe =
        error instanceof APIError &&
        ["invalid_params", "not_ready", "unsupported", "unverified", "send_failed"].includes(
          error.code,
        );
      this.store.run("UPDATE inbox SET state=? WHERE id=?", safe ? "failed" : "uncertain", job.id);
      throw error;
    }
    this.store.run("UPDATE inbox SET state='submitted' WHERE id=?", job.id);
    return "submitted";
  }
  private async jobs() {
    for (const job of this.store.inbox("queued").slice(0, 100)) {
      try {
        const state = await this.sendJob(job);
        if (state !== "wait") this.store.run("UPDATE inbox SET state=? WHERE id=?", state, job.id);
      } catch (error) {
        if (
          error instanceof APIError &&
          error.code === "not_ready" &&
          this.store.get<Inbox>("SELECT * FROM inbox WHERE id=?", job.id)?.state === "queued"
        )
          continue;
        const current = this.store.get<Inbox>("SELECT * FROM inbox WHERE id=?", job.id)!;
        const uncertain = current.state === "uncertain";
        await this.notice(
          JSON.parse(job.payload).room_id,
          uncertain
            ? "WeChat delivery is uncertain. This message will not be resent automatically."
            : `Unable to bridge: ${error instanceof Error ? error.message : "operation failed"}`,
          `failure:${job.id}`,
        );
        this.store.run(
          "UPDATE inbox SET state=?,notice=1 WHERE id=?",
          uncertain ? "uncertain" : "failed",
          job.id,
        );
      }
    }
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.status();
      if (this.runtime.status.state === "logged_in") {
        const bound = this.store.meta("account");
        if (bound && bound !== this.account) {
          await this.notice(
            this.management,
            "A different WeChat account is active. Use a separate deployment and database for that account.",
            `account-mismatch:${this.account}`,
          );
          return;
        }
        this.store.setMeta("account", this.account);
        if (Date.now() - this.lastMetadata >= 60000) await this.metadata();
      }
      await this.jobs();
      if (this.runtime.status.state !== "logged_in") return;
      for (const row of this.store.all<{ chat: string }>(
        "SELECT DISTINCT chat FROM incoming WHERE account=?",
        this.account,
      ))
        await this.ensurePortal(row.chat);
      const portals = this.store.portals(this.account);
      const start = this.rotation++ % Math.max(portals.length, 1);
      for (let index = 0; index < portals.length; index++) {
        if (this.stopped) break;
        const portal = portals[(start + index) % portals.length];
        try {
          await this.reconcile(portal);
        } catch (error) {
          this.lastError = error instanceof APIError ? error.code : "reconciliation_failed";
          console.error("Bridge reconciliation:", this.lastError);
        }
      }
      await this.redactions();
      await this.retryMedia();
    } catch (error) {
      this.lastError = error instanceof APIError ? error.code : "bridge_operation_failed";
      console.error("Bridge:", this.lastError);
    } finally {
      this.busy = false;
    }
  }
}
