import { displayName, pixelToHex, rgbaToHex, type Sprite } from "./model.js";

export interface PaletteStats {
  sprite: string;
  colors: string[];
  usage: { index: number; hex: string; pixels: number }[];
  offPalette: { hex: string; pixels: number }[];
}

/**
 * The extension's palette.stats. Palette entries are compared by their #rrggbb
 * part only, and every cel counts — hidden layers included, since the
 * palette is a property of the document and not of what is showing.
 * `validate` reads this directly instead of calling the command.
 */
export function paletteStats(sprite: Sprite): PaletteStats {
  const colors = sprite.palette.map((c) => rgbaToHex(c, true));
  const inPalette = new Set(colors.map((hex) => hex.slice(0, 7)));

  // A Map keeps first-seen order, which is what the stable sort below ties on.
  const counts = new Map<string, number>();
  for (const layer of sprite.layers) {
    for (const cel of layer.cels.values()) {
      for (const value of cel.image.pixels) {
        const hex = pixelToHex(sprite, value, layer);
        if (hex === null) continue;
        const key = hex.slice(0, 7);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  const usage = colors.map((hex, i) => ({ index: i, hex, pixels: counts.get(hex.slice(0, 7)) ?? 0 }));
  const offPalette = [...counts]
    .filter(([hex]) => !inPalette.has(hex))
    .map(([hex, pixels]) => ({ hex, pixels }))
    .sort((a, b) => b.pixels - a.pixels);

  return { sprite: displayName(sprite), colors, usage, offPalette };
}
