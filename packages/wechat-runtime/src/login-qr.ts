import {
  BarcodeFormat,
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  QRCodeWriter,
  RGBLuminanceSource,
} from "@zxing/library";
import { PNG } from "pngjs";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
function loginURL(text: string) {
  try {
    const url = new URL(text);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      ["weixin.qq.com", "login.weixin.qq.com", "login.wechat.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

// Use only the active login model's payload, never leftover QR images in the heap.
export function loginQRImage(payload: Buffer): Buffer | undefined {
  if (!payload.length || payload.length > 256000) return;
  try {
    let bytes = payload;
    if (!bytes.subarray(0, 8).equals(signature)) {
      const text = bytes.toString("utf8");
      if (text.length <= 2048 && loginURL(text)) {
        const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 256, 256, new Map()),
          png = new PNG({ width: 256, height: 256 });
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            const i = (y * 256 + x) * 4,
              value = matrix.get(x, y) ? 0 : 255;
            png.data[i] = png.data[i + 1] = png.data[i + 2] = value;
            png.data[i + 3] = 255;
          }
        bytes = PNG.sync.write(png);
      } else bytes = Buffer.from(text.replace(/^data:image\/png;base64,/, ""), "base64");
    }
    if (!bytes.subarray(0, 8).equals(signature) || bytes.length < 24) return;
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (width < 64 || height < 64 || width > 1024 || height > 1024) return;
    const png = PNG.sync.read(bytes),
      gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < gray.length; i++)
      gray[i] = (png.data[i * 4] + 2 * png.data[i * 4 + 1] + png.data[i * 4 + 2]) / 4;
    const text = new QRCodeReader()
      .decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray, width, height))))
      .getText();
    if (loginURL(text)) return bytes;
  } catch {}
}
