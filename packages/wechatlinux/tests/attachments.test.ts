import { expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { decodeImageV2, receivedFile, receivedImage } from "../src/attachments";
import type { Message } from "../src/types";

const md5 = (input: string | Buffer) => createHash("md5").update(input).digest("hex");
const field = (id: number, value: Buffer) =>
  Buffer.concat([Buffer.from([id * 8 + 2, value.length]), value]);
const image = PNG.sync.write(new PNG({ width: 1, height: 1 }));
const accountID = "fixture_self",
  uin = "100001",
  cacheID = md5("fixture image");
async function fixture(kind: string) {
  const home = await mkdtemp(join(tmpdir(), "wechat-attachment-"));
  const account = join(home, "xwechat_files", accountID + "_" + md5(uin).slice(0, 4));
  const message: Message = {
    id: "9223372036854775806",
    account_id: accountID,
    chat_id: "filehelper",
    sender_id: accountID,
    own: true,
    chat_type: "direct",
    kind,
    timestamp: Date.UTC(2026, 9, 1) / 1000,
    native: { database: join(account, "db_storage/message/message_0.db"), row: {} },
  };
  return { home, account, message };
}
test("native V2 cache reconstruction verifies the original checksum and refuses account/path mixing", async () => {
  const { home, account, message } = await fixture("image");
  try {
    const key = Buffer.from(md5(uin + accountID).slice(0, 16)),
      cipher = createCipheriv("aes-128-ecb", key, null);
    const head = image.subarray(0, 32),
      middle = image.subarray(32, -8),
      tail = Buffer.from(image.subarray(-8));
    for (let i = 0; i < tail.length; i++) tail[i] ^= Number(uin) & 255;
    const header = Buffer.alloc(15);
    header.set(Buffer.from("070856320807", "hex"));
    header.writeUInt32LE(head.length, 6);
    header.writeUInt32LE(tail.length, 10);
    const encoded = Buffer.concat([header, cipher.update(head), cipher.final(), middle, tail]);
    expect(decodeImageV2(encoded, key, Number(uin) & 255).equals(image)).toBe(true);
    const directory = join(account, "msg/attach", md5("filehelper"), "2026-10/Img"),
      keys = join(home, ".xwechat/net/kvcomm");
    await mkdir(directory, { recursive: true });
    await mkdir(keys, { recursive: true });
    await writeFile(join(keys, `key_${uin}_fixture.statistic`), "");
    await writeFile(join(directory, cacheID + ".dat"), encoded);
    message.native!.decoded_content = `<msg><img md5="${md5(image)}"/></msg>`;
    message.native!.row.packed_info_data = {
      base64: field(3, field(4, Buffer.from(cacheID))).toString("base64"),
    };
    const asset = await receivedImage(message, home);
    expect(asset.type).toBe("image/png");
    expect(asset.bytes.equals(image)).toBe(true);
    await expect(
      receivedImage({ ...message, account_id: "other_account" }, home),
    ).rejects.toMatchObject({ code: "media_unavailable" });
    message.native!.decoded_content = '<msg><img md5="00000000000000000000000000000000"/></msg>';
    await expect(receivedImage(message, home)).rejects.toMatchObject({ code: "media_unavailable" });
  } finally {
    await rm(home, { recursive: true });
  }
});
test("file download uses native packed filename, size and checksum, and rejects traversal/corruption", async () => {
  const { home, account, message } = await fixture("file"),
    bytes = Buffer.from("fixture document"),
    name = "report.txt";
  try {
    const directory = join(account, "msg/file/2026-10");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), bytes);
    message.native!.decoded_content = `<msg><appmsg><title>Display name</title><md5>${md5(bytes)}</md5><appattach><totallen>${bytes.length}</totallen></appattach></appmsg></msg>`;
    const packed = (name: string) => ({
      base64: field(7, field(1, field(2, Buffer.from(name)))).toString("base64"),
    });
    message.native!.row.packed_info_data = packed(name);
    const asset = await receivedFile(message, home);
    expect(asset.name).toBe(name);
    expect(asset.bytes.equals(bytes)).toBe(true);
    await writeFile(join(directory, name), Buffer.from("wrong content"));
    await expect(receivedFile(message, home)).rejects.toMatchObject({ code: "media_unavailable" });
    message.native!.row.packed_info_data = packed("../../private");
    await expect(receivedFile(message, home)).rejects.toMatchObject({ code: "media_unavailable" });
  } finally {
    await rm(home, { recursive: true });
  }
});
