import { ToolError, need } from "../errors.js";
import {
  Image,
  displayName,
  hexToRgba,
  isOpaque,
  rgbaToPixel,
  type Cel,
  type Rect,
  type Sprite,
} from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

const FOUR: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const EIGHT: readonly (readonly [number, number])[] = [...FOUR, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Aseprite's Sprite > Trim (the AutocropSprite command), which is not the same
 * as trimming to the opaque pixels: per frame it flattens the visible layers
 * and picks a reference colour from the borders — the top-left pixel, unless a
 * transparent pixel sits on a checked edge, or the bottom border is the solid
 * one — and keeps everything that differs from it. The frames' bounds are
 * unioned. Where no frame gives a usable reference colour, nothing is trimmed.
 */
function trimmedBounds(studio: Studio, sprite: Sprite): Rect | null {
  let bounds: Rect | null = null;
  for (let frame = 1; frame <= sprite.frames.length; frame++) {
    const flat = studio.composite(sprite, frame);
    const ref = refColorForTrimming(flat);
    if (ref === null) continue;
    let x0 = flat.width, y0 = flat.height, x1 = -1, y1 = -1;
    for (let y = 0; y < flat.height; y++) {
      for (let x = 0; x < flat.width; x++) {
        if (flat.pixels[y * flat.width + x] === ref) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) continue;
    const found = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    bounds = bounds ? union(bounds, found) : found;
  }
  return bounds;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Aseprite's get_best_refcolor_for_trimming; null where it gives up (two different solid borders). */
function refColorForTrimming(image: Image): number | null {
  const w = image.width;
  const h = image.height;
  const probe1 = image.get(0, 0);
  const probe2 = image.get(w - 1, h - 1);
  let ref = probe1;

  /** Returns false when a transparent pixel ended the scan, with `ref` set to transparent. */
  const analyze = (topBottom: boolean): { ok: boolean; solid1: boolean; solid2: boolean } => {
    let solid1 = true;
    let solid2 = true;
    if (probe1 === 0 || probe2 === 0) {
      ref = 0;
      return { ok: false, solid1, solid2 };
    }
    const n = topBottom ? w : h;
    for (let i = 0; i < n; i++) {
      const c = topBottom ? image.get(i, 0) : image.get(0, i);
      if (c !== probe1) {
        solid1 = false;
        if (c === 0) {
          ref = 0;
          return { ok: false, solid1, solid2 };
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const c = topBottom ? image.get(i, h - 1) : image.get(w - 1, i);
      if (c !== probe2) {
        solid2 = false;
        if (c === 0) {
          ref = 0;
          return { ok: false, solid1, solid2 };
        }
      }
    }
    return { ok: true, solid1, solid2 };
  };

  for (const topBottom of [true, false]) {
    const r = analyze(topBottom);
    if (!r.ok) return ref;
    if (!r.solid1 && r.solid2) ref = probe2;
    else if (r.solid1 && r.solid2 && probe1 !== probe2) return null;
  }
  return ref;
}

/**
 * Resizes the canvas to `bounds`. As Aseprite's cropSprite does without
 * trimOutside, cels only move: their images keep pixels that now lie off the canvas.
 * The selection is cut to the new canvas along with it.
 */
function cropCanvas(sprite: Sprite, bounds: Rect): void {
  for (const layer of sprite.layers) {
    for (const cel of layer.cels.values()) {
      cel.x -= bounds.x;
      cel.y -= bounds.y;
    }
  }
  const sel = sprite.selection;
  if (sel) {
    const mask = new Uint8Array(bounds.width * bounds.height);
    let x0 = bounds.width, y0 = bounds.height, x1 = -1, y1 = -1;
    for (let y = 0; y < bounds.height; y++) {
      for (let x = 0; x < bounds.width; x++) {
        if (!sel.mask[(y + bounds.y) * sprite.width + x + bounds.x]) continue;
        mask[y * bounds.width + x] = 1;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    sprite.selection = x1 < 0 ? null : { mask, bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
  }
  sprite.width = bounds.width;
  sprite.height = bounds.height;
}

function celBounds(cel: Cel) {
  return { x: cel.x, y: cel.y, width: cel.image.width, height: cel.image.height };
}

function transformApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const op = need(args.op, "op") as string;
  const layer = studio.resolveLayer(sprite, args.layer);
  const frame = studio.resolveFrame(sprite, args.frame);
  let changed = 0;

  const done = () => {
    const cel = layer.cels.get(frame);
    return { sprite: displayName(sprite), op, pixelsChanged: changed, bounds: cel ? celBounds(cel) : undefined };
  };

  if (op === "crop_to_content") {
    const before = sprite.width * sprite.height;
    const bounds = trimmedBounds(studio, sprite);
    if (bounds && (bounds.width !== sprite.width || bounds.height !== sprite.height || bounds.x !== 0 || bounds.y !== 0)) {
      cropCanvas(sprite, bounds);
      sprite.modified = true;
    }
    changed = before - sprite.width * sprite.height;
    return done();
  }

  const cel = layer.cels.get(frame);
  if (!cel) throw new ToolError("invalid_args", `No cel on '${layer.name}' frame ${frame}.`);

  if (op === "translate") {
    cel.x += Number(args.dx ?? 0);
    cel.y += Number(args.dy ?? 0);
    changed = cel.image.width * cel.image.height;
    sprite.modified = true;
    return done();
  }

  const img = cel.image;
  const w = img.width;
  const h = img.height;
  const out = new Image(w, h);

  if (op === "flip") {
    const horizontal = (args.axis ?? "horizontal") === "horizontal";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out.set(x, y, img.get(horizontal ? w - 1 - x : x, horizontal ? y : h - 1 - y));
      }
    }
    changed = w * h;
    cel.image = out;
  } else if (op === "rotate") {
    const angle = ((((args.angle as number | undefined) ?? 90) % 360) + 360) % 360;
    if (angle === 180) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) out.set(x, y, img.get(w - 1 - x, h - 1 - y));
      }
      cel.image = out;
      changed = w * h;
    } else if (angle === 90 || angle === 270) {
      const rot = new Image(h, w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (angle === 90) rot.set(h - 1 - y, x, img.get(x, y));
          else rot.set(y, w - 1 - x, img.get(x, y));
        }
      }
      cel.image = rot;
      changed = w * h;
    } else if (angle !== 0) {
      throw new ToolError(
        "invalid_args",
        "Only 90/180/270 rotations are lossless. " +
          "The server should have blocked this; pass allowLossy there if the user accepted the quality loss.",
      );
    }
    // angle 0 leaves changed at 0: reporting a full-canvas change for an
    // operation that touched nothing breaks any agent using pixelsChanged to
    // check whether its call did anything.
  } else if (op === "scale") {
    const f = (args.factor as number | undefined) ?? 2;
    const scaled = new Image(w * f, h * f);
    for (let y = 0; y < scaled.height; y++) {
      for (let x = 0; x < scaled.width; x++) scaled.set(x, y, img.get(Math.floor(x / f), Math.floor(y / f)));
    }
    cel.image = scaled;
    changed = scaled.width * scaled.height;
  } else if (op === "outline") {
    const value = rgbaToPixel(sprite, hexToRgba(need(args.color, "color") as string));
    const side = (args.side as string | undefined) ?? "outside";
    if (side !== "outside" && side !== "inside") {
      throw new ToolError("invalid_args", "transform op 'outline' side must be 'outside' or 'inside'.");
    }
    const neighbors = args.diagonals ? EIGHT : FOUR;

    const n = Number(args.thickness ?? 1);
    if (!Number.isInteger(n) || n < 1) {
      throw new ToolError("invalid_args", "transform op 'outline' thickness must be a positive integer.");
    }

    // Steps from the nearest source pixel, up to n; 0 for a source, -1 beyond n.
    const distances = (gw: number, gh: number, isSource: (x: number, y: number) => boolean) => {
      const dist = new Int32Array(gw * gh).fill(-1);
      let frontier: number[] = [];
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          if (!isSource(x, y)) continue;
          dist[y * gw + x] = 0;
          frontier.push(y * gw + x);
        }
      }
      for (let step = 1; step <= n; step++) {
        const next: number[] = [];
        for (const at of frontier) {
          const x = at % gw;
          const y = (at - x) / gw;
          for (const [dx, dy] of neighbors) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || dist[ny * gw + nx] !== -1) continue;
            dist[ny * gw + nx] = step;
            next.push(ny * gw + nx);
          }
        }
        frontier = next;
      }
      return dist;
    };

    if (side === "inside") {
      // Recolour opaque pixels within n steps of transparency. The image's
      // outside counts as transparent, so the grid carries a one-pixel
      // transparent ring: that is enough, as the ring's own reach is what
      // every deeper pixel would measure against. Same size in, same size
      // out — unlike 'outside' this never grows the cel.
      const result = img.clone();
      const gw = w + 2;
      const dist = distances(gw, h + 2, (x, y) => !img.contains(x - 1, y - 1) || !isOpaque(sprite, img.get(x - 1, y - 1)));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = dist[(y + 1) * gw + x + 1]!;
          if (d < 1) continue;
          result.set(x, y, value);
          changed++;
        }
      }
      cel.image = result;
    } else {
      // Paint transparent pixels within n steps of opaque ones, on a canvas
      // grown by n pixels each way.
      const grown = studio.newImage(sprite, w + 2 * n, h + 2 * n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) grown.set(x + n, y + n, img.get(x, y));
      }
      const result = grown.clone();
      const dist = distances(grown.width, grown.height, (x, y) => isOpaque(sprite, grown.get(x, y)));
      for (let y = 0; y < grown.height; y++) {
        for (let x = 0; x < grown.width; x++) {
          if (dist[y * grown.width + x]! < 1) continue;
          result.set(x, y, value);
          changed++;
        }
      }
      cel.image = result;
      cel.x -= n;
      cel.y -= n;
    }
  } else {
    throw new ToolError("unsupported_command", `transform op '${String(op)}' is not supported.`);
  }

  sprite.modified = true;
  return done();
}

export const transformHandlers: HandlerTable = {
  "transform.apply": transformApply,
};
