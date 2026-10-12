import { LiveError } from "./protocol.js";

/**
 * PixelGrid: a picture written as text, one glyph per pixel, compiled into the
 * ordinary `draw` ops Aseprite already executes.
 *
 * It is the writable half of `look op="ascii"`. A model is far better at
 * laying out a silhouette it can see as rows of characters than at composing
 * it from ellipse/rect/line calls whose result it cannot see until afterwards,
 * so the grid is the authoring format and this file does the rasterising —
 * deterministically, in code, where an off-by-one is a test failure instead of
 * a misplaced limb.
 *
 * Expansion happens here, server-side, like `text`: the Lua extension never
 * learns a new op, and the same compiler serves the live window and headless.
 */

export const TRANSPARENT_GLYPH = ".";

/** The sprite's canvas. A grid may be as large as it and no larger. */
export interface CanvasSize {
  width: number;
  height: number;
}

export interface GridOp {
  x: number;
  y: number;
  /** glyph → colour; null is transparent. "." is transparent unless redefined. */
  legend: Record<string, string | null>;
  rows: string[];
  /** What transparent cells do: "erase" clears them, "skip" leaves the pixel underneath. */
  transparent: "erase" | "skip";
}

export interface CompiledGrid {
  /** Wire ops for draw.batch: `clear` rectangles first, then one `pixels` op per colour. */
  ops: Record<string, unknown>[];
  width: number;
  height: number;
  painted: number;
  erased: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function compileGrid(op: GridOp, canvas: CanvasSize): CompiledGrid {
  const legend = new Map<string, string | null>();
  if (!Object.hasOwn(op.legend, TRANSPARENT_GLYPH)) legend.set(TRANSPARENT_GLYPH, null);
  for (const [glyph, color] of Object.entries(op.legend)) {
    // Code points, not UTF-16 units: a glyph outside the BMP is still one cell.
    if (Array.from(glyph).length !== 1) {
      throw new LiveError(
        "invalid_args",
        `Legend key '${glyph}' is not a single character. Every grid cell is exactly one glyph, so every legend key must be one too.`,
        { glyph },
      );
    }
    legend.set(glyph, color);
  }

  const grid = op.rows.map((row) => Array.from(row));
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  if (height === 0 || width === 0) {
    throw new LiveError("invalid_args", "A grid needs at least one row with at least one cell.");
  }
  if (width > canvas.width || height > canvas.height) {
    throw new LiveError(
      "too_large",
      `Grid is ${width}×${height} but the canvas is ${canvas.width}×${canvas.height}. A grid can cover the whole canvas, not more — ` +
        `check for extra rows or columns.`,
      { width, height, canvasWidth: canvas.width, canvasHeight: canvas.height },
    );
  }

  // Ragged rows are the commonest way a model miscounts a grid. Padding or
  // truncating would silently shift everything right of the mistake, so name
  // the row instead and let the model fix the one line that is wrong.
  for (let r = 0; r < height; r++) {
    const length = grid[r]!.length;
    if (length !== width) {
      throw new LiveError(
        "invalid_args",
        `Grid row ${r} (y=${op.y + r}) has ${length} cell(s) but row 0 has ${width}. Every row must be the same width — ` +
          `pad with '${TRANSPARENT_GLYPH}' rather than leaving a row short.`,
        { row: r, y: op.y + r, cells: length, expected: width },
      );
    }
    for (let c = 0; c < width; c++) {
      const glyph = grid[r]![c]!;
      if (!legend.has(glyph)) {
        throw new LiveError(
          "invalid_args",
          `Grid row ${r}, column ${c} (x=${op.x + c}, y=${op.y + r}) uses '${glyph}', which is not in the legend. ` +
            `Add it to the legend or use '${TRANSPARENT_GLYPH}' for transparent.`,
          { row: r, column: c, x: op.x + c, y: op.y + r, glyph },
        );
      }
    }
  }

  const byColor = new Map<string, { x: number; y: number }[]>();
  // Erased cells merge into rectangles: horizontal runs per row, then runs with
  // the same span in consecutive rows grow one rectangle downward. A transparent
  // margin around a sprite then costs a handful of clears, not one per cell.
  const erases: Rect[] = [];
  let open = new Map<string, Rect>();
  let painted = 0;
  let erased = 0;

  for (let r = 0; r < height; r++) {
    const row = grid[r]!;
    const next = new Map<string, Rect>();
    let c = 0;
    while (c < width) {
      const color = legend.get(row[c]!) ?? null;
      if (color !== null) {
        const points = byColor.get(color) ?? [];
        points.push({ x: op.x + c, y: op.y + r });
        byColor.set(color, points);
        painted++;
        c++;
        continue;
      }
      const start = c;
      while (c < width && (legend.get(row[c]!) ?? null) === null) c++;
      if (op.transparent === "skip") continue;
      erased += c - start;
      const key = `${start}:${c - start}`;
      const above = open.get(key);
      if (above) {
        above.height++;
        next.set(key, above);
      } else {
        const rect = { x: op.x + start, y: op.y + r, width: c - start, height: 1 };
        erases.push(rect);
        next.set(key, rect);
      }
    }
    open = next;
  }

  const ops: Record<string, unknown>[] = erases.map((region) => ({ kind: "clear", region }));
  for (const [color, points] of byColor) ops.push({ kind: "pixels", color, points });
  return { ops, width, height, painted, erased };
}
