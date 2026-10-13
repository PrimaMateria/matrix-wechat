import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { protobufBytes } from "./protobuf";
import { APIError, type Message } from "./types";
export { imageType } from "wechat-rpc/types";
import { imageType } from "wechat-rpc/types";
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
});
export function messageMetadata(message: Message) {
  const content = message.native?.decoded_content;
  if (
    typeof content !== "string" ||
    content.length > 2097152 ||
    /<!DOCTYPE|<!ENTITY/i.test(content)
  )
    throw new APIError("media_unavailable", "Message metadata is unavailable");
  const root = xml.parse(content);
  return root.msg || root;
}
export function channelMedia(app: any) {
  const media = app?.finderFeed?.mediaList?.media;
  return Array.isArray(media) ? media[0] : media;
}
// Fetch only media explicitly supplied by a shared card. Native CDN tokens and
// signed URLs stay inside the runtime rather than being exposed to the browser.
export async function sharedCardAsset(message: Message, directory: string, thumbnail = false) {
  const app = messageMetadata(message).appmsg,
    media = channelMedia(app);
  const urls = thumbnail ? [media?.coverUrl, media?.thumbUrl, app?.thumburl] : [media?.url];
  const source = urls
    .flat()
    .find((value) => typeof value === "string" && /^https?:\/\//.test(value));
  if (!source) throw new APIError("media_unavailable", "Shared card media is unavailable");
  const url = new URL(source);
  if (
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === "wxapp.tc.qq.com" || url.hostname.endsWith(".qpic.cn"))
  )
    throw new APIError("media_unavailable", "Unsupported shared card media source");
  url.protocol = "https:";
  const file = join(
    directory,
    createHash("sha256")
      .update(`${message.account_id}:${message.chat_id}:${message.id}:${thumbnail}:${source}`)
      .digest("hex"),
  );
  try {
    const bytes = await readFile(file),
      type = thumbnail
        ? imageType(bytes)
        : bytes.subarray(4, 8).toString() === "ftyp"
          ? "video/mp4"
          : undefined;
    if (type) return { bytes, type };
  } catch {}
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body)
    throw new APIError("media_unavailable", "Shared card media download failed");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  while (length < 12) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const head = Buffer.concat(chunks),
    type = thumbnail
      ? imageType(head)
      : head.subarray(4, 8).toString() === "ftyp"
        ? "video/mp4"
        : undefined;
  if (!type) {
    await reader.cancel();
    throw new APIError(
      thumbnail ? "media_unavailable" : "unsupported",
      thumbnail
        ? "Shared card image is unavailable"
        : "The Channels video is encrypted; the current package cannot decode it",
    );
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, type };
}
export function stickerMetadata(message: Message) {
  const content = message.native?.decoded_content;
  if (
    message.kind !== "sticker" ||
    typeof content !== "string" ||
    content.length > 2097152 ||
    /<!DOCTYPE|<!ENTITY/i.test(content)
  )
    throw new APIError("media_unavailable", "Sticker data is unavailable");
  const root = messageMetadata(message),
    emoji = root.emoji || root.emoticon;
  const app = root.appmsg;
  if (!emoji && String(app?.type) === "8" && typeof app.appattach?.emojiinfo === "string") {
    const bytes = Buffer.from(app.appattach.emojiinfo, "base64");
    const md5 = protobufBytes(bytes, 1)?.toString(),
      url = protobufBytes(bytes, 2)?.toString();
    if (md5 && /^[a-f0-9]{32}$/i.test(md5) && url) return { md5: md5.toLowerCase(), url };
  }
  if (!emoji || !/^[a-f0-9]{32}$/i.test(emoji.md5))
    throw new APIError("media_unavailable", "Sticker metadata is unavailable");
  return {
    md5: String(emoji.md5).toLowerCase(),
    url: String(emoji.cdnurl || ""),
  };
}
export async function stickerImage(message: Message, directory: string) {
  const metadata = stickerMetadata(message),
    matches = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex") === metadata.md5;
  const file = join(
    directory,
    createHash("sha256")
      .update(message.account_id + ":" + metadata.md5)
      .digest("hex"),
  );
  try {
    const bytes = await readFile(file),
      type = imageType(bytes);
    if (type && matches(bytes)) return { bytes, type };
  } catch {}
  let url: URL;
  try {
    url = new URL(metadata.url);
  } catch {
    throw new APIError("media_unavailable", "Sticker URL is unavailable");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["snsvideo.c2c.wechat.com", "vweixinf.tc.qq.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443") ||
    !url.pathname.endsWith("/stodownload")
  )
    throw new APIError("media_unavailable", "Unsupported sticker media source");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new APIError("media_unavailable", "Sticker download failed");
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 16 * 1024 * 1024) {
      await reader.cancel();
      throw new APIError("media_unavailable", "Sticker exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks),
    type = imageType(bytes);
  if (!type || !matches(bytes))
    throw new APIError("media_unavailable", "Sticker image verification failed");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, type };
}
