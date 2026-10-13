import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppService, AppServiceRegistration, Bridge as BridgeSDK } from "matrix-appservice-bridge";
import type { Config } from "./config";
import type { Store } from "./db";
import type { Asset } from "./types";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class Matrix {
  readonly sdk: BridgeSDK;
  readonly bot: string;
  constructor(readonly config: Config) {
    this.bot = `@${config.appservice.bot}:${config.homeserver.domain}`;
    const registration = new AppServiceRegistration(config.appservice.address);
    registration.setId(config.appservice.id);
    registration.setHomeserverToken(config.appservice.hs_token);
    registration.setAppServiceToken(config.appservice.as_token);
    registration.setSenderLocalpart(config.appservice.bot);
    registration.setRateLimited(false);
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    registration.addRegexPattern(
      "users",
      `^@${escape(config.appservice.prefix)}[a-f0-9]+:${escape(config.homeserver.domain)}$`,
      true,
    );
    registration.addRegexPattern(
      "aliases",
      `^#${escape(config.appservice.prefix)}[a-f0-9]+:${escape(config.homeserver.domain)}$`,
      true,
    );
    this.sdk = new BridgeSDK({
      registration,
      homeserverUrl: config.homeserver.address,
      domain: config.homeserver.domain,
      networkName: "WeChat",
      disableStores: true,
      suppressEcho: false,
      logRequestOutcome: false,
      controller: {
        onEvent(request) {
          request.resolve(undefined);
        },
      },
    });
  }
  get intent() {
    return this.sdk.getIntent();
  }
  ghost(account: string, user: string) {
    return `@${this.config.appservice.prefix}${digest(JSON.stringify([account, user]))}:${this.config.homeserver.domain}`;
  }
  alias(account: string, chat: string) {
    return `#${this.config.appservice.prefix}${digest(JSON.stringify([account, chat]))}:${this.config.homeserver.domain}`;
  }
  async start(store: Store) {
    await this.sdk.initialise();
    const service = new AppService({ homeserverToken: this.config.appservice.hs_token });
    // Persist the entire transaction before the SDK's HTTP acknowledgement.
    service.expressApp.param(
      "txnId",
      (req: Request, res: Response, next: NextFunction, transaction: string) => {
        const bearer = req.headers.authorization?.replace(/^Bearer /, "");
        if (
          bearer !== this.config.appservice.hs_token ||
          (req.query.access_token !== undefined && req.query.access_token !== bearer)
        ) {
          res.status(401).json({ errcode: "M_UNAUTHORIZED", error: "Invalid homeserver token" });
          return;
        }
        const events = req.body?.events;
        if (
          !Array.isArray(events) ||
          events.some(
            (event) =>
              !event ||
              typeof event.event_id !== "string" ||
              typeof event.room_id !== "string" ||
              typeof event.sender !== "string" ||
              typeof event.type !== "string" ||
              !event.content ||
              typeof event.content !== "object",
          )
        ) {
          res.status(400).json({ errcode: "M_BAD_JSON", error: "Invalid events" });
          return;
        }
        try {
          store.intake(transaction, events);
          next();
        } catch {
          res
            .status(500)
            .json({ errcode: "M_UNKNOWN", error: "Transaction could not be persisted" });
        }
      },
    );
    await this.sdk.listen(
      this.config.appservice.port,
      this.config.appservice.hostname,
      10,
      service,
    );
  }
  close() {
    return this.sdk.close();
  }
  register(user: string) {
    return this.sdk.getIntent(user).ensureRegistered();
  }
  join(room: string, user: string) {
    return this.sdk.getIntent(user).join(room);
  }
  async encrypted(room: string) {
    return !!(await this.intent.getStateEvent(room, "m.room.encryption", "", true))?.algorithm;
  }
  state(room: string, type: string, content: Record<string, unknown>, key = "") {
    return this.intent.sendStateEvent(room, type, key, content);
  }
  async upload(asset: Asset) {
    if (asset.bytes.length > this.config.bridge.max_media_size)
      throw Error("Attachment exceeds the bridge size limit");
    return this.intent.uploadContent(asset.bytes, { name: asset.name, type: asset.type });
  }
  // Intent.sendMessage doesn't expose replay-safe transaction IDs or timestamps.
  async send(
    room: string,
    sender: string,
    content: Record<string, unknown>,
    transaction: string,
    timestamp?: number,
    type = "m.room.message",
  ) {
    const intent = this.sdk.getIntent(sender);
    await intent.join(room);
    return intent.matrixClient.doRequest(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${type}/${encodeURIComponent(transaction)}`,
      timestamp === undefined ? {} : { ts: Math.floor(timestamp) },
      content,
    );
  }
  redact(room: string, event: string, transaction: string) {
    return this.intent.matrixClient.doRequest(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/redact/${encodeURIComponent(event)}/${encodeURIComponent(transaction)}`,
      {},
      { reason: "Revoked in WeChat" },
    );
  }
  async download(mxc: string) {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
    if (!match) throw Error("A valid Matrix media URL is required");
    // Stream authenticated media to enforce limits even without Content-Length.
    const url =
      this.config.homeserver.address.replace(/\/$/, "") +
      `/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
    const response = await fetch(url, {
      redirect: "error",
      headers: { Authorization: `Bearer ${this.config.appservice.as_token}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw Error(`Matrix media download failed (${response.status})`);
    if (Number(response.headers.get("content-length") || 0) > this.config.bridge.max_media_size) {
      await response.body?.cancel();
      throw Error("Attachment exceeds the bridge size limit");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > this.config.bridge.max_media_size)
          throw Error("Attachment exceeds the bridge size limit");
        chunks.push(chunk);
      }
    return Buffer.concat(chunks);
  }
}
