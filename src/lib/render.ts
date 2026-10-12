import { LiveError } from "./protocol.js";
// Shared with the grid compiler: `look ascii` output must draw back unchanged.
import { TRANSPARENT_GLYPH } from "./grid.js";

/**
 * Turning pixels into something a language model can actually read.
 *
 * A 32×32 sprite rendered as a PNG is ~8 screen pixels wide once a vision model
 * downsamples it; the model then guesses. Two representations fix that:
 *   - an upscaled preview PNG (done inside Aseprite, see the `preview` tool);
 *   - a text grid, one glyph per pixel, which is exact and works on clients
 *     with no vision at all.
 *
 * The text grid is the verification half of the draw → look → fix loop.
 */

export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Distinct colours in the region. Index 0 is always fully transparent. */
  colors: string[];
  /** Row-major indices into `colors`, length = width * height. */
  grid: number[];
}

/**
 * Glyph alphabet. Glyph N belongs to palette index N, for every region and
 * every frame, so reading a sprite in pieces yields one consistent legend and
 * the rows of one piece can be pasted into another. 261 entries — ASCII first,
 * then Latin-1 and Latin Extended-A letters — covers a full 256-colour palette
 * with room for a few off-palette colours. `.` and `-` are never in it: they
 * mean transparent and erased.
 */
const GLYPHS: readonly string[] = (() => {
  const out = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@%&$?!+=*");
  for (let cp = 0xc0; cp <= 0x17f; cp++) {
    // × and ÷ read as operators, ŉ is deprecated and decomposes.
    if (cp === 0xd7 || cp === 0xf7 || cp === 0x149) continue;
    out.push(String.fromCodePoint(cp));
  }
  return out;
})();

export const GLYPH_COUNT = GLYPHS.length;

/**
 * Colour → glyph. Palette colours get the glyph of their palette index;
 * colours not in the palette take the slots after the palette, in order of
 * appearance, and are the only glyphs that can differ between two reads.
 */
class GlyphTable {
  readonly legend: Record<string, string> = {};
  readonly offPalette: string[] = [];
  private readonly byColor = new Map<string, string>();
  private readonly paletteIndex = new Map<string, number>();
  private nextFree: number;

  constructor(palette: readonly string[]) {
    const exact = palette.map((c) => c.toLowerCase());
    exact.forEach((c, i) => {
      if (!this.paletteIndex.has(c)) this.paletteIndex.set(c, i);
    });
    // An indexed sprite's pixels read back as #rrggbb even when the palette
    // entry carries alpha, so the opaque form is a fallback key — exact wins.
    exact.forEach((c, i) => {
      const opaque = c.slice(0, 7);
      if (!this.paletteIndex.has(opaque)) this.paletteIndex.set(opaque, i);
    });
    this.nextFree = palette.length;
  }

  glyphFor(color: string): string {
    const key = color.toLowerCase();
    const known = this.byColor.get(key);
    if (known) return known;

    const index = this.paletteIndex.get(key);
    let glyph: string | undefined;
    if (index !== undefined && index < GLYPHS.length) {
      glyph = GLYPHS[index];
    } else {
      glyph = GLYPHS[this.nextFree++];
      if (glyph === undefined) {
        throw new LiveError(
          "too_large",
          `Colour ${color} has no glyph: the palette and the off-palette colours together need more than ${GLYPHS.length}. ` +
            `Sharing a glyph would make the grid lie about which colour is where. Snap the art to the palette ` +
            `(recolor op 'snap') or use the preview op.`,
          { color, maxGlyphs: GLYPHS.length },
        );
      }
      this.offPalette.push(glyph);
    }
    this.byColor.set(key, glyph!);
    this.legend[glyph!] = color;
    return glyph!;
  }
}

export interface AsciiOptions {
  /** The sprite's palette, in index order. Glyphs follow it; omitted, every colour counts as off-palette. */
  palette?: readonly string[];
  showRulers?: boolean;
}


export interface AsciiView {
  text: string;
  /** The grid alone, no rulers or row labels — exactly what `draw` kind `grid` takes as `rows`. */
  rows: string[];
  legend: Record<string, string>;
  /** Glyphs for colours outside the palette — the only ones not stable between reads. */
  offPalette: string[];
  width: number;
  height: number;
  originX: number;
  originY: number;
}

/**
 * No size cap: the region is already clamped to the canvas, and the text grid
 * is the read half of `draw` kind 'grid', which accepts the whole canvas too.
 */
export function renderAscii(region: PixelRegion, opts: AsciiOptions = {}): AsciiView {
  const table = new GlyphTable(opts.palette ?? []);
  const glyphFor = new Map<number, string>();
  glyphFor.set(0, TRANSPARENT_GLYPH);
  for (let i = 1; i < region.colors.length; i++) {
    glyphFor.set(i, table.glyphFor(region.colors[i] ?? "#000000"));
  }
  const rows: string[] = [];
  for (let row = 0; row < region.height; row++) {
    let line = "";
    for (let col = 0; col < region.width; col++) {
      const idx = region.grid[row * region.width + col] ?? 0;
      line += glyphFor.get(idx) ?? "?";
    }
    rows.push(line);
  }

  const showRulers = opts.showRulers ?? true;
  const lines: string[] = [];
  if (showRulers) {
    const rowLabelWidth = String(region.y + region.height - 1).length;
    const pad = " ".repeat(rowLabelWidth + 1);
    // Two ruler rows: tens then units, so a 3-digit x is still readable.
    let tens = pad;
    let units = pad;
    for (let x = 0; x < region.width; x++) {
      const abs = region.x + x;
      tens += abs % 10 === 0 ? String(Math.floor(abs / 10) % 10) : " ";
      units += String(abs % 10);
    }
    lines.push(tens.trimEnd());
    lines.push(units);
    rows.forEach((line, row) => lines.push(String(region.y + row).padStart(rowLabelWidth) + " " + line));
  } else {
    lines.push(...rows);
  }

  return {
    text: lines.join("\n"),
    rows,
    legend: table.legend,
    offPalette: table.offPalette,
    width: region.width,
    height: region.height,
    originX: region.x,
    originY: region.y,
  };
}

export interface DiffView {
  text: string;
  legend: Record<string, string>;
  /** Glyphs for colours outside the palette — the only ones not stable between reads. */
  offPalette: string[];
  changed: number;
  total: number;
  /** Tight bounding box of every changed pixel, absolute coordinates. Null when nothing changed. */
  changedBounds: { x: number; y: number; width: number; height: number } | null;
  /** `changed / total * 100`, rounded to two decimals. */
  percentChanged: number;
}

/**
 * Pixel-level diff between two regions of equal size.
 *   `.` unchanged   `-` became transparent   glyph = the *new* colour
 * This answers "what did my edit actually touch", which a before/after image
 * pair does not, at small sizes.
 */
export function renderDiff(before: PixelRegion, after: PixelRegion, palette: readonly string[] = []): DiffView {
  if (before.width !== after.width || before.height !== after.height) {
    throw new LiveError(
      "invalid_args",
      `Cannot diff regions of different sizes (${before.width}×${before.height} vs ${after.width}×${after.height}).`,
    );
  }

  // Same glyphs as `look ascii`, so a diff and a read of the same sprite agree.
  const table = new GlyphTable(palette);

  const lines: string[] = [];
  let changed = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let row = 0; row < before.height; row++) {
    let line = "";
    for (let col = 0; col < before.width; col++) {
      const i = row * before.width + col;
      const beforeColor = before.colors[before.grid[i] ?? 0] ?? "transparent";
      const afterIdx = after.grid[i] ?? 0;
      const afterColor = after.colors[afterIdx] ?? "transparent";

      if (beforeColor === afterColor) {
        line += ".";
        continue;
      }
      changed++;
      if (col < minX) minX = col;
      if (col > maxX) maxX = col;
      if (row < minY) minY = row;
      if (row > maxY) maxY = row;
      if (afterIdx === 0) {
        line += "-";
        continue;
      }
      line += table.glyphFor(afterColor);
    }
    lines.push(line);
  }

  const total = before.width * before.height;
  const changedBounds =
    changed === 0
      ? null
      : {
          x: before.x + minX,
          y: before.y + minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        };

  return {
    text: lines.join("\n"),
    legend: table.legend,
    offPalette: table.offPalette,
    changed,
    total,
    changedBounds,
    percentChanged: Math.round((changed / total) * 10000) / 100,
  };
}

/**
 * Pick an integer upscale factor that lands a sprite's long edge near `target`.
 * Nearest-neighbour only — any smoothing destroys the thing being reviewed.
 *
 * The bound is on the OUTPUT size, not the factor. Capping the factor at 16 —
 * as this once did — renders an 8px sprite at 128px and a 16px one at 256px,
 * which are precisely the cases where a vision model is otherwise guessing.
 */
export function previewScale(width: number, height: number, target = 1024, maxEdge = 2048): number {
  const longEdge = Math.max(width, height, 1);
  const wanted = Math.max(1, Math.round(target / longEdge));
  const byOutput = Math.max(1, Math.floor(maxEdge / longEdge));
  return Math.min(wanted, byOutput);
}

/** Grid layout for a filmstrip: as close to square as whole cells allow. */
export function filmstripLayout(frames: number): { cols: number; rows: number } {
  if (frames <= 0) return { cols: 0, rows: 0 };
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);
  return { cols, rows };
}
