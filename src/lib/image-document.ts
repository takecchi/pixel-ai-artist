/**
 * The document Aseprite 1.3.15 builds when it opens a PNG, GIF or JPEG
 * (png_format.cpp, gif_format.cpp, jpeg_format.cpp, FileOp::postLoad), so a
 * file opened here comes up in the same colour mode, palette and pixel values.
 *
 * Where Aseprite quantises with an octree (an RGB image of more than 256
 * colours, or GIF frames whose local colour tables would have to be merged),
 * this module does not invent a different reduction: the palette is left
 * null, or the GIF opens as RGB.
 */

import { Image, rgba, type ColorMode } from "../doc/model.js";
import { decodeGif } from "./gif.js";
import { distinctColors, type AnimationFrame } from "./image.js";
import { decodeJpeg, isGrayscaleJpeg } from "./jpeg.js";
import { decodeIndexedPng, decodePng } from "./png.js";

export interface ImageDocument {
  colorMode: ColorMode;
  /** null where Aseprite would quantise one with an octree. */
  palette: number[] | null;
  transparentIndex: number;
  /** Pixel values in `colorMode`: palette indices for indexed, 0xRRGGBBAA otherwise. */
  frames: AnimationFrame[];
  /** Aseprite makes the only layer a Background when the image has no transparency. */
  background: boolean;
}

const GRAY_RAMP = Array.from({ length: 256 }, (_, c) => rgba(c, c, c));
// A grayscale PNG sets no palette entries, so the sequence loader's all-black palette replaces the gray ramp.
const ALL_BLACK = Array.from({ length: 256 }, () => rgba(0, 0, 0));

function anyClear(frames: AnimationFrame[], below = 1): boolean {
  return frames.some((f) => f.image.pixels.some((v) => (v & 255) < below));
}

function png(bytes: Uint8Array): ImageDocument {
  const colorType = bytes[25];
  if (colorType === 3) {
    const { image, palette } = decodeIndexedPng(bytes)!;
    const clear = palette.findIndex((c) => (c & 255) === 0);
    return {
      colorMode: "indexed",
      palette,
      transparentIndex: clear >= 0 ? clear : 0,
      frames: [{ image, durationMs: 100 }],
      background: !palette.some((c) => (c & 255) < 255),
    };
  }
  const frames = [{ image: decodePng(bytes), durationMs: 100 }];
  if (colorType === 0 || colorType === 4) {
    return { colorMode: "grayscale", palette: ALL_BLACK, transparentIndex: 0, frames, background: colorType === 0 && !anyClear(frames) };
  }
  return {
    colorMode: "rgb",
    palette: distinctColors(frames.map((f) => f.image)),
    transparentIndex: 0,
    frames,
    background: colorType === 2 && !anyClear(frames),
  };
}

function gif(bytes: Uint8Array): ImageDocument {
  const g = decodeGif(bytes);
  // Aseprite clamps a frame's duration to at least 1 ms.
  const frames = g.frames.map((f) => ({ image: f.image, durationMs: Math.max(1, f.durationMs) }));
  const background = g.transparentIndex < 0;
  if (g.globalPalette && !g.localColorTables) {
    const palette = [...g.globalPalette];
    const clear = g.transparentIndex >= 0 ? g.transparentIndex : g.backgroundIndex;
    while (palette.length <= clear) palette.push(rgba(0, 0, 0));
    const index = new Map<number, number>();
    palette.forEach((c, i) => {
      if (i !== clear && !index.has(c)) index.set(c, i);
    });
    if (!index.has(palette[clear]!)) index.set(palette[clear]!, clear);
    const indexed = frames.map((f) => {
      const image = new Image(f.image.width, f.image.height);
      f.image.pixels.forEach((v, i) => {
        image.pixels[i] = (v & 255) === 0 ? clear : index.get((v | 255) >>> 0)!;
      });
      return { image, durationMs: f.durationMs };
    });
    return { colorMode: "indexed", palette, transparentIndex: clear, frames: indexed, background };
  }
  return { colorMode: "rgb", palette: distinctColors(frames.map((f) => f.image)), transparentIndex: 0, frames, background };
}

function jpeg(bytes: Uint8Array): ImageDocument {
  const frames = [{ image: decodeJpeg(bytes), durationMs: 100 }];
  if (isGrayscaleJpeg(bytes)) return { colorMode: "grayscale", palette: GRAY_RAMP, transparentIndex: 0, frames, background: true };
  return { colorMode: "rgb", palette: distinctColors(frames.map((f) => f.image)), transparentIndex: 0, frames, background: true };
}

/** Throws when the bytes are not a PNG, GIF or JPEG this port can read. */
export function readImageDocument(bytes: Uint8Array): ImageDocument {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return png(bytes);
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return gif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  throw new Error("unsupported image format: expected PNG, GIF or JPEG");
}
