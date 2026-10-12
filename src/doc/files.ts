/**
 * Documents to and from files: what Aseprite's app.open and Sprite:saveAs did
 * for the Lua handlers, for the formats the port reads and writes so far.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeAse, encodeAse } from "../lib/ase.js";
import { encodeGif } from "../lib/gif.js";
import type { AnimationFrame } from "../lib/image.js";
import { readImageDocument, type ImageDocument } from "../lib/image-document.js";
import { encodePng } from "../lib/png.js";
import { frameFileNames } from "../lib/spritesheet.js";
import { aseFromSprite, spriteFromAse, type RenamedLayer } from "./aseprite.js";
import { ToolError } from "./errors.js";
import { defaultPalette, rgbaToHex, type Rgba, type Sprite } from "./model.js";
import type { Studio } from "./studio.js";

const ASE_MAGIC = 0xa5e0;

function isAseprite(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) === ASE_MAGIC;
}

/** Opens an .aseprite, PNG, GIF or JPEG file as a sprite and makes it active. */
export function openSprite(studio: Studio, file: string): { sprite: Sprite; renamedLayers: RenamedLayer[] } {
  const full = path.resolve(file);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(full);
  } catch (err) {
    throw new ToolError("io_error", `Cannot read '${file}': ${(err as Error).message}`, { path: full });
  }
  if (isAseprite(bytes)) {
    let ase: ReturnType<typeof decodeAse>;
    try {
      ase = decodeAse(bytes);
    } catch (err) {
      throw new ToolError("io_error", `Cannot open '${file}': ${(err as Error).message}`, { path: full });
    }
    return spriteFromAse(studio, ase, full);
  }
  let doc: ImageDocument;
  try {
    doc = readImageDocument(bytes);
  } catch (err) {
    throw new ToolError("io_error", `Cannot open '${file}': ${(err as Error).message}`, { path: full });
  }
  const { width, height } = doc.frames[0]!.image;
  const palette = doc.palette && doc.palette.length > 0 ? doc.palette : defaultPalette();
  const sprite = studio.addSprite({ width, height, colorMode: doc.colorMode, filename: full, palette });
  sprite.transparentIndex = doc.transparentIndex;
  const layer = sprite.layers[0]!;
  // Aseprite names an opened image's layer after whether it became a Background.
  layer.name = doc.background ? "Background" : "Layer";
  sprite.frames = doc.frames.map((f) => ({ durationMs: f.durationMs }));
  doc.frames.forEach((f, i) => layer.cels.set(i + 1, { x: 0, y: 0, image: f.image, opacity: 255 }));
  sprite.modified = false;
  return { sprite, renamedLayers: [] };
}

export function isAsepritePath(file: string): boolean {
  return [".ase", ".aseprite"].includes(path.extname(file).toLowerCase());
}

/** The whole document, layers and all, as an .aseprite file. */
export function writeAseprite(sprite: Sprite, file: string): string[] {
  const full = path.resolve(file);
  writeBytes(full, encodeAse(aseFromSprite(sprite)));
  return [full];
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

/**
 * Writes the sprite as its visible layers look, and the sprite then belongs to
 * that file. Aseprite's GIF saver keeps an RGB or grayscale sprite's colours,
 * building the colour table from the frames, and only an indexed sprite is
 * written in its palette.
 */
export function saveSprite(studio: Studio, sprite: Sprite, file: string): string[] {
  const ext = path.extname(file).toLowerCase();
  if (![".png", ".gif", ".ase", ".aseprite"].includes(ext)) {
    throw new ToolError("unsupported_command", `Saving '${ext || file}' files is not supported yet; save as .aseprite, .png or .gif.`, {
      path: path.resolve(file),
      supported: [".aseprite", ".ase", ".png", ".gif"],
    });
  }
  const files = isAsepritePath(file)
    ? writeAseprite(sprite, file)
    : writeFrames(rendered(studio, sprite), sprite.colorMode === "indexed" ? sprite.palette : [], file);
  sprite.filename = path.resolve(file);
  sprite.modified = false;
  return files;
}
