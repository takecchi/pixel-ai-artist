/**
 * Drawing primitives on a plain image at cel-local coordinates, ported from the
 * extension's `Draw` table. Every primitive writes through `pixel`, which is
 * where the selection clip lives: one that wrote to the image directly would
 * silently paint outside the selection.
 */

import { channels, type ColorMode, type Image, type Rect } from "./model.js";

/** A selection as `pixel` sees it: one byte per canvas pixel, non-zero = selected. */
export interface SurfaceMask {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Surface {
  image: Image;
  /** Canvas position of the image's top-left pixel. */
  ox: number;
  oy: number;
  mode: ColorMode;
  /** The selection `selectionOnly` clips to; null paints anywhere. */
  mask: SurfaceMask | null;
}

export interface Point {
  x: number;
  y: number;
}

/** Writes one raw value at canvas (x, y); 1 if it landed, 0 if clipped by the mask or the image. */
export function pixel(s: Surface, x: number, y: number, value: number): number {
  const m = s.mask;
  if (m && !(x >= 0 && y >= 0 && x < m.width && y < m.height && m.data[y * m.width + x] !== 0)) return 0;
  const lx = x - s.ox;
  const ly = y - s.oy;
  if (lx >= 0 && ly >= 0 && lx < s.image.width && ly < s.image.height) {
    s.image.pixels[ly * s.image.width + lx] = value >>> 0;
    return 1;
  }
  return 0;
}

/**
 * Bresenham. A `thickness` above 1 stamps a square of side 2·floor(t/2)+1, so
 * 2 and 3 both draw three pixels wide.
 */
export function line(
  s: Surface,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number,
  thickness = 1,
): number {
  let count = 0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const half = Math.floor(thickness / 2);

  for (;;) {
    if (thickness <= 1) {
      count += pixel(s, x0, y0, value);
    } else {
      for (let ty = -half; ty <= half; ty++) {
        for (let tx = -half; tx <= half; tx++) count += pixel(s, x0 + tx, y0 + ty, value);
      }
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return count;
}

export function rect(s: Surface, r: Rect, outline: number | undefined, fill: number | undefined): number {
  let count = 0;
  if (fill !== undefined) {
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) count += pixel(s, x, y, fill);
    }
  }
  if (outline !== undefined) {
    const x1 = r.x + r.width - 1;
    const y1 = r.y + r.height - 1;
    count += line(s, r.x, r.y, x1, r.y, outline, 1);
    count += line(s, r.x, y1, x1, y1, outline, 1);
    count += line(s, r.x, r.y, r.x, y1, outline, 1);
    count += line(s, x1, r.y, x1, y1, outline, 1);
  }
  return count;
}

/**
 * The ellipse inscribed in the box, sampled at pixel centres, so an odd-width
 * ellipse stays symmetric. The radius is half the box and the test point is
 * the pixel's centre: a radius of (width-1)/2 measured to pixel corners left
 * an even-sized box two pixels short (a 4×4 box drew a 2×2 square).
 */
export function ellipse(s: Surface, r: Rect, outline: number | undefined, fill: number | undefined): number {
  if (r.width < 2 || r.height < 2) return rect(s, r, outline, fill);
  let count = 0;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const rx = r.width / 2;
  const ry = r.height / 2;

  const inside = (x: number, y: number): boolean => {
    const nx = (x + 0.5 - cx) / rx;
    const ny = (y + 0.5 - cy) / ry;
    return nx * nx + ny * ny <= 1.0;
  };

  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      if (!inside(x, y)) continue;
      const edge = !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1));
      const value = edge ? outline : fill;
      if (value !== undefined) count += pixel(s, x, y, value);
    }
  }
  return count;
}

export function polygon(
  s: Surface,
  points: readonly Point[],
  outline: number | undefined,
  fill: number | undefined,
  closed: boolean,
): number {
  let count = 0;
  const n = points.length;
  if (fill !== undefined && n >= 3) {
    let miny = Number.POSITIVE_INFINITY;
    let maxy = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      miny = Math.min(miny, p.y);
      maxy = Math.max(maxy, p.y);
    }
    for (let y = Math.floor(miny); y <= Math.floor(maxy); y++) {
      const crossings: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % n]!;
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      crossings.sort((p, q) => p - q);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        for (let x = Math.floor(crossings[i]! + 0.5); x <= Math.floor(crossings[i + 1]! - 0.5); x++) {
          count += pixel(s, x, y, fill);
        }
      }
    }
  }
  if (outline !== undefined) {
    // Wrap the same way the fill loop does: stopping one edge short drew every
    // side except the one that closes the shape.
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      count += line(s, a.x, a.y, b.x, b.y, outline, 1);
    }
  }
  return count;
}

/**
 * `tolerance` is the largest per-channel difference (0–255) still counted as
 * the clicked colour. Indexed and grayscale pixels have no RGB channels to
 * compare, so they stay exact.
 */
export function flood(
  s: Surface,
  sx: number,
  sy: number,
  value: number,
  tolerance: number,
  contiguous: boolean,
): number {
  const img = s.image;
  const lx = sx - s.ox;
  const ly = sy - s.oy;
  if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) return 0;
  const target = img.pixels[ly * img.width + lx]!;
  if (target === (value >>> 0)) return 0;

  let matches = (px: number): boolean => px === target;
  if (tolerance > 0 && s.mode === "rgb") {
    const [r, g, b, a] = channels(target);
    matches = (px) => {
      const [pr, pg, pb, pa] = channels(px);
      return (
        Math.abs(pr - r) <= tolerance &&
        Math.abs(pg - g) <= tolerance &&
        Math.abs(pb - b) <= tolerance &&
        Math.abs(pa - a) <= tolerance
      );
    };
  }

  let count = 0;
  if (!contiguous) {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (matches(img.pixels[y * img.width + x]!)) count += pixel(s, x + s.ox, y + s.oy, value);
      }
    }
    return count;
  }

  const stack: number[] = [lx, ly];
  const seen = new Uint8Array(img.width * img.height);
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const key = y * img.width + x;
    if (seen[key]) continue;
    seen[key] = 1;
    // A masked pixel is neither filled nor crossed: the fill stays inside the
    // selection the way Aseprite's own bucket does.
    if (matches(img.pixels[key]!) && pixel(s, x + s.ox, y + s.oy, value) === 1) {
      count++;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
  }
  return count;
}

/** Ordered dither matrices. Bayer keeps texture even at low pixel counts, where random noise just looks like dirt. */
const M4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** The 8×8 matrix generated from the 4×4 recurrence rather than typed out. */
const M8 = Array.from({ length: 8 }, (_, y) =>
  Array.from({ length: 8 }, (_, x) => {
    const quadrant = (y >= 4 ? 2 : 0) + (x >= 4 ? 1 : 0);
    return M4[y % 4]![x % 4]! * 4 + [0, 2, 3, 1][quadrant]!;
  }),
);

const M2 = [
  [0, 2],
  [3, 1],
];

const BAYER: Record<string, { size: number; m: number[][] }> = {
  checker: { size: 2, m: M2 },
  bayer2: { size: 2, m: M2 },
  bayer4: { size: 4, m: M4 },
  bayer8: { size: 8, m: M8 },
};

export const DITHER_PATTERNS = ["checker", "bayer2", "bayer4", "bayer8", "noise"] as const;

/** Lua's `%` is floored, JS's is not; the pattern has to tile the same way left of and above the origin. */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** The threshold in (0, 1) a Bayer pattern puts at canvas (x, y). */
export function bayerThreshold(pattern: string, x: number, y: number): number {
  const spec = BAYER[pattern]!;
  return (spec.m[mod(y, spec.size)]![mod(x, spec.size)]! + 0.5) / (spec.size * spec.size);
}

export function dither(
  s: Surface,
  r: Rect,
  a: number,
  b: number,
  pattern: string,
  ratio: number,
): number {
  let count = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const pick = pattern === "noise" ? Math.random() < ratio : ratio > bayerThreshold(pattern, x, y);
      count += pixel(s, x, y, pick ? b : a);
    }
  }
  return count;
}
