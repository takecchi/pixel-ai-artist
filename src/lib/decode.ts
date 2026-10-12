import { decodeGif } from "./gif.js";
import type { Image } from "../doc/model.js";
import type { AnimationFrame } from "./image.js";
import { decodeJpeg } from "./jpeg.js";
import { decodePng } from "./png.js";

/**
 * Reads a PNG, GIF or JPEG by its leading bytes, not its file name. A GIF
 * always comes back as frames, even when it holds one.
 */
export function decodeImage(bytes: Uint8Array): Image | AnimationFrame[] {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return decodePng(bytes);
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return decodeGif(bytes).frames;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return decodeJpeg(bytes);
  throw new Error("unsupported image format: expected PNG, GIF or JPEG");
}
