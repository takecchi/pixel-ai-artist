import { Image, displayName, pixelToHex, rgbaToHex, type Layer, type Rect, type Sprite } from "../model.js";
import { clampRegion } from "../selection.js";
import type { HandlerTable, Studio } from "../studio.js";

/**
 * What a canvas pixel shows, as the extension's pixel_to_hex wrote it: null
 * where there is no paint, alpha only in an RGB sprite.
 */
type PixelSource = (x: number, y: number) => string | null;

function compositeSource(studio: Studio, sprite: Sprite, frame: number): PixelSource {
  const image = studio.composite(sprite, frame);
  return (x, y) => {
    const c = image.get(x, y);
    return (c & 255) === 0 ? null : rgbaToHex(c, sprite.colorMode === "rgb");
  };
}

/** One layer's cel at its position, ignoring layer and cel opacity, as drawImage onto an empty canvas did. */
function celSource(studio: Studio, sprite: Sprite, layer: Layer, frame: number): PixelSource {
  const cel = layer.cels.get(frame);
  // Read the cel itself: off the cel there is no paint, even where a Background would read its transparent index as colour.
  return (x, y) => {
    if (!cel || x < 0 || y < 0 || x >= sprite.width || y >= sprite.height || !cel.image.contains(x - cel.x, y - cel.y)) return null;
    return pixelToHex(sprite, cel.image.get(x - cel.x, y - cel.y), layer);
  };
}

/**
 * Distinct colours plus indices: `colors[0]` is always transparent, the rest
 * in the order a row-major scan first meets them.
 */
export function readRegion(sprite: Sprite, source: PixelSource, rect: Rect) {
  const colors = ["#00000000"];
  const lookup = new Map<string, number>();
  const grid: number[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const hex = source(x, y);
      if (hex === null) {
        grid.push(0);
        continue;
      }
      let index = lookup.get(hex);
      if (index === undefined) {
        index = colors.length;
        colors.push(hex);
        lookup.set(hex, index);
      }
      grid.push(index);
    }
  }
  return { sprite: displayName(sprite), ...rect, colors, grid };
}

function pixelsRead(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const frame = studio.resolveFrame(sprite, args.frame);
  const rect = clampRegion(sprite, args.region);
  const source =
    args.composite === false
      ? celSource(studio, sprite, studio.resolveLayer(sprite, args.layer), frame)
      : compositeSource(studio, sprite, frame);
  return readRegion(sprite, source, rect);
}

export const pixelHandlers: HandlerTable = {
  "pixels.read": pixelsRead,
};

export type { PixelSource };
