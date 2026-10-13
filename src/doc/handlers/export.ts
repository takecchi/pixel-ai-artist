import path from "node:path";
import { asepriteBestFit } from "../../lib/color.js";
import { scaleNearest, type AnimationFrame } from "../../lib/image.js";
import { encodePng } from "../../lib/png.js";
import { buildSpriteSheet, type SheetTag, type SheetType } from "../../lib/spritesheet.js";
import { packageVersion } from "../../lib/version.js";
import { ToolError, need } from "../errors.js";
import { isAsepritePath, opaqueFrames, writeAseprite, writeBytes, writeFrames, type Written } from "../files.js";
import { Image, channels, displayName, type Layer, type Rgba, type Sprite } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

const ATLAS_APP = "https://github.com/takecchi/pixel-ai-artist";
const SHEET_TYPES: readonly SheetType[] = ["horizontal", "vertical", "rows", "columns", "packed"];

function names(value: unknown, arg: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ToolError("invalid_args", `${arg} must be a list of names.`);
  }
  return value.length > 0 ? value : null;
}

function intArg(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError("invalid_args", `${name} must be an integer in ${min}..${max}, got ${String(value)}.`);
  }
  return value;
}

/**
 * What the Lua with_export_sprite made of the sprite before handing it to
 * Aseprite's exporters: the frames `tags` cover, rendered with only `layers`
 * showing (named layers show even when hidden), scaled nearest-neighbour, and
 * the tags renumbered as deleting the other frames would leave them.
 */
interface ExportView {
  frames: AnimationFrame[];
  tags: SheetTag[];
  layers: Layer[];
}

function exportView(studio: Studio, s: Sprite, args: Record<string, unknown>, scale: number): ExportView {
  const tagNames = names(args.tags, "tags");
  const layerNames = names(args.layers, "layers");
  // Resolved before rendering, so an unknown name is refused rather than exporting everything.
  const keep = new Set<number>();
  if (tagNames) {
    for (const name of tagNames) {
      const tag = s.tags.find((t) => t.name === name);
      if (!tag) throw new ToolError("invalid_args", `No tag named '${name}'.`);
      for (let n = tag.from; n <= tag.to; n++) keep.add(n);
    }
  }
  const kept = s.frames.map((_, i) => i + 1).filter((n) => !tagNames || keep.has(n));
  const layers = layerNames
    ? s.layers.filter((l) => layerNames.some((name) => studio.resolveLayer(s, name) === l))
    : s.layers.filter((l) => l.visible);
  const frames = kept.map((n) => ({
    image: scaleNearest(
      layerNames ? studio.composite(s, n, { layers, includeHidden: true }) : studio.composite(s, n),
      scale,
    ),
    durationMs: s.frames[n - 1]!.durationMs,
  }));
  const tags: SheetTag[] = [];
  for (const t of s.tags) {
    const inside = kept.flatMap((n, i) => (n >= t.from && n <= t.to ? [i] : []));
    if (inside.length === 0) continue;
    tags.push({ name: t.name, from: inside[0]!, to: inside.at(-1)!, direction: t.direction, repeat: t.repeats, color: t.color });
  }
  return { frames, tags, layers };
}

/**
 * What the Lua handler's ChangePixelFormat to indexed did before the GIF was
 * saved: every painted pixel takes the palette entry Aseprite's bestfit picks,
 * opaque, and clear pixels stay clear. Aseprite also gives up palette entry 0
 * to transparency, which repaints anything drawn in it; that is not copied.
 */
function inPalette(frames: AnimationFrame[], palette: readonly Rgba[]): AnimationFrame[] {
  const entries = palette.map((c) => {
    const [r, g, b, a] = channels(c);
    return { r, g, b, a };
  });
  const cache = new Map<number, number>();
  return frames.map((f) => {
    const out = new Image(f.image.width, f.image.height);
    f.image.pixels.forEach((v, i) => {
      if ((v & 255) === 0) return;
      let mapped = cache.get(v);
      if (mapped === undefined) {
        const [r, g, b, a] = channels(v);
        // An entry's own alpha does not reach an indexed pixel; left in, the GIF writer would read one below 128 as clear.
        mapped = (palette[asepriteBestFit({ r, g, b, a }, entries)]! | 255) >>> 0;
        cache.set(v, mapped);
      }
      out.pixels[i] = mapped;
    });
    return { image: out, durationMs: f.durationMs };
  });
}

function writeSheet(view: ExportView, s: Sprite, file: string, args: Record<string, unknown>): string[] {
  const full = path.resolve(file);
  if (path.extname(full).toLowerCase() !== ".png") {
    throw new ToolError("unsupported_command", "A sprite sheet texture is written as .png.", { path: full });
  }
  const type = (args.sheetType ?? "horizontal") as SheetType;
  if (!SHEET_TYPES.includes(type)) {
    throw new ToolError("invalid_args", `sheetType must be one of ${SHEET_TYPES.join(", ")}, got '${String(type)}'.`);
  }
  const source = path.parse(displayName(s));
  const sheet = buildSpriteSheet(view.frames, {
    title: source.name,
    extension: source.ext.slice(1),
    imageName: path.basename(full),
    app: ATLAS_APP,
    version: packageVersion(),
    type,
    innerPadding: intArg(args.padding, "padding", 0, 16, 0),
    trim: args.trim === true,
    splitTags: args.byTag === true,
    tags: view.tags,
    layers: view.layers.map((l) => ({ name: l.name, opacity: l.opacity })),
  });
  const files: string[] = [];
  if (args.includeJson !== false) {
    const json = full.replace(/\.\w+$/, "") + ".json";
    writeBytes(json, new TextEncoder().encode(`${JSON.stringify(sheet.atlas, null, 2)}\n`));
    files.push(json);
  }
  writeBytes(full, encodePng(sheet.image));
  files.push(full);
  return files;
}

/**
 * gif and frames were saved from the sprite, or a copy of it, which keeps a
 * Background; Aseprite writes those with no transparency. png and spritesheet
 * are not passed through here: the Lua handler flattened png into a fresh
 * sprite and Aseprite renders a sheet into a new texture, neither with a
 * Background, so a hole in it stays transparent there even though
 * sprite.manage save writes it opaque. What the Background itself shows is
 * written as drawn on every path.
 */
function savedFrames(view: ExportView): { frames: AnimationFrame[]; alphaDropped: number } {
  return view.layers.some((l) => l.background) ? opaqueFrames(view.frames) : { frames: view.frames, alphaDropped: 0 };
}

/** png and frames were saveCopyAs in the Lua handler: a GIF there keeps an RGB sprite's colours. */
function ownPalette(s: Sprite): readonly Rgba[] {
  return s.colorMode === "indexed" ? s.palette : [];
}

function exportRun(studio: Studio, args: Record<string, unknown>) {
  const s = studio.resolveSprite(args.sprite);
  const op = need(args.op, "op");
  const file = String(need(args.path, "path"));
  const scale = intArg(args.scale, "scale", 1, 16, 1);
  const filtered = names(args.layers, "layers") !== null || names(args.tags, "tags") !== null;
  let files: string[];
  let frame: number | undefined;
  let atlas: string | undefined;
  let adjustedDurations: Written["adjustedDurations"] = [];
  let adjustedBackgroundOpacity: Written["adjustedBackgroundOpacity"] = [];
  let alphaDropped = 0;

  if (op === "png") {
    if (names(args.tags, "tags")) {
      throw new ToolError("invalid_args", "'png' writes one frame, picked with `frame`; `tags` applies to gif, frames and spritesheet.");
    }
    frame = studio.resolveFrame(s, args.frame);
    const view = exportView(studio, s, args, scale);
    files = writeFrames([view.frames[frame - 1]!], ownPalette(s), file);
  } else if (op === "aseprite") {
    if (filtered) {
      throw new ToolError("invalid_args", "'aseprite' saves the whole document; `layers` and `tags` apply to png, gif, frames and spritesheet.");
    }
    if (!isAsepritePath(file)) {
      throw new ToolError("invalid_args", "'aseprite' writes an .aseprite or .ase file; give the path one of those extensions.");
    }
    const written: Written = writeAseprite(s, file);
    files = written.files;
    adjustedDurations = written.adjustedDurations;
    adjustedBackgroundOpacity = written.adjustedBackgroundOpacity;
  } else if (op === "gif") {
    const saved = savedFrames(exportView(studio, s, args, scale));
    alphaDropped = saved.alphaDropped;
    const opaque = s.palette.map((c) => (c | 255) >>> 0);
    files = writeFrames(s.palette.length > 0 ? inPalette(saved.frames, s.palette) : saved.frames, opaque, file);
  } else if (op === "frames") {
    const saved = savedFrames(exportView(studio, s, args, scale));
    alphaDropped = saved.alphaDropped;
    files = writeFrames(saved.frames, ownPalette(s), file);
  } else if (op === "spritesheet") {
    files = writeSheet(exportView(studio, s, args, scale), s, file, args);
    if (args.includeJson !== false) atlas = files[0];
  } else {
    throw new ToolError("unsupported_command", `export op '${String(op)}' is not supported.`);
  }

  return {
    sprite: displayName(s),
    op,
    files,
    width: s.width,
    height: s.height,
    frameCount: s.frames.length,
    frame,
    atlas,
    ...(adjustedDurations.length > 0 ? { adjustedDurations } : {}),
    ...(adjustedBackgroundOpacity.length > 0 ? { adjustedBackgroundOpacity } : {}),
    ...(alphaDropped > 0 ? { alphaDropped } : {}),
  };
}

export const exportHandlers: HandlerTable = {
  "export.run": exportRun,
};
