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
import { aseFromSprite, spriteFromAse, type AdjustedBackgroundOpacity, type AdjustedDuration, type AseOpenNotes } from "./aseprite.js";
import { ToolError } from "./errors.js";
import { Image, defaultPalette, rgbaToHex, type Layer, type Rgba, type Sprite } from "./model.js";
import type { Studio } from "./studio.js";

const ASE_MAGIC = 0xa5e0;

function isAseprite(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) === ASE_MAGIC;
}

/** Opens an .aseprite, PNG, GIF or JPEG file as a sprite and makes it active. */
export function openSprite(studio: Studio, file: string): { sprite: Sprite } & AseOpenNotes {
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
  // An image with no transparency opens as Aseprite's Background, which also locks its position.
  layer.name = doc.background ? "Background" : "Layer";
  if (doc.background) {
    layer.background = true;
    layer.aseprite = { lockMovement: true };
  }
  sprite.frames = doc.frames.map((f) => ({ durationMs: f.durationMs }));
  doc.frames.forEach((f, i) => layer.cels.set(i + 1, { x: 0, y: 0, image: f.image, opacity: 255 }));
  sprite.modified = false;
  return { sprite, renamedLayers: [], lostOnSave: {}, skippedOnOpen: {}, misplacedBackground: [] };
}

export function isAsepritePath(file: string): boolean {
  return [".ase", ".aseprite"].includes(path.extname(file).toLowerCase());
}

export interface Written {
  files: string[];
  /** Frame durations brought into a format's range on the way out. */
  adjustedDurations: AdjustedDuration[];
  /** Background layers whose opacity was written as 255, which is all Aseprite reads of it. */
  adjustedBackgroundOpacity: AdjustedBackgroundOpacity[];
  /** Pixels written opaque, colour kept, because a visible Background leaves the file no transparency. */
  alphaDropped: number;
  /** Pixels of partial alpha a GIF wrote fully opaque or fully clear; 0 for other formats. */
  alphaRounded: number;
  /** What a flat PNG or GIF could not hold of the sprite, counted by kind; empty for .aseprite. */
  lostOnSave: Record<string, number>;
}

/** The whole document, layers and all, as an .aseprite file. */
export function writeAseprite(sprite: Sprite, file: string): Written {
  const full = path.resolve(file);
  const { file: ase, adjustedDurations, adjustedBackgroundOpacity } = aseFromSprite(sprite);
  writeBytes(full, encodeAse(ase));
  return { files: [full], adjustedDurations, adjustedBackgroundOpacity, alphaDropped: 0, alphaRounded: 0, lostOnSave: {} };
}

/**
 * How many pixels of `frames` writing them to `file` rounds, counted once per
 * frame: GIF transparency is on or off, so a GIF has no place for partial
 * alpha and writes it fully opaque or fully clear. Other formats keep it.
 */
export function alphaRounded(frames: readonly AnimationFrame[], file: string): number {
  if (path.extname(file).toLowerCase() !== ".gif") return 0;
  let rounded = 0;
  for (const f of frames) {
    for (const v of f.image.pixels) {
      const a = v & 255;
      if (a > 0 && a < 255) rounded++;
    }
  }
  return rounded;
}

/** Whether a visible Background is among `layers`, which makes Aseprite write PNG and GIF with no transparency. */
export function drawsBackground(layers: readonly Layer[]): boolean {
  return layers.some((l) => l.background && l.visible);
}

/**
 * Frames with every pixel opaque and its colour kept, and how many pixels
 * that changed: with a visible Background, Aseprite's PNG saver picks a colour
 * type with no alpha and writes each pixel's r, g and b as they are
 * (png_format.cpp, color_type and the PNG_COLOR_TYPE_RGB rows).
 */
export function opaqueFrames(frames: AnimationFrame[]): { frames: AnimationFrame[]; alphaDropped: number } {
  let alphaDropped = 0;
  const out = frames.map((f) => {
    const image = new Image(f.image.width, f.image.height);
    f.image.pixels.forEach((v, i) => {
      if ((v & 255) !== 255) alphaDropped++;
      image.pixels[i] = (v | 255) >>> 0;
    });
    return { image, durationMs: f.durationMs };
  });
  return { frames: out, alphaDropped };
}

/**
 * What saving the sprite as a flat PNG or GIF leaves behind: layers drawn into
 * one picture, a PNG's frames split into numbered files with no durations,
 * tags, and an indexed sprite's palette in a PNG. An RGB or grayscale
 * sprite's palette is not counted: it does not decide any pixel, and every
 * new sprite has one.
 */
function flatLosses(sprite: Sprite, ext: string): Record<string, number> {
  const kept: Record<string, number> = {};
  if (sprite.layers.length > 1) kept.layers = sprite.layers.length;
  if (ext === ".png" && sprite.frames.length > 1) kept.frames = sprite.frames.length;
  if (sprite.tags.length > 0) kept.tags = sprite.tags.length;
  if (ext === ".png" && sprite.colorMode === "indexed" && sprite.palette.length > 0) kept.palette = sprite.palette.length;
  return kept;
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
 * Writes one file per frame, named as `writeFrames` names PNG frames, in the
 * format the extension picks — a GIF per frame too. Aseprite expands
 * `{frame}` only for formats saved as sequences, so the Lua handler's
 * saveCopyAs wrote one animated GIF under the literal name, against the
 * "one file per frame" the tool promised.
 */
export function writeFramesApart(frames: AnimationFrame[], palette: readonly Rgba[], file: string): string[] {
  const full = path.resolve(file);
  if (path.extname(full).toLowerCase() !== ".gif") return writeFrames(frames, palette, file);
  const files = frameFileNames(full, frames.length);
  files.forEach((f, i) => writeFrames([frames[i]!], palette, f));
  return files;
}

/**
 * Writes the sprite as its visible layers look, and the sprite then belongs to
 * that file. Aseprite's GIF saver keeps an RGB or grayscale sprite's colours,
 * building the colour table from the frames, and only an indexed sprite is
 * written in its palette. A visible Background leaves PNG and GIF opaque.
 */
export function saveSprite(studio: Studio, sprite: Sprite, file: string): Written {
  const ext = path.extname(file).toLowerCase();
  if (![".png", ".gif", ".ase", ".aseprite"].includes(ext)) {
    throw new ToolError("unsupported_command", `Saving '${ext || file}' files is not supported yet; save as .aseprite, .png or .gif.`, {
      path: path.resolve(file),
      supported: [".aseprite", ".ase", ".png", ".gif"],
    });
  }
  let written: Written;
  if (isAsepritePath(file)) {
    written = writeAseprite(sprite, file);
  } else {
    const frames = rendered(studio, sprite);
    const out = drawsBackground(sprite.layers) ? opaqueFrames(frames) : { frames, alphaDropped: 0 };
    written = {
      files: writeFrames(out.frames, sprite.colorMode === "indexed" ? sprite.palette : [], file),
      adjustedDurations: [],
      adjustedBackgroundOpacity: [],
      alphaDropped: out.alphaDropped,
      alphaRounded: alphaRounded(out.frames, file),
      lostOnSave: flatLosses(sprite, ext),
    };
  }
  sprite.filename = path.resolve(file);
  sprite.modified = false;
  return written;
}
