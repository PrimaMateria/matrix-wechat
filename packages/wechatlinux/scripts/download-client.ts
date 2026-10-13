// Build-time only; no dependencies or account data are needed to fetch the client.
export {};

async function download(url: string, destination: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Client download returned HTTP ${response.status}`);
      }
      await Bun.write(destination, response);
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

const [url, destination, profilePath] = Bun.argv.slice(2);
if (!url || !destination || !profilePath)
  throw new Error("Usage: download-client.ts <URL> <destination> <storage-profile.toml>");
const profile = Bun.TOML.parse(await Bun.file(profilePath).text()) as {
  artifact: { appimage_sha256: string };
};
const expected = profile.artifact.appimage_sha256;
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid pinned AppImage SHA-256");
await download(url, destination);
const hash = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(destination).stream()) hash.update(chunk);
if (hash.digest("hex") !== expected) {
  await Bun.file(destination).delete();
  throw new Error("Downloaded AppImage does not match the native profile's pinned SHA-256");
}
console.log(`Pinned AppImage verified: ${expected}`);
