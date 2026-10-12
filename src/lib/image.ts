import { Image } from "../doc/model.js";

export interface AnimationFrame {
  /** RGBA: one 0xRRGGBBAA word per pixel, whatever mode the sprite it came from uses. */
  image: Image;
  durationMs: number;
}

/**
 * The opaque colours of RGBA images in order of first appearance, alpha set
 * to 255 as a palette entry has it; null when there are more than `limit`.
 */
export function distinctColors(images: readonly Image[], limit = 256): number[] | null {
  const seen = new Set<number>();
  for (const img of images) {
    for (const v of img.pixels) {
      if ((v & 255) === 0) continue;
      seen.add((v | 255) >>> 0);
      if (seen.size > limit) return null;
    }
  }
  return [...seen];
}

export function toRgbaBytes(img: Image): Uint8Array {
  const out = new Uint8Array(img.pixels.length * 4);
  for (let i = 0; i < img.pixels.length; i++) {
    const v = img.pixels[i]!;
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = (v >>> 16) & 255;
    out[i * 4 + 2] = (v >>> 8) & 255;
    out[i * 4 + 3] = v & 255;
  }
  return out;
}

export function fromRgbaBytes(width: number, height: number, data: Uint8Array): Image {
  const img = new Image(width, height);
  for (let i = 0; i < img.pixels.length; i++) {
    img.pixels[i] = ((data[i * 4]! << 24) | (data[i * 4 + 1]! << 16) | (data[i * 4 + 2]! << 8) | data[i * 4 + 3]!) >>> 0;
  }
  return img;
}

export function scaleNearest(img: Image, factor: number): Image {
  if (factor === 1) return img;
  const out = new Image(img.width * factor, img.height * factor);
  for (let y = 0; y < out.height; y++) {
    const row = Math.floor(y / factor) * img.width;
    for (let x = 0; x < out.width; x++) out.pixels[y * out.width + x] = img.pixels[row + Math.floor(x / factor)]!;
  }
  return out;
}
