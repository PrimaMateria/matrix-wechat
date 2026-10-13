import type { Mapping, Store } from "./db";
import type { Matrix } from "./matrix";
import type { Message, Session } from "./types";
import { Unsupported } from "./types";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
export async function incoming(
  message: Message,
  session: Session,
  matrix: Matrix,
  store: Store,
): Promise<{ content: Record<string, any>; type: string; pending: boolean }> {
  let content: Record<string, any> = {
      msgtype: message.kind === "system" || message.kind === "unknown" ? "m.notice" : "m.text",
      body: message.text || `[WeChat ${message.kind} message]`,
    },
    type = "m.room.message",
    pending = false;
  if (message.link) {
    const url = new URL(message.link.url);
    if (["http:", "https:"].includes(url.protocol))
      content = {
        msgtype: "m.text",
        body: [message.link.title, message.link.description, url.href].filter(Boolean).join("\n"),
        format: "org.matrix.custom.html",
        formatted_body: `<a href="${escape(url.href)}">${escape(message.link.title)}</a><br>${escape(message.link.description)}`,
      };
  }
  if (message.location)
    content = {
      msgtype: "m.location",
      body: message.location.label || "Shared location",
      geo_uri: `geo:${message.location.latitude},${message.location.longitude}`,
    };
  if (["image", "sticker", "video", "audio", "file"].includes(message.kind)) {
    try {
      const asset = await session.media(message.chat_id, message.id);
      if (asset.bytes.length > matrix.config.bridge.max_media_size)
        throw new Unsupported("Attachment exceeds the bridge size limit");
      const url = await matrix.upload(asset);
      content = {
        msgtype: (
          {
            image: "m.image",
            sticker: "m.image",
            video: "m.video",
            audio: "m.audio",
            file: "m.file",
          } as Record<string, string>
        )[message.kind],
        body:
          asset.name ||
          message.media?.name ||
          `${message.kind}.${asset.type.split("/")[1] || "bin"}`,
        url,
        info: { mimetype: asset.type, size: asset.bytes.length },
      };
      if (message.kind === "sticker") {
        type = "m.sticker";
        delete content.msgtype;
      }
      if (message.kind === "audio") {
        content["org.matrix.msc3245.voice"] = {};
        content["org.matrix.msc1767.audio"] = {};
      }
    } catch (error) {
      if (
        !(error instanceof Unsupported) &&
        (!error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["media_unavailable", "not_found", "unverified"].includes(String(error.code)))
      )
        throw error;
      pending = true;
      content = {
        msgtype: "m.notice",
        body: `[WeChat ${message.kind}${message.media?.name ? ": " + message.media.name : ""}: attachment unavailable; retry with !wechat retry-media]`,
      };
    }
  }
  if (message.mentions?.length)
    content["m.mentions"] = {
      user_ids: message.mentions
        .filter((id) => id !== "notify@all")
        .map((id) => matrix.ghost(message.account_id, id)),
      room: message.mentions.includes("notify@all"),
    };
  if (message.reply_to) {
    const parent = store.mapping(message.account_id, message.chat_id, message.reply_to);
    if (parent) content["m.relates_to"] = { "m.in_reply_to": { event_id: parent.event } };
    else if (message.quote?.text)
      content.body = `> ${message.quote.sender_name || message.quote.sender_id}: ${message.quote.text}\n\n${content.body}`;
  }
  return { content, type, pending };
}
export function saveMapping(
  store: Store,
  message: Message,
  event: string,
  sender: string,
  pending = false,
) {
  const mapping: Mapping = {
    account: message.account_id,
    chat: message.chat_id,
    remote: message.id,
    local: message.local_key || null,
    event,
    sender,
    media_pending: pending ? 1 : 0,
    payload: pending ? JSON.stringify(message) : null,
  };
  store.map(mapping);
}
export function outboundText(content: Record<string, any>): string {
  let text = String(content.body || "").replace(/^>.*(?:\n>.*)*\n\n/, "");
  if (typeof content.formatted_body === "string")
    for (const match of content.formatted_body.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
      const link = match[1].replaceAll("&amp;", "&");
      if (!text.includes(link)) text += "\n" + link;
    }
  return text;
}
