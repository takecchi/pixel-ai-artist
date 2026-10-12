/**
 * Bitmap text layout — turns a string into a list of coloured pixels.
 *
 * Aseprite's Lua API has no text rasteriser, so this runs entirely on the TS
 * side: `draw` op kind `text` calls `layoutText` and hands the result to
 * Aseprite as an ordinary `pixels` op, in the same transaction and under the
 * same palette lock as everything else in the batch (see ADR-0005).
 *
 * All layout maths happens in *font-grid units* — one cell per glyph column —
 * and only expands to output pixels (via `scale`) at the very end. Doing bold
 * growth and outline neighbour-checks at grid resolution, before the
 * nearest-neighbour blow-up, is what keeps a scaled letter's stroke weight
 * proportional instead of a 1px sliver lost in a 4x scale-up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LiveError } from "./protocol.js";

export interface Font {
  name: string;
  license: string;
  cellWidth: number;
  cellHeight: number;
  /** Rows from the top of the cell down to and including the baseline row. */
  baseline: number;
  spaceWidth: number;
  glyphs: Record<string, string[]>;
  advance?: Record<string, number>;
}

export type TextAnchor =
  | "top_left"
  | "top"
  | "top_right"
  | "left"
  | "center"
  | "right"
  | "bottom_left"
  | "bottom"
  | "bottom_right"
  | "baseline_left"
  | "baseline"
  | "baseline_right";

export interface TextPixel {
  x: number;
  y: number;
  color: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutTextOptions {
  text: string;
  x: number;
  y: number;
  color: string;
  font: Font;
  anchor?: TextAnchor;
  letterSpacing?: number;
  lineSpacing?: number;
  bold?: number;
  outlineColor?: string;
  outlineDiagonals?: boolean;
  shadowColor?: string;
  shadowOffset?: { x: number; y: number };
  scale?: number;
}

export interface TextLayout {
  pixels: TextPixel[];
  /** Tight bounding box of the glyph ink alone — never outline or shadow. */
  inkBounds: Bounds | null;
}

const fontCache = new Map<string, Font>();

/**
 * Resolve `knowledge/fonts/<name>.json` relative to the package root, the
 * same way `palette.ts` resolves `knowledge/palettes.json`.
 */
export function loadFont(name: string): Font {
  const cached = fontCache.get(name);
  if (cached) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/lib/text.js → package root
  const file = path.resolve(here, "..", "..", "knowledge", "fonts", `${name}.json`);
  let font: Font;
  try {
    font = JSON.parse(readFileSync(file, "utf8")) as Font;
  } catch {
    throw new LiveError(
      "invalid_args",
      `Unknown font '${name}'. No file at knowledge/fonts/${name}.json.`,
      { font: name },
    );
  }
  fontCache.set(name, font);
  return font;
}

function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5);
}

const cellKey = (col: number, row: number): string => `${col},${row}`;
const parseCellKey = (key: string): [number, number] => {
  const [c, r] = key.split(",");
  return [Number(c), Number(r)];
};

/** Neighbour offsets for outline growth. */
const NEIGHBOURS_4: ReadonlyArray<[number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];
const NEIGHBOURS_8: ReadonlyArray<[number, number]> = [
  ...NEIGHBOURS_4,
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

interface GridBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function gridBoundsOf(cells: ReadonlySet<string>): GridBounds | null {
  if (cells.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of cells) {
    const [c, r] = parseCellKey(key);
    if (c < minX) minX = c;
    if (c > maxX) maxX = c;
    if (r < minY) minY = r;
    if (r > maxY) maxY = r;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Lay out `text` (multiline via "\n") against `font` and return every pixel
 * that should be written, plus the tight ink bounding box used for anchoring.
 *
 * Outline and shadow are decorative layers computed from the glyph ink after
 * `bold` growth, but never move it and never enter `inkBounds` — anchoring a
 * label by its ink, then turning on an outline, must not shift the label.
 */
export function layoutText(opts: LayoutTextOptions): TextLayout {
  const font = opts.font;
  const anchor = opts.anchor ?? "top_left";
  const letterSpacing = opts.letterSpacing ?? 1;
  const lineSpacing = opts.lineSpacing ?? 1;
  const bold = Math.max(0, Math.min(3, Math.trunc(opts.bold ?? 0)));
  const scale = Math.max(1, Math.min(8, Math.trunc(opts.scale ?? 1)));
  const outlineDiagonals = opts.outlineDiagonals ?? true;
  const shadowOffset = opts.shadowOffset ?? { x: 1, y: 1 };

  const lines = opts.text.split("\n");

  // ── 1. place glyph ink in grid units ──────────────────────────────────────
  const ink = new Set<string>();
  let cursorY = 0;
  let baselineRow = font.baseline - 1; // first line's baseline, grid-relative
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    if (li === 0) baselineRow = cursorY + (font.baseline - 1);
    let cursorX = 0;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci]!;
      const glyph = font.glyphs[ch];
      const advance =
        font.advance?.[ch] ?? (ch === " " ? font.spaceWidth : (glyph?.[0]?.length ?? font.spaceWidth));
      if (glyph) {
        for (let row = 0; row < glyph.length; row++) {
          const gRow = glyph[row] ?? "";
          for (let col = 0; col < gRow.length; col++) {
            if (gRow[col] === "#") ink.add(cellKey(cursorX + col, cursorY + row));
          }
        }
      }
      cursorX += advance;
      if (ci < line.length - 1) cursorX += letterSpacing;
    }
    cursorY += font.cellHeight;
    if (li < lines.length - 1) cursorY += lineSpacing;
  }

  // ── 2. bold: grow every ink cell rightward, `bold` grid-cell passes ──────
  let boldInk = ink;
  for (let pass = 0; pass < bold; pass++) {
    const next = new Set(boldInk);
    for (const key of boldInk) {
      const [c, r] = parseCellKey(key);
      next.add(cellKey(c + 1, r));
    }
    boldInk = next;
  }

  const inkGridBounds = gridBoundsOf(boldInk);

  // ── 3. outline: neighbours of ink that are not themselves ink ────────────
  const outlineCells = new Set<string>();
  if (opts.outlineColor) {
    const neighbours = outlineDiagonals ? NEIGHBOURS_8 : NEIGHBOURS_4;
    for (const key of boldInk) {
      const [c, r] = parseCellKey(key);
      for (const [dx, dy] of neighbours) {
        const nk = cellKey(c + dx, r + dy);
        if (!boldInk.has(nk)) outlineCells.add(nk);
      }
    }
  }

  // ── 4. anchor: resolve the grid-unit point that lands on (x, y) ──────────
  const [vertical, horizontal] = parseAnchor(anchor);
  const width = inkGridBounds ? inkGridBounds.maxX - inkGridBounds.minX + 1 : 0;
  const height = inkGridBounds ? inkGridBounds.maxY - inkGridBounds.minY + 1 : 0;
  const minX = inkGridBounds?.minX ?? 0;
  const minY = inkGridBounds?.minY ?? 0;

  const anchorGridX =
    horizontal === "left" ? minX : horizontal === "right" ? minX + width - 1 : minX + (width - 1) / 2;
  const anchorGridY =
    vertical === "top"
      ? minY
      : vertical === "bottom"
        ? minY + height - 1
        : vertical === "baseline"
          ? baselineRow
          : minY + (height - 1) / 2;

  const originX = opts.x - anchorGridX * scale;
  const originY = opts.y - anchorGridY * scale;

  const finalOf = (col: number, row: number): { x: number; y: number }[] => {
    const baseX = roundHalfUp(col * scale + originX);
    const baseY = roundHalfUp(row * scale + originY);
    const out: { x: number; y: number }[] = [];
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) out.push({ x: baseX + sx, y: baseY + sy });
    }
    return out;
  };

  // ── 5. emit pixels: shadow, then outline, then ink — later wins on overlap ─
  const pixels = new Map<string, string>();

  if (opts.shadowColor) {
    for (const key of boldInk) {
      const [c, r] = parseCellKey(key);
      for (const p of finalOf(c, r)) {
        pixels.set(cellKey(p.x + shadowOffset.x, p.y + shadowOffset.y), opts.shadowColor);
      }
    }
  }
  if (opts.outlineColor) {
    for (const key of outlineCells) {
      const [c, r] = parseCellKey(key);
      for (const p of finalOf(c, r)) pixels.set(cellKey(p.x, p.y), opts.outlineColor);
    }
  }
  for (const key of boldInk) {
    const [c, r] = parseCellKey(key);
    for (const p of finalOf(c, r)) pixels.set(cellKey(p.x, p.y), opts.color);
  }

  // ── 6. ink bounds, in the same final pixel space as the emitted pixels ───
  let inkBounds: Bounds | null = null;
  if (inkGridBounds) {
    const topLeft = finalOf(inkGridBounds.minX, inkGridBounds.minY)[0]!;
    inkBounds = {
      x: topLeft.x,
      y: topLeft.y,
      width: (inkGridBounds.maxX - inkGridBounds.minX + 1) * scale,
      height: (inkGridBounds.maxY - inkGridBounds.minY + 1) * scale,
    };
  }

  const out: TextPixel[] = [];
  for (const [key, color] of pixels) {
    const [x, y] = parseCellKey(key);
    out.push({ x, y, color });
  }

  return { pixels: out, inkBounds };
}

type Vertical = "top" | "middle" | "bottom" | "baseline";
type Horizontal = "left" | "center" | "right";

function parseAnchor(anchor: TextAnchor): [Vertical, Horizontal] {
  switch (anchor) {
    case "top_left":
      return ["top", "left"];
    case "top":
      return ["top", "center"];
    case "top_right":
      return ["top", "right"];
    case "left":
      return ["middle", "left"];
    case "center":
      return ["middle", "center"];
    case "right":
      return ["middle", "right"];
    case "bottom_left":
      return ["bottom", "left"];
    case "bottom":
      return ["bottom", "center"];
    case "bottom_right":
      return ["bottom", "right"];
    case "baseline_left":
      return ["baseline", "left"];
    case "baseline":
      return ["baseline", "center"];
    case "baseline_right":
      return ["baseline", "right"];
  }
}
