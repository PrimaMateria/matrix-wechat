import { expect, test } from "bun:test";
import { PNG } from "pngjs";
import { loginQRImage } from "../src/login-qr";

test("the active native login URL produces a verified PNG without searching stale heap images", () => {
  const image = loginQRImage(Buffer.from("https://weixin.qq.com/x/test-login-code"));
  expect(image).toBeDefined();
  expect(PNG.sync.read(image!).width).toBe(256);
  expect(loginQRImage(image!)?.equals(image!)).toBe(true);
  expect(loginQRImage(Buffer.from(image!.toString("base64")))?.equals(image!)).toBe(true);
  expect(
    loginQRImage(Buffer.from(`data:image/png;base64,${image!.toString("base64")}`))?.equals(image!),
  ).toBe(true);
});

test("invalid, unrelated and oversized QR payloads are not exposed as login codes", () => {
  for (const value of [
    "",
    "https://attacker.example/login",
    "file://weixin.qq.com/x/test",
    "not a code",
  ])
    expect(loginQRImage(Buffer.from(value))).toBeUndefined();
  expect(loginQRImage(Buffer.alloc(256001))).toBeUndefined();
  expect(loginQRImage(PNG.sync.write(new PNG({ width: 64, height: 64 })))).toBeUndefined();
  const image = loginQRImage(Buffer.from("https://weixin.qq.com/x/test-login-code"))!;
  const oversized = Buffer.from(image);
  oversized.writeUInt32BE(8192, 16);
  expect(loginQRImage(oversized)).toBeUndefined();
});
