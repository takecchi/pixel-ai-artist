import { hslToRgb, hueShiftShade, rgbToHsl } from "../../lib/color.js";
import { ToolError, need } from "../errors.js";
import {
  channels,
  displayName,
  hexToRgba,
  pixelToHex,
  rgba,
  rgbaToHex,
  rgbaToPixel,
  snapToPalette,
  type Rect,
  type Rgba,
  type Sprite,
} from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

/** The extension's clamp_region. */
function clampRegion(sprite: Sprite, region: Record<string, unknown>): Rect {
  const x = Math.max(0, Math.floor(Number(region.x ?? 0)));
  const y = Math.max(0, Math.floor(Number(region.y ?? 0)));
  const w = Math.min(Math.floor(Number(region.width ?? sprite.width - x)), sprite.width - x);
  const h = Math.min(Math.floor(Number(region.height ?? sprite.height - y)), sprite.height - y);
  if (w <= 0 || h <= 0) {
    throw new ToolError("invalid_args", `Region is empty after clamping to the ${sprite.width}x${sprite.height} canvas.`);
  }
  return { x, y, width: w, height: h };
}

function toRgb(c: Rgba) {
  const [r, g, b, a] = channels(c);
  return { r, g, b, a };
}

function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  const { r, g, b } = hslToRgb({ h, s, l });
  return rgba(r, g, b, a);
}

function recolorApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const layer = studio.resolveLayer(sprite, args.layer);
  const frame = studio.resolveFrame(sprite, args.frame);
  const op = need(args.op, "op") as string;

  const cel = layer.cels.get(frame);
  if (!cel) throw new ToolError("invalid_args", `No cel on '${layer.name}' frame ${frame}.`);

  const selection = args.selectionOnly ? sprite.selection : null;
  if (args.selectionOnly && (!selection || selection.bounds.width <= 0 || selection.bounds.height <= 0)) {
    throw new ToolError(
      "invalid_args",
      "selectionOnly was set but nothing is selected. Recolouring the whole cel instead would " +
        "change far more than you asked for, so this refuses. Select a region first, or pass a " +
        "`region`, or drop selectionOnly.",
    );
  }
  const region = args.region ? clampRegion(sprite, args.region as Record<string, unknown>) : null;

  const img = cel.image;
  const inScope = (gx: number, gy: number) => {
    if (region && (gx < region.x || gy < region.y || gx >= region.x + region.width || gy >= region.y + region.height)) {
      return false;
    }
    if (selection && !(gx >= 0 && gy >= 0 && gx < sprite.width && gy < sprite.height && selection.mask[gy * sprite.width + gx])) {
      return false;
    }
    return true;
  };

  // Map over distinct colours, not pixels: a 64x64 recolour becomes a handful
  // of colour decisions plus one pass, instead of four thousand decisions.
  const counts = new Map<string, number>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!inScope(x + cel.x, y + cel.y)) continue;
      const hex = pixelToHex(sprite, img.get(x, y));
      if (hex !== null) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }

  const mapping = new Map<string, Rgba>();
  for (const hex of counts.keys()) {
    const color = hexToRgba(hex);
    const [, , , alpha] = channels(color);
    let result: Rgba;
    if (op === "shade") {
      result = rgba(...rgbParts(hueShiftShade(toRgb(color), { amount: (args.amount as number | undefined) ?? -0.2 })));
    } else if (op === "snap") {
      result = snapToPalette(sprite, color).color;
    } else if (op === "replace") {
      result =
        hex.slice(0, 7) === rgbaToHex(hexToRgba(need(args.from, "from") as string), false)
          ? hexToRgba(need(args.to, "to") as string)
          : color;
    } else if (op === "hue_shift") {
      const { h, s, l } = rgbToHsl(toRgb(color));
      result = fromHsl(h + ((args.degrees as number | undefined) ?? 30), s, l, alpha);
    } else if (op === "desaturate") {
      const { h, s, l } = rgbToHsl(toRgb(color));
      result = fromHsl(h, s * (1 - ((args.strength as number | undefined) ?? 1)), l, alpha);
    } else {
      throw new ToolError("unsupported_command", `recolor op '${String(op)}' is not supported.`);
    }

    if (args.clampToPalette !== false && op !== "snap" && sprite.colorMode !== "indexed") {
      result = snapToPalette(sprite, result).color;
    }
    mapping.set(hex, result);
  }

  let changed = 0;
  const out = img.clone();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!inScope(x + cel.x, y + cel.y)) continue;
      const hex = pixelToHex(sprite, img.get(x, y));
      const to = hex === null ? undefined : mapping.get(hex);
      if (to === undefined) continue;
      const value = rgbaToPixel(sprite, to);
      if (value !== img.get(x, y)) {
        out.set(x, y, value);
        changed++;
      }
    }
  }
  cel.image = out;
  sprite.modified = true;

  const report: { from: string; to: string; pixels: number }[] = [];
  for (const [hex, n] of counts) {
    const to = rgbaToHex(mapping.get(hex)!, false);
    if (to !== hex.slice(0, 7)) report.push({ from: hex.slice(0, 7), to, pixels: n });
  }

  return { sprite: displayName(sprite), op, pixelsChanged: changed, mapping: report };
}

function rgbParts(c: { r: number; g: number; b: number; a: number }): [number, number, number, number] {
  return [c.r, c.g, c.b, c.a];
}

export const recolorHandlers: HandlerTable = {
  "recolor.apply": recolorApply,
};
