/**
 * Documents to and from files: what Aseprite's app.open and Sprite:saveAs did
 * for the Lua handlers, for the formats the port reads and writes so far.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeImage } from "../lib/decode.js";
import { encodeGif } from "../lib/gif.js";
import { distinctColors, type AnimationFrame } from "../lib/image.js";
import { encodePng } from "../lib/png.js";
import { frameFileNames } from "../lib/spritesheet.js";
import { ToolError } from "./errors.js";
import { defaultPalette, rgbaToHex, type Rgba, type Sprite } from "./model.js";
import type { Studio } from "./studio.js";

const ASE_MAGIC = 0xa5e0;

function isAseprite(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) === ASE_MAGIC;
}

/** The image's own colours when they fit a palette, else the default a new sprite gets. */
function openedPalette(frames: AnimationFrame[]): Rgba[] {
  const colors = distinctColors(frames.map((f) => f.image));
  return colors && colors.length > 0 ? colors : defaultPalette();
}

/** Opens a PNG, GIF or JPEG as an RGB sprite with one layer, and makes it active. */
export function openSprite(studio: Studio, file: string): Sprite {
  const full = path.resolve(file);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(full);
  } catch (err) {
    throw new ToolError("io_error", `Cannot read '${file}': ${(err as Error).message}`, { path: full });
  }
  if (isAseprite(bytes)) {
    throw new ToolError("unsupported_command", "Opening .aseprite files is not supported yet; open a PNG, GIF or JPEG.", {
      path: full,
    });
  }
  let decoded: ReturnType<typeof decodeImage>;
  try {
    decoded = decodeImage(bytes);
  } catch (err) {
    throw new ToolError("io_error", `Cannot open '${file}': ${(err as Error).message}`, { path: full });
  }
  // GIF readers show a zero delay at their own pace; 100 ms is what a new frame gets here.
  const frames = Array.isArray(decoded)
    ? decoded.map((f) => ({ image: f.image, durationMs: f.durationMs > 0 ? f.durationMs : 100 }))
    : [{ image: decoded, durationMs: 100 }];
  const { width, height } = frames[0]!.image;
  const sprite = studio.addSprite({ width, height, colorMode: "rgb", filename: full, palette: openedPalette(frames) });
  const layer = sprite.layers[0]!;
  sprite.frames = frames.map((f) => ({ durationMs: f.durationMs }));
  frames.forEach((f, i) => layer.cels.set(i + 1, { x: 0, y: 0, image: f.image, opacity: 255 }));
  sprite.modified = false;
  return sprite;
}

function rendered(studio: Studio, sprite: Sprite): AnimationFrame[] {
  return sprite.frames.map((f, i) => ({ image: studio.composite(sprite, i + 1), durationMs: f.durationMs }));
}

export function writeBytes(file: string, bytes: Uint8Array): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  } catch (err) {
    throw new ToolError("io_error", `Cannot write '${file}': ${(err as Error).message}`, { path: file });
  }
}

/**
 * Writes frames as a file chosen by its extension, as Aseprite's savers do:
 * PNG (one file per frame, named as Aseprite names them, when there is more
 * than one) or GIF (snapped to `palette`, as Aseprite's GIF export converts to
 * the sprite's palette). Returns the files written.
 */
export function writeFrames(frames: AnimationFrame[], palette: readonly Rgba[], file: string): string[] {
  const full = path.resolve(file);
  const ext = path.extname(full).toLowerCase();
  if (ext === ".png") {
    const files = frameFileNames(full, frames.length);
    files.forEach((f, i) => writeBytes(f, encodePng(frames[i]!.image)));
    return files;
  }
  if (ext === ".gif") {
    let bytes: Uint8Array;
    try {
      bytes = encodeGif(frames, palette.length > 0 ? { palette: palette.map((c) => rgbaToHex(c)) } : {});
    } catch (err) {
      throw new ToolError("invalid_args", `Cannot write '${file}' as GIF: ${(err as Error).message}`, { path: full });
    }
    writeBytes(full, bytes);
    return [full];
  }
  throw new ToolError("unsupported_command", `Writing '${ext || file}' files is not supported yet; use .png or .gif.`, {
    path: full,
    supported: [".png", ".gif"],
  });
}

/** Writes the sprite as its visible layers look, and the sprite then belongs to that file. */
export function saveSprite(studio: Studio, sprite: Sprite, file: string): string[] {
  const files = writeFrames(rendered(studio, sprite), sprite.palette, file);
  sprite.filename = path.resolve(file);
  sprite.modified = false;
  return files;
}
