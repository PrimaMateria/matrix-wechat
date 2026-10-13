import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { stickerImage, stickerMetadata } from "../src/media";
import type { Message } from "../src/types";

const image = PNG.sync.write(new PNG({ width: 1, height: 1 })),
  md5 = createHash("md5").update(image).digest("hex");
const message = (url = "http://snsvideo.c2c.wechat.com/120/20201/stodownload"): Message => ({
  id: "123",
  account_id: "fixture_self",
  chat_id: "fixture_friend",
  sender_id: "fixture_self",
  chat_type: "direct",
  kind: "sticker",
  timestamp: 100,
  own: true,
  native: {
    decoded_content: `<msg><emoji md5='${md5}' aeskey='private-fixture' cdnurl='${url}'/></msg>`,
  },
});
test("app subtype-8 GIF metadata resolves its protobuf MD5 and original CDN URL", () => {
  const url = "http://snsvideo.c2c.wechat.com/120/20201/stodownload";
  const bytes = Buffer.concat([
    Buffer.from([10, 32]),
    Buffer.from(md5),
    Buffer.from([18, url.length]),
    Buffer.from(url),
  ]);
  const msg = message();
  msg.native!.decoded_content = `<msg><appmsg><type>8</type><appattach><emojiinfo>${bytes.toString("base64")}</emojiinfo></appattach></appmsg></msg>`;
  expect(stickerMetadata(msg)).toEqual({ md5, url });
});
test("native emoji XML supports single quotes and does not export its media key", () => {
  const metadata = stickerMetadata(message());
  expect(metadata.md5).toBe(md5);
  expect(JSON.stringify(metadata)).not.toContain("private-fixture");
});
test("verified cached image bytes are preserved and separated by account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wechat-media-test-"));
  try {
    const key = createHash("sha256")
      .update("fixture_self:" + md5)
      .digest("hex");
    await writeFile(join(directory, key), image);
    const asset = await stickerImage(message(), directory);
    expect(asset.type).toBe("image/png");
    expect(asset.bytes.equals(image)).toBe(true);
    const other = {
      ...message("http://127.0.0.1/secret"),
      account_id: "different_account",
    };
    await expect(stickerImage(other, directory)).rejects.toMatchObject({
      code: "media_unavailable",
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});
test("reject native XML entity declarations and arbitrary media URLs", async () => {
  const msg = message("http://127.0.0.1/secret");
  await expect(stickerImage(msg, "/nonexistent-fixture-cache")).rejects.toMatchObject({
    code: "media_unavailable",
  });
  msg.native!.decoded_content = '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><msg/>';
  expect(() => stickerMetadata(msg)).toThrow();
});
