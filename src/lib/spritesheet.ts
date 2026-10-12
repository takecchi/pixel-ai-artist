/**
 * Sprite sheets laid out and described the way Aseprite's ExportSpriteSheet
 * does with the options the export tool passes it (inner padding, trim, split
 * tags, a JSON-array atlas listing tags, layers and slices), so an engine
 * importer written for Aseprite's output reads ours unchanged.
 */

import { Image, type Rgba, type TagDirection } from "../doc/model.js";
import type { AnimationFrame } from "./image.js";

export type SheetType = "horizontal" | "vertical" | "rows" | "columns" | "packed";

export interface SheetTag {
  name: string;
  /** 0-based, inclusive. */
  from: number;
  to: number;
  direction: TagDirection;
  /** 0 = forever. */
  repeat: number;
  color: Rgba;
}

export interface SheetLayer {
  name: string;
  opacity: number;
}

export interface SheetOptions {
  /** `{title}` and `{extension}` of the frame names: the document's file name, split. */
  title: string;
  extension: string;
  /** The texture's file name, written to `meta.image`; omitted when absent. */
  imageName?: string;
  app: string;
  version: string;
  type?: SheetType;
  innerPadding?: number;
  trim?: boolean;
  splitTags?: boolean;
  tags?: SheetTag[];
  layers?: SheetLayer[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasFrame {
  filename: string;
  frame: Box;
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: Box;
  sourceSize: { w: number; h: number };
  duration: number;
}

export interface AtlasTag {
  name: string;
  from: number;
  to: number;
  direction: TagDirection;
  repeat?: string;
  color?: string;
}

export interface Atlas {
  frames: AtlasFrame[];
  meta: {
    app: string;
    version: string;
    image?: string;
    format: "RGBA8888";
    size: { w: number; h: number };
    scale: "1";
    frameTags: AtlasTag[];
    layers: { name: string; opacity: number; blendMode: "normal" }[];
    slices: [];
  };
}

export interface SpriteSheet {
  image: Image;
  atlas: Atlas;
}

interface Sample {
  frame: number;
  tag: SheetTag | null;
  name: string;
  bounds: Box;
  cell: Box;
  /** Packed sheets place one copy of identical images; the rest point at it. */
  sameAs: Sample | null;
}

function opaqueBounds(img: Image): Box | null {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((img.pixels[y * img.width + x]! & 255) === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function sameRegion(a: Image, ab: Box, b: Image, bb: Box): boolean {
  if (ab.w !== bb.w || ab.h !== bb.h) return false;
  for (let y = 0; y < ab.h; y++) {
    for (let x = 0; x < ab.w; x++) {
      if (a.pixels[(ab.y + y) * a.width + ab.x + x] !== b.pixels[(bb.y + y) * b.width + bb.x + x]) return false;
    }
  }
  return true;
}

function layoutSimple(samples: Sample[], type: Exclude<SheetType, "packed">, splitTags: boolean): void {
  const bands = type === "rows" || type === "columns";
  const across = type === "horizontal" || type === "rows";
  let x = 0;
  let y = 0;
  let band = { w: 0, h: 0 };
  let prev: Sample | null = null;
  for (const s of samples) {
    const { w, h } = s.cell;
    if (bands && prev && splitTags && prev.tag !== s.tag) {
      if (across) {
        x = 0;
        y += band.h;
      } else {
        x += band.w;
        y = 0;
      }
      band = { w: 0, h: 0 };
    }
    s.cell.x = x;
    s.cell.y = y;
    if (across) x += w;
    else y += h;
    band = { w: Math.max(band.w, w), h: Math.max(band.h, h) };
    prev = s;
  }
}

function fits(used: Box[], r: Box): boolean {
  for (const u of used) {
    if (r.x < u.x + u.w && u.x < r.x + r.w && r.y < u.y + u.h && u.y < r.y + r.h) return false;
  }
  return true;
}

function pack(rects: Box[], width: number, height: number): boolean {
  // Stable where std::sort is not, so equal areas keep frame order.
  const order = [...rects].sort((a, b) => b.w * b.h - a.w * a.h);
  const used: Box[] = [];
  for (const rc of order) {
    let placed = false;
    for (let v = 0; v <= height - rc.h && !placed; v++) {
      for (let u = 0; u <= width - rc.w; u++) {
        const at = { x: u, y: v, w: rc.w, h: rc.h };
        if (fits(used, at)) {
          used.push(at);
          rc.x = u;
          rc.y = v;
          placed = true;
          break;
        }
      }
    }
    if (!placed) return false;
  }
  return true;
}

function layoutPacked(samples: Sample[], frames: AnimationFrame[]): void {
  const unique: Sample[] = [];
  for (const s of samples) {
    const img = frames[s.frame]!.image;
    s.sameAs = unique.find((u) => sameRegion(frames[u.frame]!.image, u.bounds, img, s.bounds)) ?? null;
    if (!s.sameAs) unique.push(s);
  }
  const rects = unique.map((s) => s.cell);
  let need = 0;
  let w0 = 1;
  let h0 = 1;
  for (const r of rects) {
    need += r.w * r.h;
    w0 = Math.max(w0, r.w);
    h0 = Math.max(h0, r.h);
  }
  let w = w0;
  let h = h0;
  for (let z = 1; !(w * h >= need && pack(rects, w, h)); z++) {
    if (z & 1) w += w0;
    else h += h0;
  }
  for (const s of samples) if (s.sameAs) s.cell = s.sameAs.cell;
}

function colorHex(c: Rgba): string {
  return `#${(c >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * `frames` are the sprite's frames rendered to RGBA, one per frame, in order.
 * With `splitTags` and at least one tag, only tagged frames are written — once
 * per tag that covers them — as Aseprite does.
 */
export function buildSpriteSheet(frames: AnimationFrame[], opts: SheetOptions): SpriteSheet {
  if (frames.length === 0) throw new RangeError("a sprite sheet needs at least one frame");
  const { width: sw, height: sh } = frames[0]!.image;
  for (const f of frames) {
    if (f.image.width !== sw || f.image.height !== sh) throw new RangeError("all frames must have the same dimensions");
  }
  const pad = opts.innerPadding ?? 0;
  if (!Number.isInteger(pad) || pad < 0 || pad > 100) {
    throw new RangeError(`inner padding must be an integer in 0..100, got ${pad}`);
  }
  const tags = opts.tags ?? [];
  for (const t of tags) {
    if (!(Number.isInteger(t.from) && Number.isInteger(t.to) && 0 <= t.from && t.from <= t.to && t.to < frames.length)) {
      throw new RangeError(`tag '${t.name}' covers frames ${t.from}..${t.to}, outside 0..${frames.length - 1}`);
    }
  }

  const items: { tag: SheetTag | null; frames: number[] }[] =
    opts.splitTags && tags.length > 0
      ? tags.map((tag) => ({ tag, frames: Array.from({ length: tag.to - tag.from + 1 }, (_, i) => tag.from + i) }))
      : [{ tag: null, frames: frames.map((_, i) => i) }];

  const samples: Sample[] = [];
  for (const item of items) {
    item.frames.forEach((frame, n) => {
      const tagPart = item.tag ? ` #${item.tag.name}` : "";
      const framePart = item.frames.length > 1 ? ` ${n}` : "";
      // An empty frame still gets a 1x1 cell, so its position and duration survive.
      const bounds = opts.trim ? opaqueBounds(frames[frame]!.image) ?? { x: 0, y: 0, w: 1, h: 1 } : { x: 0, y: 0, w: sw, h: sh };
      samples.push({
        frame,
        tag: item.tag,
        name: `${opts.title}${tagPart}${framePart}${opts.extension ? `.${opts.extension}` : ""}`,
        bounds,
        cell: { x: 0, y: 0, w: bounds.w + pad * 2, h: bounds.h + pad * 2 },
        sameAs: null,
      });
    });
  }

  const type = opts.type ?? "horizontal";
  if (type === "packed") layoutPacked(samples, frames);
  else layoutSimple(samples, type, opts.splitTags ?? false);

  let texW = 0;
  let texH = 0;
  for (const s of samples) {
    texW = Math.max(texW, s.cell.x + s.cell.w);
    texH = Math.max(texH, s.cell.y + s.cell.h);
  }
  const image = new Image(texW, texH);
  for (const s of samples) {
    if (s.sameAs) continue;
    const src = frames[s.frame]!.image.pixels;
    for (let row = 0; row < s.bounds.h; row++) {
      const from = (s.bounds.y + row) * sw + s.bounds.x;
      image.pixels.set(src.subarray(from, from + s.bounds.w), (s.cell.y + pad + row) * texW + s.cell.x + pad);
    }
  }

  const atlas: Atlas = {
    frames: samples.map((s) => ({
      filename: s.name,
      frame: { ...s.cell },
      rotated: false,
      trimmed: s.bounds.x > 0 || s.bounds.y > 0 || s.bounds.w !== sw || s.bounds.h !== sh,
      spriteSourceSize: { ...s.bounds },
      sourceSize: { w: sw, h: sh },
      duration: frames[s.frame]!.durationMs,
    })),
    meta: {
      app: opts.app,
      version: opts.version,
      ...(opts.imageName !== undefined ? { image: opts.imageName } : {}),
      format: "RGBA8888",
      size: { w: texW, h: texH },
      scale: "1",
      frameTags: tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
        ...(t.repeat > 0 ? { repeat: String(t.repeat) } : {}),
        ...((t.color & 255) !== 0 ? { color: colorHex(t.color) } : {}),
      })),
      layers: (opts.layers ?? []).map((l) => ({ name: l.name, opacity: l.opacity, blendMode: "normal" as const })),
      slices: [],
    },
  };
  return { image, atlas };
}

/**
 * The file each frame goes to when frames are saved one per file, following
 * Aseprite's rules: `{frameNN}` counts from NN, zero-padded to as many
 * characters as follow "frame"; without the token, a trailing number in the
 * name is the start and width, else frames count from 1; a single frame
 * without the token keeps the path as it is.
 */
export function frameFileNames(path: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`frame count must be a positive integer, got ${count}`);
  let format = path;
  if (!path.includes("{frame")) {
    if (count === 1) return [path];
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dot = path.lastIndexOf(".");
    const extAt = dot > slash ? dot : path.length;
    const title = path.slice(0, extAt);
    const digits = /\d+$/.exec(title.slice(slash + 1))?.[0] ?? "";
    format =
      digits === ""
        ? `${title}{frame1}${path.slice(extAt)}`
        : `${title.slice(0, title.length - digits.length)}{frame${digits}}${path.slice(extAt)}`;
  }
  const start = format.indexOf("{frame");
  const end = format.indexOf("}", start + 6);
  if (end < 0) return Array.from({ length: count }, () => format);
  const token = format.slice(start, end + 1);
  const spec = token.slice(6, -1);
  const offset = Number.parseInt(spec, 10) || 0;
  return Array.from({ length: count }, (_, i) => format.split(token).join(String(offset + i).padStart(spec.length, "0")));
}
