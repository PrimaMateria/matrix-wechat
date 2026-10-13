import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A gzip-compressed SquashFS 4 fixture containing opt/wechat/wechat, generated with:
// mksquashfs source fixture -noappend -processors 1 -all-root -mkfs-time 0 -all-time 0 -no-xattrs
const squashfs = Bun.gunzipSync(
  Buffer.from(
    "H4sIAAAAAAAC/8soLixmYYABJgZGIMnIIMhwgImRASSeAJVRYoTQUlD6PxRUQeU3QumPUJoHqq4gMy8vNUUhtSI1ubQkMSknVSEts6KktCiVy5Sh4lZyUsShEwysZ3hWOHB1SEreO/R05oSMyA0yq2yUJ1lucrirk/FJx+NTEI8azxoeHh4GxZssvjogbQkNDGkaZ48cOBUwb9aciRGHGMQTEwIYktx4JN0Uyhgu+/D8ZFVluGTAdkigAeYBKQaw3xjuQ/mCQHOKgeawsoVMYFjKyKfAcPAnVIqlAUSKMDKMglEwCkbBKBgFo2AUjIJRMApGwSgYBcMEAACdFwpOABAAAA==",
    "base64",
  ),
);
const executable = "pinned executable fixture\n";
const header = Buffer.alloc(128);
header.write("\x7fELFhsqs"); // The false magic in the launcher must be skipped.
const appimage = Buffer.concat([header, squashfs]);
const script = join(import.meta.dir, "../scripts/download-client.ts");
const sha = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function run(
  image: Uint8Array,
  options: { extract?: boolean; imageHash?: string; executableHash?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wechat-client-test-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(Buffer.from(image)),
  });
  const destination = join(directory, "client/WeChat.AppImage");
  const extracted = join(directory, "client/app");
  try {
    const profile = join(directory, "profile.toml");
    await Bun.write(
      profile,
      `[artifact]\nappimage_sha256 = "${options.imageHash ?? sha(image)}"\n${
        options.extract ? `sha256 = "${options.executableHash ?? sha(executable)}"\n` : ""
      }`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        script,
        server.url.href,
        destination,
        profile,
        ...(options.extract ? [extracted] : []),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      output: stdout + stderr,
      downloaded: (await Bun.file(destination).exists())
        ? await Bun.file(destination).bytes()
        : undefined,
      executable: (await Bun.file(join(extracted, "opt/wechat/wechat")).exists())
        ? await Bun.file(join(extracted, "opt/wechat/wechat")).text()
        : undefined,
    };
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

test("three-argument download verifies the image without requiring an executable pin", async () => {
  const result = await run(appimage);
  expect(result.exitCode).toBe(0);
  expect(result.downloaded).toEqual(new Uint8Array(appimage));
  expect(result.executable).toBeUndefined();
});

test("a mismatched AppImage hash fails and deletes the downloaded artifact", async () => {
  const result = await run(appimage, { imageHash: "0".repeat(64) });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Downloaded AppImage does not match");
  expect(result.downloaded).toBeUndefined();
});

test("extraction requires a valid executable pin before downloading", async () => {
  const result = await run(appimage, { extract: true, executableHash: "invalid" });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Invalid pinned executable SHA-256");
  expect(result.downloaded).toBeUndefined();
});

test("an image without SquashFS is rejected even when its image hash matches", async () => {
  const result = await run(Buffer.alloc(64), { extract: true });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Unsupported AppImage");
});

// Build-stage images omit squashfs-tools; the client stage and CI smoke check verify the real client.
const extractionTest = test.skipIf(!Bun.which("unsquashfs"));
extractionTest("extracts embedded SquashFS and verifies the executable hash", async () => {
  const result = await run(appimage, { extract: true });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Pinned executable verified");
  expect(result.executable).toBe(executable);
});

extractionTest("a mismatched executable hash fails after extraction", async () => {
  const result = await run(appimage, { extract: true, executableHash: "0".repeat(64) });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("WeChat executable does not match");
});

extractionTest("a corrupt SquashFS fails extraction", async () => {
  const corrupt = Buffer.alloc(64);
  corrupt.write("hsqs");
  corrupt.writeUInt16LE(4, 28);
  const result = await run(corrupt, { extract: true });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("AppImage extraction failed");
});
