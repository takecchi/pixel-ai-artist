/**
 * Documents to and from files: what Aseprite's app.open and Sprite:saveAs did
 * for the Lua handlers, for the formats the port reads and writes so far.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeImage } from "../lib/decode.js";
import { encodeGif } from "../lib/gif.js";
import type { AnimationFrame } from "../lib/image.js";
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
function paletteOf(frames: AnimationFrame[]): Rgba[] {
  const seen = new Set<number>();
  for (const f of frames) {
    for (const v of f.image.pixels) {
      if ((v & 255) === 0) continue;
      seen.add((v | 255) >>> 0);
      if (seen.size > 256) return defaultPalette();
    }
  }
  return seen.size > 0 ? [...seen] : defaultPalette();
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
  const sprite = studio.addSprite({ width, height, colorMode: "rgb", filename: full, palette: paletteOf(frames) });
  const layer = sprite.layers[0]!;
  sprite.frames = frames.map((f) => ({ durationMs: f.durationMs }));
  frames.forEach((f, i) => layer.cels.set(i + 1, { x: 0, y: 0, image: f.image, opacity: 255 }));
  sprite.modified = false;
  return sprite;
}

function rendered(studio: Studio, sprite: Sprite): AnimationFrame[] {
  return sprite.frames.map((f, i) => ({ image: studio.composite(sprite, i + 1), durationMs: f.durationMs }));
}

function write(file: string, bytes: Uint8Array): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  } catch (err) {
    throw new ToolError("io_error", `Cannot write '${file}': ${(err as Error).message}`, { path: file });
  }
}

/**
 * Writes the sprite as its visible layers look, chosen by the extension: PNG
 * (one file per frame, named as Aseprite names them, when there is more than
 * one) or GIF (the sprite's palette, as Aseprite's GIF export converts to it).
 * The sprite then belongs to that file. Returns the files written.
 */
export function saveSprite(studio: Studio, sprite: Sprite, file: string): string[] {
  const full = path.resolve(file);
  const ext = path.extname(full).toLowerCase();
  const frames = rendered(studio, sprite);
  let files: string[];
  if (ext === ".png") {
    files = frameFileNames(full, frames.length);
    files.forEach((f, i) => write(f, encodePng(frames[i]!.image)));
  } else if (ext === ".gif") {
    let bytes: Uint8Array;
    try {
      bytes = encodeGif(frames, sprite.palette.length > 0 ? { palette: sprite.palette.map((c) => rgbaToHex(c)) } : {});
    } catch (err) {
      throw new ToolError("invalid_args", `Cannot write '${file}' as GIF: ${(err as Error).message}`, { path: full });
    }
    write(full, bytes);
    files = [full];
  } else {
    throw new ToolError(
      "unsupported_command",
      `Saving '${ext || file}' files is not supported yet; save as .png or .gif.`,
      { path: full, supported: [".png", ".gif"] },
    );
  }
  sprite.filename = full;
  sprite.modified = false;
  return files;
}
