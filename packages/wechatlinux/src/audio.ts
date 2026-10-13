import { decode } from "silk-wasm";
import { APIError } from "./types";

// Keep WASM execution separate from the process hosting the native Frida binding.
export async function voiceAudioProcess(input: Buffer) {
  const child = Bun.spawn([process.execPath, import.meta.path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    child.stdin.write(input);
    child.stdin.end();
    const [output, exit] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      child.exited,
    ]);
    const bytes = Buffer.from(output);
    if (
      exit !== 0 ||
      bytes.length < 44 ||
      bytes.length > 24000 * 2 * 120 + 44 ||
      bytes.subarray(0, 4).toString() !== "RIFF" ||
      bytes.subarray(8, 12).toString() !== "WAVE"
    )
      throw new APIError("media_unavailable", "Voice recording could not be decoded");
    return { bytes, type: "audio/wav" };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

// WeChat's SILK stream is decoded to mono PCM, then wrapped for browser playback.
export async function voiceAudio(input: Buffer) {
  const offset = input[0] === 2 ? 1 : 0;
  if (input.length > 1024 * 1024 || input.subarray(offset, offset + 9).toString() !== "#!SILK_V3")
    throw new APIError("media_unavailable", "Unsupported voice recording format");
  let frames = 0,
    pos = offset + 9;
  while (pos < input.length) {
    if (pos + 2 > input.length)
      throw new APIError("media_unavailable", "Voice recording is incomplete");
    const size = input.readInt16LE(pos);
    pos += 2;
    if (size === -1 && pos === input.length) break;
    if (size <= 0 || pos + size > input.length || ++frames > 6000)
      throw new APIError("media_unavailable", "Voice recording is incomplete or too long");
    pos += size;
  }
  if (!frames) throw new APIError("media_unavailable", "Voice recording is empty");
  let result;
  try {
    result = await decode(input, 24000);
  } catch {
    throw new APIError("media_unavailable", "Voice recording could not be decoded");
  }
  const pcm = Buffer.from(result.data);
  if (!pcm.length || pcm.length % 2 || pcm.length > 24000 * 2 * 120)
    throw new APIError("media_unavailable", "Decoded voice recording exceeds the limit");
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return { bytes: Buffer.concat([header, pcm]), type: "audio/wav" };
}

if (import.meta.main) {
  try {
    const input = Buffer.from(await Bun.stdin.arrayBuffer());
    process.stdout.write((await voiceAudio(input)).bytes);
  } catch {
    process.exitCode = 1;
  }
}
