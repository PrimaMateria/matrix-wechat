import { expect, test } from "bun:test";
import { Runtime } from "../src/runtime";

test("failed phone confirmation does not throttle a subsequent QR login", async () => {
  const runtime = new Runtime(),
    calls: unknown[] = [];
  runtime.status = { state: "awaiting_scan" };
  runtime.native = async (_method, mode) => {
    calls.push(mode);
    return mode === "prompt" ? { queued: false, reason: "qr_required" } : { queued: true };
  };
  await expect(runtime.login({ mode: "prompt" })).rejects.toThrow("Use login qr");
  await expect(runtime.login({ mode: "qr" })).resolves.toEqual({ success: true });
  expect(calls).toEqual(["prompt", "qr"]);
});

test("accepted phone confirmation does not prevent switching to QR, while duplicate requests are bounded", async () => {
  const runtime = new Runtime(),
    calls: unknown[] = [];
  runtime.native = async (_method, mode) => {
    calls.push(mode);
    return { queued: true };
  };
  await runtime.login({ mode: "prompt" });
  await runtime.login({ mode: "qr" });
  await expect(runtime.login({ mode: "qr" })).rejects.toThrow("Please wait");
  expect(calls).toEqual(["prompt", "qr"]);
});

test("requesting an already available QR preserves it without another native login", async () => {
  const runtime = new Runtime();
  runtime.status = { state: "awaiting_scan" };
  runtime.qr = Buffer.from("current validated QR");
  runtime.qrAt = Date.now();
  runtime.native = async () => {
    throw Error("An available QR must not be regenerated");
  };
  await expect(runtime.login({ mode: "qr" })).resolves.toEqual({ success: true });
  expect(runtime.qr.toString()).toBe("current validated QR");
});
