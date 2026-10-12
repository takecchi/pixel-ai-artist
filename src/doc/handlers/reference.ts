import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeImage } from "../../lib/decode.js";
import { ToolError, need } from "../errors.js";
import { Image, displayName, rgbaToHex, rgbaToPixel, transparentPixel, type Rect, type Sprite } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

/** The first frame of an image file, as RGBA. */
function readImage(file: string): Image {
  const full = path.resolve(file);
  let decoded: ReturnType<typeof decodeImage>;
  try {
    decoded = decodeImage(readFileSync(full));
  } catch (err) {
    throw new ToolError("io_error", `Could not open '${file}': ${(err as Error).message}`, { path: full });
  }
  return Array.isArray(decoded) ? decoded[0]!.image : decoded;
}

function crop(img: Image, r: Rect): Image {
  const out = new Image(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) out.pixels[y * r.width + x] = img.get(r.x + x, r.y + y);
  }
  return out;
}

/** Nearest-neighbour resize. */
function resize(img: Image, w: number, h: number): Image {
  const out = new Image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.pixels[y * w + x] = img.pixels[Math.floor((y * img.height) / h) * img.width + Math.floor((x * img.width) / w)]!;
    }
  }
  return out;
}

function isReference(name: string): boolean {
  return name.startsWith("reference");
}

/**
 * One panel of a concept sheet, in source pixels. Checked rather than clamped:
 * a region off the image means the sheet was misread, and a silently shrunk
 * crop would hand back the wrong panel.
 */
function sourceRegion(img: Image, region: unknown): Image {
  if (region === undefined) return img;
  const r = region as Rect;
  if (r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 || r.x + r.width > img.width || r.y + r.height > img.height) {
    throw new ToolError(
      "invalid_args",
      `region ${r.x},${r.y} ${r.width}x${r.height} is outside the ${img.width}x${img.height} source image.`,
    );
  }
  return crop(img, r);
}

function samplePalette(sprite: Sprite, img: Image, colors: unknown) {
  // A Map keeps first-seen order, which the stable sort ties on.
  const counts = new Map<string, number>();
  let total = 0;
  for (const c of img.pixels) {
    if ((c & 255) === 0) continue;
    const hex = rgbaToHex(c, false);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
    total++;
  }
  const palette = [...counts]
    .map(([hex, n]) => ({ hex, share: n / Math.max(total, 1) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, colors === undefined ? 16 : Number(colors))
    .map(({ hex, share }) => ({ hex, share: Math.floor(share * 1000 + 0.5) / 1000 }));
  return { sprite: displayName(sprite), op: "sample_palette", palette, width: img.width, height: img.height };
}

function panelsOf(img: Image, grid: unknown): Image[] {
  if (grid === undefined) return [img];
  const g = grid as Record<string, unknown>;
  const cols = need(g.columns, "grid.columns") as number;
  const rows = need(g.rows, "grid.rows") as number;
  const gap = (g.gap as number | undefined) ?? 0;
  const count = (g.count as number | undefined) ?? cols * rows;
  if (cols < 1 || rows < 1 || count < 1 || count > cols * rows) {
    throw new ToolError("invalid_args", "grid needs columns ≥ 1, rows ≥ 1 and 1 ≤ count ≤ columns×rows.");
  }
  const pw = Math.floor((img.width - gap * (cols - 1)) / cols);
  const ph = Math.floor((img.height - gap * (rows - 1)) / rows);
  if (pw < 1 || ph < 1) {
    throw new ToolError("invalid_args", `A ${cols}x${rows} grid with gap ${gap} does not fit a ${img.width}x${img.height} image.`);
  }
  return Array.from({ length: count }, (_, i) =>
    crop(img, { x: (i % cols) * (pw + gap), y: Math.floor(i / cols) * (ph + gap), width: pw, height: ph }),
  );
}

/** The size a panel is drawn at: kept, fitted inside or around the canvas, or stretched over it. */
function fitted(sprite: Sprite, w: number, h: number, fit: unknown): [number, number] {
  if (fit === "none") return [w, h];
  const ratio = fit === "cover" ? Math.max(sprite.width / w, sprite.height / h)
    : fit === undefined || fit === "contain" ? Math.min(sprite.width / w, sprite.height / h)
    : null;
  if (ratio === null) return [sprite.width, sprite.height];
  return [Math.max(1, Math.floor(w * ratio)), Math.max(1, Math.floor(h * ratio))];
}

function importReference(studio: Studio, sprite: Sprite, img: Image, args: Record<string, unknown>) {
  const panels = panelsOf(img, args.grid);
  const first = args.grid !== undefined && args.frame === undefined ? 1 : studio.resolveFrame(sprite, args.frame);
  const last = first + panels.length - 1;
  if (last > sprite.frames.length) {
    throw new ToolError(
      "invalid_args",
      `The sheet has ${panels.length} panels starting at frame ${first}, but the sprite has ${sprite.frames.length} frame(s). ` +
        "Add frames first (frame op 'add'), or pass grid.count.",
    );
  }
  const [tw, th] = fitted(sprite, panels[0]!.width, panels[0]!.height, args.fit);
  const name = typeof args.name === "string" ? args.name : "reference";

  // The layer tools draw on stays where it was: a reference made active would take the next draw call.
  const active = sprite.activeLayerId;
  const layer = studio.addLayer(sprite, name);
  sprite.activeLayerId = active;
  layer.opacity = args.opacity === undefined ? 128 : Number(args.opacity);
  layer.editable = false;

  const frames: number[] = [];
  panels.forEach((panel, i) => {
    const scaled = resize(panel, tw, th);
    const image = new Image(tw, th);
    scaled.pixels.forEach((c, j) => {
      image.pixels[j] = (c & 255) === 0 ? transparentPixel(sprite) : rgbaToPixel(sprite, c);
    });
    layer.cels.set(first + i, { x: Number(args.x ?? 0), y: Number(args.y ?? 0), image, opacity: 255 });
    frames.push(first + i);
  });
  sprite.modified = true;
  return { sprite: displayName(sprite), op: "import", layer: name, width: tw, height: th, panels: panels.length, frames };
}

function referenceApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const op = need(args.op, "op");

  if (op === "list") {
    return { sprite: displayName(sprite), op, references: sprite.layers.map((l) => l.name).filter(isReference) };
  }
  if (op === "remove") {
    const layer = studio.resolveLayer(sprite, args.name ?? "reference");
    if (sprite.layers.length === 1) throw new ToolError("invalid_args", "A sprite keeps at least one layer.");
    sprite.layers.splice(sprite.layers.indexOf(layer), 1);
    sprite.modified = true;
    return { sprite: displayName(sprite), op };
  }

  const img = sourceRegion(readImage(String(need(args.path, "path"))), args.region);
  if (op === "sample_palette") return samplePalette(sprite, img, args.colors);
  // The extension imported for any other op; kept until that is fixed on its own.
  return importReference(studio, sprite, img, args);
}

export const referenceHandlers: HandlerTable = {
  "reference.apply": referenceApply,
};
