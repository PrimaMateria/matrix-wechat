import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { loadConfig } from "../src/config";
import { generateRegistration, Matrix } from "../src/matrix";

afterEach(() => mock.restore());

async function fixture(token: string | undefined = "owner-secret", membership = "invite") {
  const config = await loadConfig(
    new URL("../../../example-config.yaml", import.meta.url).pathname,
  );
  const matrix = new Matrix(
    config,
    generateRegistration(config),
    () => {},
    () => false,
    token,
  );
  spyOn(matrix.sdk, "getIntent").mockReturnValue({
    matrixClient: { getRoomStateEventContent: async () => ({ membership }) },
  } as unknown as ReturnType<Matrix["sdk"]["getIntent"]>);
  return matrix;
}

test("accepts an invitation as the configured owner and avoids repeated joins", async () => {
  const matrix = await fixture();
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ room_id: "!room:example.com" }),
  );
  await matrix.joinOwner("!room:example.com");
  await matrix.joinOwner("!room:example.com");
  expect(request).toHaveBeenCalledTimes(1);
  const [url, options] = request.mock.calls[0];
  expect(new URL(String(url)).searchParams.get("user_id")).toBe(matrix.config.bridge.owner);
  expect(new URL(String(url)).pathname).toBe("/_matrix/client/v3/join/!room%3Aexample.com");
  expect(options?.method).toBe("POST");
  expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer owner-secret");
});

test("leaves invite-only deployments and voluntary departures unchanged", async () => {
  const request = spyOn(globalThis, "fetch");
  const disabled = await fixture("");
  await disabled.joinOwner("!room:example.com");
  const departed = await fixture("owner-secret", "leave");
  await departed.joinOwner("!room:example.com");
  const joined = await fixture("owner-secret", "join");
  await joined.joinOwner("!room:example.com");
  expect(request).not.toHaveBeenCalled();
});

test("retries a failed owner join instead of caching success", async () => {
  const matrix = await fixture();
  const request = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ room_id: "!room:example.com" }));
  await expect(matrix.joinOwner("!room:example.com")).rejects.toMatchObject({ statusCode: 503 });
  await matrix.joinOwner("!room:example.com");
  expect(request).toHaveBeenCalledTimes(2);
});

test("rejects a credential for a different owner before starting the appservice", async () => {
  const matrix = await fixture();
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ user_id: "@someone:example.com" }));
  const run = spyOn(matrix.sdk, "run");
  await expect(matrix.start()).rejects.toThrow("does not match bridge.owner");
  expect(run).not.toHaveBeenCalled();
});

test("double-puppeted sends use the owner identity, preserve timestamps, and mark echoes", async () => {
  const matrix = await fixture("owner-secret", "join");
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ event_id: "$mirrored" }),
  );
  expect(
    await matrix.send(
      matrix.config.bridge.owner,
      "!room:example.com",
      "m.room.message",
      { msgtype: "m.text", body: "from WeChat" },
      "transaction",
      1234567890000,
    ),
  ).toBe("$mirrored");
  const [url, options] = request.mock.calls[0];
  const parsed = new URL(String(url));
  expect(parsed.searchParams.get("user_id")).toBe(matrix.config.bridge.owner);
  expect(parsed.searchParams.get("ts")).toBe("1234567890000");
  expect(options?.method).toBe("PUT");
  expect(JSON.parse(String(options?.body))).toMatchObject({
    body: "from WeChat",
    "fi.mau.double_puppet_source": "matrix-wechat",
  });
});
