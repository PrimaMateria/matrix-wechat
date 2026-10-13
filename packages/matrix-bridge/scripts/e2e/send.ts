import { hash } from "../../src/store";
import {
  assert,
  capture,
  database,
  delivered,
  fileTransferRoom,
  matrix,
  native,
  source,
  token,
  waitFor,
} from "./stack";

let reference: { sent: { event_id: string }; sourceSelf: any } | undefined;
export async function text() {
  const room = fileTransferRoom();
  const text = `Matrix bridge live acceptance ${crypto.randomUUID()} — Unicode 回复`;
  const sent = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: text },
  );
  await delivered(sent.event_id);
  const sourceSelf = (await native("/api/history?chat_id=filehelper&limit=500")).messages.find(
    (m: any) => m.text === text,
  );
  assert(
    sourceSelf?.own && /^\d+$/.test(sourceSelf.id) && sourceSelf.id !== "0",
    "native server ID confirms the Matrix self-send",
  );
  reference = { sent, sourceSelf };
  return { sourceConfirmed: true };
}
export async function quote() {
  if (!reference) await text();
  const { sent, sourceSelf } = reference!;
  const room = fileTransferRoom();
  const reply = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    {
      msgtype: "m.text",
      body: `Live Matrix quote acceptance ${crypto.randomUUID()} 回复`,
      "m.relates_to": { "m.in_reply_to": { event_id: sent.event_id } },
    },
  );
  await delivered(reply.event_id);
  assert(
    (await native("/api/history?chat_id=filehelper&limit=500")).messages.some(
      (m: any) => m.reply_to === sourceSelf.id && m.own && /^\d+$/.test(m.id),
    ),
    "Matrix reply references the exact native server ID",
  );
  console.log("Actual Matrix → WeChat text and quoted reply delivery passed (File Transfer only)");
  return { sourceConfirmed: true, exactReplyTarget: true };
}
export async function media(kind: "image" | "file" | "video") {
  const room = fileTransferRoom(),
    mappings = await capture();
  const candidate = source.find(
    (message) =>
      message.kind === kind &&
      mappings.some(
        (mapping) =>
          mapping.chat === message.chat_id && mapping.id === message.id && !mapping.media_retry,
      ),
  );
  assert(candidate, `real cached ${kind} is available for outbound acceptance`);
  const asset = await fetch(
    `http://127.0.0.1:18742/api/media?chat_id=${encodeURIComponent(candidate.chat_id)}&message_id=${encodeURIComponent(candidate.id)}`,
  );
  assert(asset.ok, `actual ${kind} cache read`);
  const bytes = new Uint8Array(await asset.arrayBuffer());
  const mime = asset.headers.get("Content-Type") || "application/octet-stream";
  const extension =
    kind === "video"
      ? "mp4"
      : kind === "file"
        ? "bin"
        : mime === "image/png"
          ? "png"
          : mime === "image/gif"
            ? "gif"
            : "jpg";
  const name = `native-cache-${crypto.randomUUID()}.${extension}`;
  const upload = await fetch(
    `http://127.0.0.1:18008/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
      body: bytes,
    },
  );
  assert(upload.ok, `real ${kind} Matrix upload`);
  const mxc = ((await upload.json()) as any).content_uri;
  const event = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    {
      msgtype: kind === "image" ? "m.image" : kind === "video" ? "m.video" : "m.file",
      body: name,
      filename: name,
      url: mxc,
      info: { mimetype: mime, size: bytes.length },
    },
  );
  let nativeID = "";
  await waitFor(`source-confirmed native ${kind} upload`, async () => {
    const db = database();
    try {
      const result = db
        .query<any, [string]>(
          "SELECT messages.id FROM inbox JOIN messages ON messages.event=inbox.id WHERE inbox.id=? AND inbox.state='delivered'",
        )
        .get(event.event_id);
      nativeID = result?.id || "";
      return Boolean(nativeID);
    } finally {
      db.close();
    }
  });
  assert(/^\d+$/.test(nativeID) && nativeID !== "0", `native ${kind} has an exact server ID`);
  const received = await fetch(
    `http://127.0.0.1:18742/api/media?chat_id=filehelper&message_id=${encodeURIComponent(nativeID)}`,
  );
  assert(
    received.ok && hash(new Uint8Array(await received.arrayBuffer())) === hash(bytes),
    `actual ${kind} upload bytes survive native delivery`,
  );
  return { kind, exactBytes: true };
}
