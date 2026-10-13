import type { Asset, Message } from "./messages";
import { unsupported } from "./messages";
import { hash } from "./store";

export const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export function ghostID(account: string, id: string, domain: string) {
  return `@wechat_${hash(JSON.stringify([account, id]))}:${domain}`;
}
function dimensions(bytes: Buffer, mime: string): { w: number; h: number } | undefined {
  if (mime === "image/png" && bytes.length >= 24)
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  if (mime === "image/gif" && bytes.length >= 10)
    return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
  if (mime === "image/webp" && bytes.length >= 30 && bytes.subarray(12, 16).toString() === "VP8X")
    return { w: 1 + bytes.readUIntLE(24, 3), h: 1 + bytes.readUIntLE(27, 3) };
  if (mime === "image/jpeg") {
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1],
        size = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker))
        return { h: bytes.readUInt16BE(offset + 5), w: bytes.readUInt16BE(offset + 7) };
      if (size < 2) break;
      offset += 2 + size;
    }
  }
}
export function messageFingerprint(message: Message) {
  const { native: _native, id: _id, local_key: _local, media, ...rest } = message;
  return hash(
    JSON.stringify({
      ...rest,
      media: media && { kind: media.kind, name: media.name, size: media.size },
    }),
  );
}
export function incoming(
  message: Message,
  options: {
    asset?: Asset;
    mxc?: string;
    replyEvent?: string;
    ghost: (id: string) => string;
    owner: string;
    missingMedia?: boolean;
  },
) {
  let type = "m.room.message";
  let content: Record<string, any> = {
    msgtype: "m.text",
    body: message.text || `[${message.kind}]`,
  };
  if (message.kind === "system" || message.kind === "unknown") content.msgtype = "m.notice";
  if (message.kind === "link" && message.link) {
    const { title, description, url } = message.link;
    let safe = false;
    try {
      const parsed = new URL(url);
      safe = ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {}
    if (safe)
      content = {
        msgtype: "m.text",
        body: [title, description, url].filter(Boolean).join("\n"),
        format: "org.matrix.custom.html",
        formatted_body: `<a href="${escapeHTML(url)}">${escapeHTML(title)}</a>${description ? `<br>${escapeHTML(description)}` : ""}`,
      };
  }
  if (message.kind === "location" && message.location) {
    const { latitude, longitude, label } = message.location;
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    )
      content = {
        msgtype: "m.location",
        body: label || `${latitude}, ${longitude}`,
        geo_uri: `geo:${latitude},${longitude}`,
      };
  }
  if (options.asset && options.mxc) {
    const asset = options.asset;
    const msgtype = (
      {
        image: "m.image",
        sticker: "m.image",
        video: "m.video",
        audio: "m.audio",
        file: "m.file",
      } as Record<string, string>
    )[message.kind];
    content = {
      msgtype,
      body:
        asset.name ||
        message.media?.name ||
        `${message.kind}.${({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "audio/wav": "wav", "video/mp4": "mp4" } as Record<string, string>)[asset.type] || "bin"}`,
      url: options.mxc,
      info: {
        mimetype: asset.type,
        size: asset.bytes.length,
        ...dimensions(asset.bytes, asset.type),
      },
    };
    if (message.kind === "sticker") {
      type = "m.sticker";
      delete content.msgtype;
    }
  } else if (options.missingMedia)
    content = {
      msgtype: "m.notice",
      body: `[${message.kind} unavailable in the local WeChat cache]${message.media?.name ? ` ${message.media.name}` : ""}`,
    };
  if (message.reply_to) {
    if (options.replyEvent)
      content["m.relates_to"] = { "m.in_reply_to": { event_id: options.replyEvent } };
    else if (message.quote?.text)
      content.body = `> ${message.quote.text.split("\n").join("\n> ")}\n\n${content.body}`;
  }
  if (message.mentions?.length)
    content["m.mentions"] = {
      user_ids: [
        ...new Set(
          message.mentions
            .filter((id) => id !== "notify@all")
            .map((id) => (id === message.account_id ? options.owner : options.ghost(id))),
        ),
      ],
      ...(message.mentions.includes("notify@all") ? { room: true } : {}),
    };
  return { type, content };
}
export function outgoing(content: Record<string, any>) {
  if (content.file) unsupported("Encrypted attachments");
  if (content["m.relates_to"]?.rel_type === "m.replace") unsupported("Message editing");
  if (typeof content.body !== "string") throw new Error("Message body is required");
  const reply = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  if (["m.text", "m.emote"].includes(content.msgtype)) {
    // Matrix reply fallback is followed by a blank line. Literal quoted messages are preserved.
    const text =
      reply && content.body.startsWith("> ")
        ? content.body.replace(/^(?:>[^\n]*\n)+\n/, "")
        : content.body;
    if (!text.trim() || Buffer.byteLength(text) > 65536)
      throw new Error("Text must contain 1–65536 UTF-8 bytes");
    return {
      kind: "text" as const,
      text: content.msgtype === "m.emote" ? `* ${text}` : text,
      reply,
    };
  }
  if (["m.image", "m.file", "m.video"].includes(content.msgtype)) {
    if (reply) unsupported("Attachment replies");
    if (typeof content.url !== "string" || !/^mxc:\/\/[^/]+\/[^/?#]+$/.test(content.url))
      throw new Error("A Matrix media URL is required");
    return {
      kind: content.msgtype === "m.image" ? ("image" as const) : ("file" as const),
      url: content.url,
      name: String(content.filename || content.body),
      video: content.msgtype === "m.video",
    };
  }
  unsupported(`Sending ${content.msgtype || "this message type"}`);
}
