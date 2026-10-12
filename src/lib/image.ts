import { Image } from "../doc/model.js";

export interface AnimationFrame {
  /** RGBA: one 0xRRGGBBAA word per pixel, whatever mode the sprite it came from uses. */
  image: Image;
  durationMs: number;
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
