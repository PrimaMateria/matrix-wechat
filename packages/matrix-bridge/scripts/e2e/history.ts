import { hash } from "../../src/store";
import { account, assert, capture, database, matrix, source, token } from "./stack";

export async function history() {
  const mappings = await capture();
  let media = 0,
    thumbnails = 0,
    unavailable = 0;
  const kinds = new Set<string>();
  for (const message of source) {
    const mapping = mappings.find(
      (m) => m.account === account && m.chat === message.chat_id && m.id === message.id,
    );
    assert(mapping, "every native cached message has a SQLite mapping");
    const db = database();
    const { room } = db
      .query<any, [string]>("SELECT room FROM portals WHERE chat=?")
      .get(message.chat_id);
    db.close();
    const event = await matrix(
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(mapping.event)}`,
    );
    assert(
      !("native" in event.content) && !("build_hash" in event.content),
      "private native metadata never crosses to Matrix",
    );
    if (message.kind === "text")
      assert(
        event.content.body === message.text || event.content.body.endsWith(message.text),
        "actual native text survives conversion",
      );
    if (message.payment)
      assert(
        event.content.msgtype === "m.notice" &&
          event.content.format === "org.matrix.custom.html" &&
          event.content.body.includes("Read only"),
        "native payments arrive as read-only rich cards",
      );
    if (message.link?.thumbnail) {
      const thumbnail =
        event.content["com.beeper.linkpreviews"]?.[0]?.["og:image"] ||
        event.content.formatted_body?.match(/src="(mxc:[^"]+)"/)?.[1];
      assert(thumbnail, "shared card has a Matrix thumbnail");
      const [, host, id] = thumbnail.match(/^mxc:\/\/([^/]+)\/(.+)$/);
      const uploaded = await fetch(
        `http://127.0.0.1:18008/_matrix/client/v1/media/download/${host}/${id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const nativeThumbnail = await fetch(
        `http://127.0.0.1:18742/api/thumbnail?chat_id=${encodeURIComponent(message.chat_id)}&message_id=${encodeURIComponent(message.id)}`,
      );
      assert(
        uploaded.ok &&
          nativeThumbnail.ok &&
          hash(new Uint8Array(await uploaded.arrayBuffer())) ===
            hash(new Uint8Array(await nativeThumbnail.arrayBuffer())),
        "shared card thumbnail exactly matches native bytes",
      );
      if (message.kind === "link")
        assert(
          event.content.formatted_body?.includes("<td>"),
          "article thumbnail sits beside its text",
        );
      thumbnails++;
    }
    if (event.content.url) {
      const asset = event.content.url.match(/^mxc:\/\/([^/]+)\/(.+)$/);
      assert(asset, "received media is uploaded to Matrix");
      const response = await fetch(
        `http://127.0.0.1:18008/_matrix/client/v1/media/download/${asset[1]}/${asset[2]}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert(response.ok, "authenticated Matrix media download");
      const sourceResponse = await fetch(
        `http://127.0.0.1:18742/api/media?chat_id=${encodeURIComponent(message.chat_id)}&message_id=${encodeURIComponent(message.id)}`,
      );
      assert(sourceResponse.ok, "native media is available");
      assert(
        hash(new Uint8Array(await response.arrayBuffer())) ===
          hash(new Uint8Array(await sourceResponse.arrayBuffer())),
        "Matrix media exactly matches real native media bytes",
      );
      media++;
    } else if (mapping.media_retry) unavailable++;
    kinds.add(message.kind);
  }
  console.log(
    `Imported real history: ${mappings.length} SQLite mappings; ${media} exact media matches; ${unavailable} explicit unavailable attachments; kinds: ${[...kinds].join(", ")}`,
  );
  return { messages: mappings.length, media, thumbnails, unavailable, kinds: [...kinds] };
}
