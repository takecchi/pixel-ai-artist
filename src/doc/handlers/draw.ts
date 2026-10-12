import { ToolError, need } from "../errors.js";
import {
  channels,
  displayName,
  hexToRgba,
  isOpaque,
  rgba,
  rgbaToHex,
  rgbaToPixel,
  snapToPalette,
  transparentPixel,
  type Rect,
  type Rgba,
  type Sprite,
} from "../model.js";
import * as Draw from "../raster.js";
import { DITHER_PATTERNS, bayerThreshold, type Point, type Surface } from "../raster.js";
import { clampRegion, selectionFromMask, selectionIsEmpty } from "../selection.js";
import type { HandlerTable, Studio } from "../studio.js";

type Op = Record<string, unknown>;

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolError("invalid_args", `'${name}' must be a number.`);
  }
  return v;
}

function rectOf(v: unknown, name: string): Rect {
  const r = need(v, name) as Record<string, unknown>;
  return { x: num(r.x, `${name}.x`), y: num(r.y, `${name}.y`), width: num(r.width, `${name}.width`), height: num(r.height, `${name}.height`) };
}

function pointOf(v: unknown, name: string): Point {
  const p = need(v, name) as Record<string, unknown>;
  return { x: num(p.x, `${name}.x`), y: num(p.y, `${name}.y`) };
}

function pointsOf(v: unknown, name: string): Point[] {
  const list = need(v, name);
  if (!Array.isArray(list)) throw new ToolError("invalid_args", `'${name}' must be an array.`);
  return list.map((p, i) => pointOf(p, `${name}[${i}]`));
}

function pointBox(list: readonly Point[]): Rect | undefined {
  if (list.length === 0) return undefined;
  const xs = list.map((p) => p.x);
  const ys = list.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 };
}

function union(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a || !b) return a ?? b;
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * What an op touches, in canvas coordinates. The cel is grown to cover the
 * union of these before drawing.
 */
function opBounds(sprite: Sprite, op: Op): Rect | undefined {
  const canvas = { x: 0, y: 0, width: sprite.width, height: sprite.height };
  switch (op.kind) {
    case "pixels":
      return pointBox(pointsOf(op.points, "points"));
    case "line": {
      const box = pointBox([pointOf(op.from, "from"), pointOf(op.to, "to")])!;
      // A brush wider than 1px paints beyond its endpoints. Without this padding
      // the cel is grown to the endpoints only, and the stamp is silently
      // clipped — reporting success and a bounding box that hides the loss.
      const pad = Math.floor(num(op.thickness ?? 1, "thickness") / 2);
      if (pad <= 0) return box;
      return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
    }
    case "polyline":
      return pointBox(pointsOf(op.points, "points"));
    case "rect":
    case "ellipse":
    case "dither":
    case "gradient":
      return rectOf(op.rect, "rect");
    case "replace":
    case "clear":
      return op.region ? rectOf(op.region, "region") : canvas;
    case "blit": {
      const to = pointOf(op.to, "to");
      const from = rectOf(op.from, "from");
      return { x: to.x, y: to.y, width: from.width, height: from.height };
    }
    default:
      return canvas;
  }
}

function drawBatch(studio: Studio, args: Record<string, unknown>) {
  const s = studio.resolveSprite(args.sprite);
  const layer = studio.resolveLayer(s, args.layer);
  const frame = studio.resolveFrame(s, args.frame);
  const ops = need(args.ops, "ops") as Op[];
  if (!Array.isArray(ops)) throw new ToolError("invalid_args", "'ops' must be an array.");

  const snapped: { from: string; to: string; deltaE: number }[] = [];
  const seenSnap = new Set<string>();

  // Every colour is resolved before it is drawn with: the palette lock has to
  // be visible to the agent as a report, not applied invisibly mid-draw.
  const resolveColor = (color: Rgba): number => {
    if (args.paletteLock !== false && s.colorMode !== "indexed") {
      const { color: snappedColor, distance } = snapToPalette(s, color);
      const to = rgbaToHex(snappedColor, false);
      const from = rgbaToHex(color, false);
      if (to !== from && !seenSnap.has(from)) {
        seenSnap.add(from);
        snapped.push({ from, to, deltaE: Math.floor(distance * 100 + 0.5) / 100 });
      }
      color = snappedColor;
    }
    return rgbaToPixel(s, color);
  };
  const resolve = (hex: unknown): number | undefined =>
    hex === undefined || hex === null ? undefined : resolveColor(hexToRgba(hex as string));
  const resolveNeeded = (hex: unknown, name: string): number => resolve(need(hex, name))!;

  let changed = 0;
  let touched: Rect | undefined;

  let mask: Surface["mask"] = null;
  if (args.selectionOnly) {
    if (selectionIsEmpty(s.selection)) {
      throw new ToolError(
        "invalid_args",
        "selectionOnly was set but nothing is selected. Falling back to the whole cel would " +
          "repaint far more than you asked for, so this refuses instead. Make a selection with " +
          "the select tool first, or drop selectionOnly.",
      );
    }
    mask = { data: s.selection!.mask, width: s.width, height: s.height };
  }

  // There is no transaction to roll back, so a batch that fails partway leaves
  // the cel as it found it: drawing happens on a copy and only lands at the end.
  const existing = layer.cels.get(frame);
  const before = existing && { x: existing.x, y: existing.y, image: existing.image };
  try {
    if (!existing && args.createCel === false) {
      throw new ToolError("invalid_args", `No cel on '${layer.name}' frame ${frame} and createCel is false.`);
    }
    // Grow once for the whole batch rather than per op.
    let needed: Rect | undefined;
    for (const op of ops) needed = union(needed, opBounds(s, op));
    const cel = studio.ensureCel(s, layer, frame, needed);

    const surface: Surface = { image: cel.image.clone(), ox: cel.x, oy: cel.y, mode: s.colorMode, mask };
    const img = surface.image;

    for (const op of ops) {
      switch (op.kind) {
        case "pixels": {
          const fallback = resolve(op.color);
          for (const p of op.points as Record<string, unknown>[]) {
            const value = p.color ? resolve(p.color) : fallback;
            if (value === undefined) {
              throw new ToolError("invalid_args", "A pixel has no colour and the op has no default `color`.");
            }
            changed += Draw.pixel(surface, num(p.x, "points.x"), num(p.y, "points.y"), value);
          }
          break;
        }
        case "line": {
          const from = pointOf(op.from, "from");
          const to = pointOf(op.to, "to");
          changed += Draw.line(surface, from.x, from.y, to.x, to.y, resolveNeeded(op.color, "color"), num(op.thickness ?? 1, "thickness"));
          break;
        }
        case "polyline": {
          const points = pointsOf(op.points, "points");
          if (op.closed) {
            changed += Draw.polygon(surface, points, resolve(op.color), resolve(op.fill), true);
          } else {
            for (let i = 0; i < points.length - 1; i++) {
              changed += Draw.line(surface, points[i]!.x, points[i]!.y, points[i + 1]!.x, points[i + 1]!.y, resolveNeeded(op.color, "color"), 1);
            }
          }
          break;
        }
        case "rect":
          changed += Draw.rect(surface, rectOf(op.rect, "rect"), resolve(op.color), resolve(op.fill));
          break;
        case "ellipse":
          changed += Draw.ellipse(surface, rectOf(op.rect, "rect"), resolve(op.color), resolve(op.fill));
          break;
        case "fill": {
          const at = pointOf(op.at, "at");
          changed += Draw.flood(surface, at.x, at.y, resolveNeeded(op.color, "color"), num(op.tolerance ?? 0, "tolerance"), op.contiguous !== false);
          break;
        }
        case "replace": {
          const from = resolveNeeded(op.from, "from");
          const to = resolveNeeded(op.to, "to");
          const r = op.region
            ? clampRegion(s, rectOf(op.region, "region"))
            : { x: cel.x, y: cel.y, width: img.width, height: img.height };
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const gx = x + cel.x;
              const gy = y + cel.y;
              if (gx >= r.x && gy >= r.y && gx < r.x + r.width && gy < r.y + r.height && img.pixels[y * img.width + x] === from) {
                changed += Draw.pixel(surface, gx, gy, to);
              }
            }
          }
          break;
        }
        case "dither": {
          const pattern = String(op.pattern ?? "bayer4");
          if (!(DITHER_PATTERNS as readonly string[]).includes(pattern)) {
            throw new ToolError("invalid_args", `Unknown dither pattern '${pattern}'.`);
          }
          changed += Draw.dither(
            surface,
            rectOf(op.rect, "rect"),
            resolveNeeded(op.colorA, "colorA"),
            resolveNeeded(op.colorB, "colorB"),
            pattern,
            num(op.ratio ?? 0.5, "ratio"),
          );
          break;
        }
        case "gradient":
          changed += gradient(surface, op, resolveColor);
          break;
        case "clear": {
          if (op.region || mask) {
            // Per pixel, so selectionOnly clips the erase like any other write.
            const r = op.region ? rectOf(op.region, "region") : { x: cel.x, y: cel.y, width: img.width, height: img.height };
            // Indexed sprites mark transparency with their own index, not 0.
            const clearValue = transparentPixel(s);
            for (let y = r.y; y < r.y + r.height; y++) {
              for (let x = r.x; x < r.x + r.width; x++) changed += Draw.pixel(surface, x, y, clearValue);
            }
          } else {
            img.pixels.fill(transparentPixel(s));
            changed += img.width * img.height;
          }
          break;
        }
        case "blit":
          changed += blit(studio, s, surface, op, layer, frame);
          break;
        default:
          throw new ToolError("unsupported_command", `Unknown draw op '${String(op.kind)}'.`);
      }
      touched = union(touched, opBounds(s, op));
    }

    cel.image = img;
  } catch (err) {
    if (!existing) layer.cels.delete(frame);
    else Object.assign(existing, before);
    throw err;
  }
  s.modified = true;

  return {
    sprite: displayName(s),
    layer: layer.name,
    frame,
    opsApplied: ops.length,
    pixelsChanged: changed,
    colorsSnapped: snapped,
    bounds: touched,
  };
}

function gradient(surface: Surface, op: Op, resolveColor: (c: Rgba) => number): number {
  const steps = op.steps === undefined || op.steps === null ? 4 : num(op.steps, "steps");
  if (!Number.isInteger(steps) || steps < 1) {
    throw new ToolError("invalid_args", "'steps' must be a positive integer.");
  }
  const [fr, fg, fb] = channels(hexToRgba(need(op.from, "from") as string));
  const [tr, tg, tb] = channels(hexToRgba(need(op.to, "to") as string));
  const r = rectOf(op.rect, "rect");
  const direction = String(op.direction ?? "vertical");
  const dither = Boolean(op.dither);

  // One colour per band, resolved once: resolve also reports palette snapping,
  // and doing it per pixel would flood that report.
  const band: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const mix = (a: number, b: number) => Math.floor(a + (b - a) * t + 0.5);
    band.push(resolveColor(rgba(mix(fr, tr), mix(fg, tg), mix(fb, tb), 255)));
  }

  const cx = r.x + (r.width - 1) / 2;
  const cy = r.y + (r.height - 1) / 2;
  // Centre to corner, so the outermost band lands on the rect's corners.
  const radius = Math.max(1, Math.sqrt((r.width / 2) ** 2 + (r.height / 2) ** 2));

  const position = (x: number, y: number): number => {
    if (direction === "horizontal") return r.width <= 1 ? 0 : (x - r.x) / (r.width - 1);
    if (direction === "diagonal") {
      const span = r.width - 1 + (r.height - 1);
      return span <= 0 ? 0 : (x - r.x + (y - r.y)) / span;
    }
    if (direction === "radial") return Math.min(1, Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius);
    return r.height <= 1 ? 0 : (y - r.y) / (r.height - 1);
  };

  let count = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const f = position(x, y) * (steps - 1);
      const lo = Math.max(0, Math.min(steps - 1, Math.floor(f)));
      let index = lo;
      if (dither && lo < steps - 1) {
        // Ordered dither across the band boundary: the fractional part is the
        // probability of taking the next band, thresholded by Bayer so the
        // texture is stable rather than noisy.
        if (f - lo > bayerThreshold("bayer4", x, y)) index = lo + 1;
      } else if (!dither) {
        index = Math.max(0, Math.min(steps - 1, Math.floor(f + 0.5)));
      }
      count += Draw.pixel(surface, x, y, band[index]!);
    }
  }
  return count;
}

function blit(
  studio: Studio,
  s: Sprite,
  surface: Surface,
  op: Op,
  layer: ReturnType<Studio["resolveLayer"]>,
  frame: number,
): number {
  const srcFrame = op.fromFrame !== undefined && op.fromFrame !== null ? studio.resolveFrame(s, op.fromFrame) : frame;
  const srcLayer = op.fromLayer ? studio.resolveLayer(s, op.fromLayer) : layer;
  const srcCel = srcLayer.cels.get(srcFrame);
  if (!srcCel) return 0;
  const r = rectOf(op.from, "from");
  const to = pointOf(op.to, "to");
  let count = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const sx = op.flipHorizontal ? r.x + r.width - 1 - x : r.x + x;
      const sy = op.flipVertical ? r.y + r.height - 1 - y : r.y + y;
      const lx = sx - srcCel.x;
      const ly = sy - srcCel.y;
      if (lx >= 0 && ly >= 0 && lx < srcCel.image.width && ly < srcCel.image.height) {
        const value = srcCel.image.pixels[ly * srcCel.image.width + lx]!;
        if (!(op.skipTransparent !== false && !isOpaque(s, value, srcLayer))) count += Draw.pixel(surface, to.x + x, to.y + y, value);
      }
    }
  }
  return count;
}

// ── select.apply ─────────────────────────────────────────────────────────

function selectApply(studio: Studio, args: Record<string, unknown>) {
  const s = studio.resolveSprite(args.sprite);
  const op = need(args.op, "op");

  if (op !== "get") {
    const size = s.width * s.height;
    const current = s.selection?.mask ?? new Uint8Array(size);
    let built = new Uint8Array(size);
    const fillRect = (x: number, y: number, w: number, h: number) => {
      for (let yy = Math.max(0, y); yy < Math.min(s.height, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(s.width, x + w); xx++) built[yy * s.width + xx] = 1;
      }
    };

    if (op === "none") {
      // built stays empty
    } else if (op === "all") {
      built.fill(1);
    } else if (op === "rect") {
      const r = clampRegion(s, need(args.rect, "rect") as Partial<Rect>);
      fillRect(r.x, r.y, r.width, r.height);
    } else if (op === "ellipse") {
      const r = clampRegion(s, need(args.rect, "rect") as Partial<Rect>);
      const cx = r.x + (r.width - 1) / 2;
      const cy = r.y + (r.height - 1) / 2;
      const rx = (r.width - 1) / 2;
      const ry = (r.height - 1) / 2;
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          const nx = (x - cx) / Math.max(rx, 0.5);
          const ny = (y - cy) / Math.max(ry, 0.5);
          if (nx * nx + ny * ny <= 1.0) built[y * s.width + x] = 1;
        }
      }
    } else if (op === "color") {
      const frame = studio.resolveFrame(s, args.frame);
      const flat = studio.composite(s, frame);
      const reference = hexToRgba(need(args.color, "color") as string);
      const wanted = rgbaToHex(reference, false);
      const tolerance = args.tolerance === undefined || args.tolerance === null ? 0 : num(args.tolerance, "tolerance");
      const contiguous = args.contiguous === true;
      // Without a tolerance this stays the exact-RGB, alpha-ignoring match it
      // always was; with one it is the very comparison fill uses.
      // The composite is always RGBA, so the sprite's own mode decides whether a
      // tolerance applies at all.
      const [rr, rg, rb] = channels(reference);
      const near = tolerance > 0 && s.colorMode === "rgb" ? Draw.colorMatcher("rgb", rgba(rr, rg, rb, 255), tolerance) : undefined;
      const matches = (c: number): boolean => (c & 255) !== 0 && (near ? near(c) : rgbaToHex(c, false) === wanted);

      if (!contiguous) {
        for (let i = 0; i < size; i++) if (matches(flat.pixels[i]!)) built[i] = 1;
      } else {
        if (args.x === undefined || args.y === undefined || args.x === null || args.y === null) {
          throw new ToolError(
            "invalid_args",
            "select op 'color' with contiguous needs a starting point: pass 'x' and 'y'.",
          );
        }
        const sx = num(args.x, "x");
        const sy = num(args.y, "y");
        if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) {
          throw new ToolError("invalid_args", `Starting point (${sx}, ${sy}) is outside the ${s.width}x${s.height} canvas.`);
        }
        // 4-neighbour, like fill.
        const stack = [sx, sy];
        const seen = new Uint8Array(size);
        while (stack.length > 0) {
          const y = stack.pop()!;
          const x = stack.pop()!;
          if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
          const key = y * s.width + x;
          if (seen[key]) continue;
          seen[key] = 1;
          if (!matches(flat.pixels[key]!)) continue;
          built[key] = 1;
          stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
        }
      }
    } else if (op === "invert") {
      for (let i = 0; i < size; i++) built[i] = current[i] === 0 ? 1 : 0;
    } else if (op === "grow" || op === "shrink") {
      if (selectionIsEmpty(s.selection)) {
        throw new ToolError("invalid_args", `Nothing is selected to ${op}.`);
      }
      const b = s.selection!.bounds;
      const n = args.amount === undefined || args.amount === null ? 1 : num(args.amount, "amount");
      const d = op === "grow" ? n : -n;
      fillRect(b.x - d, b.y - d, Math.max(1, b.width + 2 * d), Math.max(1, b.height + 2 * d));
    } else {
      throw new ToolError("unsupported_command", `select op '${String(op)}' is not supported.`);
    }

    const mode = String(args.mode ?? "replace");
    if (mode === "replace" || op === "none" || op === "all" || op === "invert") {
      // built is the selection
    } else if (mode === "add") {
      built = built.map((v, i) => (v !== 0 || current[i] !== 0 ? 1 : 0));
    } else if (mode === "subtract") {
      built = built.map((v, i) => (current[i] !== 0 && v === 0 ? 1 : 0));
    } else if (mode === "intersect") {
      built = built.map((v, i) => (v !== 0 && current[i] !== 0 ? 1 : 0));
    } else {
      throw new ToolError("invalid_args", `Unknown selection mode '${mode}'.`);
    }
    s.selection = selectionFromMask(s, built);
    s.modified = true;
  }

  const sel = s.selection;
  const empty = selectionIsEmpty(sel);
  let count = 0;
  if (!empty) for (const v of sel!.mask) if (v !== 0) count++;

  return {
    sprite: displayName(s),
    empty,
    bounds: empty ? undefined : { ...sel!.bounds },
    pixelCount: count,
  };
}

export const drawHandlers: HandlerTable = {
  "draw.batch": drawBatch,
  "select.apply": selectApply,
};
