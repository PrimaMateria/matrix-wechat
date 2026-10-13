import {
  assert,
  bridgeName,
  capture,
  database,
  engine,
  fileTransferRoom,
  matrix,
  native,
  ready,
  run,
  runtimeName,
  waitFor,
} from "./stack";

export async function restart() {
  const before = await capture();
  await run([engine, "restart", "--time", "20", bridgeName]);
  await waitFor("bridge restart and history reconciliation", ready, 240000);
  const mappings = await capture();
  assert(
    before.every((previous) =>
      mappings.some(
        (now) =>
          now.chat === previous.chat && now.id === previous.id && now.event === previous.event,
      ),
    ),
    "restart preserves exact message mappings without replay",
  );
  console.log("Restart deduplication passed against the real account");
  return { mappingsPreserved: true };
}

export async function outage() {
  const room = fileTransferRoom();
  await run([engine, "stop", "--time", "20", runtimeName]);
  const recoveryText = `Runtime restart recovery ${crypto.randomUUID()}`;
  const recovery = await matrix(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`,
    "PUT",
    { msgtype: "m.text", body: recoveryText },
  );
  await waitFor("queued send during runtime outage", async () => {
    const db = database();
    try {
      return (
        db.query<any, [string]>("SELECT state FROM inbox WHERE id=?").get(recovery.event_id)
          ?.state === "queued"
      );
    } finally {
      db.close();
    }
  });
  await run([engine, "start", runtimeName]);
  await waitFor(
    "send after runtime login resumes",
    async () => {
      const db = database();
      try {
        return (
          db.query<any, [string]>("SELECT state FROM inbox WHERE id=?").get(recovery.event_id)
            ?.state === "delivered"
        );
      } finally {
        db.close();
      }
    },
    240000,
  );
  assert(
    (await native("/api/history?chat_id=filehelper&limit=500")).messages.filter(
      (m: any) => m.own && m.text === recoveryText,
    ).length === 1,
    "a queued Matrix send survives runtime restart and is delivered exactly once",
  );
  console.log("Runtime outage and login recovery passed against File Transfer");
  return { deliveredExactlyOnce: true };
}
