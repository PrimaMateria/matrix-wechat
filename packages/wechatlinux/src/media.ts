import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { protobufBytes } from "./protobuf";
import { APIError, type Message } from "./types";
export function imageType(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  return undefined;
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
  const root = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: false,
    }).parse(content),
    emoji = root.msg?.emoji || root.msg?.emoticon;
  const app = root.msg?.appmsg;
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
