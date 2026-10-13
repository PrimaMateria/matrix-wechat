// Build-time only; no dependencies or account data are needed to prepare the client.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

async function sha(path: string) {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

async function extract(image: string, directory: string, expected: string) {
  // AppImages embed SquashFS after their ELF launcher; use the same detection as Runtime.
  const buffer = Buffer.from(
    await Bun.file(image)
      .slice(0, 2 * 1024 * 1024)
      .arrayBuffer(),
  );
  let offset = -1;
  let start = 0;
  while (start < buffer.length) {
    start = buffer.indexOf("hsqs", start);
    if (start < 0) break;
    if (start + 32 < buffer.length && buffer.readUInt16LE(start + 28) === 4) {
      offset = start;
      break;
    }
    start += 4;
  }
  if (offset < 0) throw new Error("Unsupported AppImage");
  await mkdir(dirname(directory), { recursive: true });
  const process = Bun.spawn(
    ["unsquashfs", "-no-progress", "-d", directory, "-o", String(offset), image],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (await process.exited) throw new Error("AppImage extraction failed");
  const executable = join(directory, "opt/wechat/wechat");
  if ((await sha(executable)) !== expected)
    throw new Error("WeChat executable does not match the native profile's pinned SHA-256");
  console.log(`Pinned executable verified: ${executable}`);
}

async function download(url: string, destination: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Client download returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Client download has no response body");
      // Stream explicitly: Bun 1.3 can hang when writing a large Response directly.
      await Bun.write(destination, new Uint8Array());
      const writer = Bun.file(destination).writer();
      try {
        for await (const chunk of response.body) {
          writer.write(chunk);
          await writer.flush();
        }
      } finally {
        await writer.end();
      }
      return;
    } catch (error) {
      await Bun.file(destination)
        .delete()
        .catch(() => {});
      if (attempt === 3) throw error;
      console.warn(`Client download attempt ${attempt}/3 failed; retrying`);
      await Bun.sleep(attempt * 1000);
    }
  }
}

const [url, destination, profilePath, extractionDirectory] = Bun.argv.slice(2);
if (!url || !destination || !profilePath)
  throw new Error(
    "Usage: download-client.ts <URL> <destination> <storage-profile.toml> [extraction-directory]",
  );
const profile = Bun.TOML.parse(await Bun.file(profilePath).text()) as {
  artifact: { appimage_sha256: string; sha256?: string };
};
const expected = profile.artifact.appimage_sha256;
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid pinned AppImage SHA-256");
const executableHash = profile.artifact.sha256;
if (extractionDirectory && (!executableHash || !/^[a-f0-9]{64}$/.test(executableHash)))
  throw new Error("Invalid pinned executable SHA-256");
await mkdir(dirname(destination), { recursive: true });
await download(url, destination);
if ((await sha(destination)) !== expected) {
  await Bun.file(destination).delete();
  throw new Error("Downloaded AppImage does not match the native profile's pinned SHA-256");
}
console.log(`Pinned AppImage verified: ${expected}`);
if (extractionDirectory) await extract(destination, extractionDirectory, executableHash!);
