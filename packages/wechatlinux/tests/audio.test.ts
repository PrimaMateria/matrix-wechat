import { expect, test } from "bun:test";
import { encode } from "silk-wasm";
import { voiceAudio, voiceAudioProcess } from "../src/audio";

test("SILK speech decodes into a browser-playable mono WAV", async () => {
  const pcm = Buffer.alloc((24000 * 2) / 5);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 24000) * 5000), i * 2);
  const silk = await encode(pcm, 24000),
    asset = await voiceAudio(Buffer.from(silk.data));
  expect(asset.type).toBe("audio/wav");
  expect(asset.bytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(asset.bytes.subarray(8, 12).toString()).toBe("WAVE");
  expect(asset.bytes.readUInt16LE(22)).toBe(1);
  expect(asset.bytes.readUInt32LE(24)).toBe(24000);
  expect(asset.bytes.readUInt32LE(40)).toBe(asset.bytes.length - 44);
  expect(asset.bytes.length).toBeGreaterThan(44);
  const isolated = await voiceAudioProcess(Buffer.from(silk.data));
  expect(isolated.bytes.equals(asset.bytes)).toBe(true);
});
test("reject unrelated, truncated and excessive voice streams before decoding", async () => {
  await expect(voiceAudio(Buffer.from("not a recording"))).rejects.toMatchObject({
    code: "media_unavailable",
  });
  await expect(
    voiceAudio(Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.from([20, 0, 1])])),
  ).rejects.toMatchObject({ code: "media_unavailable" });
  await expect(voiceAudio(Buffer.alloc(1024 * 1024 + 1))).rejects.toMatchObject({
    code: "media_unavailable",
  });
});
