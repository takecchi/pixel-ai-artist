/**
 * Selections and regions. A selection is a canvas-sized mask plus the tight
 * bounds of what is set; an empty one is `null`, as sprite.info reports it.
 */

import { ToolError } from "./errors.js";
import type { Rect, Selection, Sprite } from "./model.js";

/** The extension's clamp_region: what a rect means for ops that must stay on the canvas. */
export function clampRegion(sprite: Sprite, region: Partial<Rect> | undefined): Rect {
  const r = region ?? {};
  const x = Math.max(0, Math.floor(r.x ?? 0));
  const y = Math.max(0, Math.floor(r.y ?? 0));
  const w = Math.min(Math.floor(r.width ?? sprite.width - x), sprite.width - x);
  const h = Math.min(Math.floor(r.height ?? sprite.height - y), sprite.height - y);
  if (w <= 0 || h <= 0) {
    throw new ToolError("invalid_args", `Region is empty after clamping to the ${sprite.width}x${sprite.height} canvas.`);
  }
  return { x, y, width: w, height: h };
}

/** The selection a mask makes: tight bounds, or null when nothing is set. */
export function selectionFromMask(sprite: Sprite, mask: Uint8Array): Selection | null {
  let x0 = sprite.width;
  let y0 = sprite.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++) {
      if (mask[y * sprite.width + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { mask, bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
}

export function selectionIsEmpty(sel: Selection | null | undefined): boolean {
  return !sel || sel.bounds.width <= 0 || sel.bounds.height <= 0;
}
