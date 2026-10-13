import {
  assert,
  botRequest,
  database,
  fileTransferRoom,
  matrix,
  native,
  registration,
  secret,
  waitFor,
} from "./stack";

export async function permissions() {
  const room = fileTransferRoom();
  const guestNonce = (await matrix("/_synapse/admin/v1/register")).nonce;
  const guestPassword = crypto.randomUUID();
  const guestMac = new Bun.CryptoHasher("sha1", secret)
    .update(`${guestNonce}\0observer\0${guestPassword}\0notadmin`)
    .digest("hex");
  const guest = await matrix("/_synapse/admin/v1/register", "POST", {
    nonce: guestNonce,
    username: "observer",
    password: guestPassword,
    admin: false,
    mac: guestMac,
  });
  await botRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`, {
    user_id: guest.user_id,
  });
  const guestJoin = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/join/${encodeURIComponent(room)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guest.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert(guestJoin.ok, "second Matrix user joins the real portal");
  const forbiddenText = `Permission acceptance ${crypto.randomUUID()}`;
  const guestSend = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${guest.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ msgtype: "m.text", body: forbiddenText }),
    },
  );
  assert(guestSend.ok, "second Matrix user sends a real event");
  const guestEvent = (await guestSend.json()) as any;
  // Synapse reserves this event type for the room's elevated users, even without state_key.
  const falseEncryption = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.encryption/${crypto.randomUUID()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.getAppServiceToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ algorithm: "m.megolm.v1.aes-sha2" }),
    },
  );
  assert(falseEncryption.ok, "bot sends a real non-state encryption event");
  const marker = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: `Owner permission barrier ${crypto.randomUUID()}` },
  );
  await waitFor("owner event after unauthorized sender", async () => {
    const db = database();
    try {
      return Boolean(
        db
          .query<any, [string]>("SELECT id FROM inbox WHERE id=? AND state='delivered'")
          .get(marker.event_id),
      );
    } finally {
      db.close();
    }
  });
  const permissionsDB = database();
  assert(
    !permissionsDB.query<any, [string]>("SELECT id FROM inbox WHERE id=?").get(guestEvent.event_id),
    "only the configured owner can enqueue native sends",
  );
  permissionsDB.close();
  assert(
    !(await native("/api/history?chat_id=filehelper&limit=500")).messages.some(
      (m: any) => m.text === forbiddenText,
    ),
    "unauthorized Matrix messages never reach WeChat",
  );
  await botRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/kick`, {
    user_id: guest.user_id,
  });
  return { ownerOnly: true };
}

export async function encryption() {
  const room = fileTransferRoom();
  const encryption = await fetch(
    `http://127.0.0.1:18008/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.encryption/`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.getAppServiceToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ algorithm: "m.megolm.v1.aes-sha2" }),
    },
  );
  assert(encryption.ok, "actual portal is marked encrypted");
  const encryptedText = `Encryption acceptance ${crypto.randomUUID()}`;
  const rejected = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: encryptedText },
  );
  await waitFor("encrypted room rejection", async () => {
    const db = database();
    try {
      return Boolean(
        db
          .query<any, [string]>("SELECT id FROM inbox WHERE id=? AND state='failed'")
          .get(rejected.event_id),
      );
    } finally {
      db.close();
    }
  });
  assert(
    !(await native("/api/history?chat_id=filehelper&limit=500")).messages.some(
      (m: any) => m.text === encryptedText,
    ),
    "encrypted-room messages never reach WeChat",
  );
  return { rejected: true };
}
