import { readFileSync } from "node:fs";
import path from "node:path";
import { decodePaletteFile } from "../../lib/palette-file.js";
import { ToolError, need } from "../errors.js";
import {
  channels,
  displayName,
  hexToRgba,
  pixelToRgba,
  rgba,
  rgbaToHex,
  rgbaToPixel,
  snapToPalette,
  type Rgba,
  type Sprite,
} from "../model.js";
import { paletteStats } from "../stats.js";
import type { HandlerTable, Studio } from "../studio.js";

function hexes(sprite: Sprite): string[] {
  return sprite.palette.map((c) => rgbaToHex(c, true));
}

function answer(sprite: Sprite) {
  const colors = hexes(sprite);
  return { sprite: displayName(sprite), colors, size: colors.length };
}

function paletteGet(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  return { ...answer(sprite), usage: paletteStats(sprite).usage };
}

/** Repaints every cel with each colour's perceptually nearest entry of the new palette, keeping alpha. */
function remapArt(sprite: Sprite): void {
  for (const layer of sprite.layers) {
    for (const cel of layer.cels.values()) {
      const cache = new Map<number, number>();
      const img = cel.image.clone();
      img.pixels.forEach((value, i) => {
        const c = pixelToRgba(sprite, value, layer);
        if ((c & 255) === 0) return;
        let mapped = cache.get(value);
        if (mapped === undefined) {
          mapped = rgbaToPixel(sprite, snapToPalette(sprite, c).color);
          cache.set(value, mapped);
        }
        img.pixels[i] = mapped;
      });
      cel.image = img;
    }
  }
}

function paletteSet(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const raw = need(args.colors, "colors");
  if (!Array.isArray(raw)) throw new ToolError("invalid_args", "colors must be an array of #rrggbb strings.");
  const colors = raw.map((hex) => hexToRgba(hex as string));
  if (args.remapArt === true && sprite.colorMode === "indexed") {
    throw new ToolError(
      "invalid_args",
      "remapArt repaints rgb and grayscale art; an indexed sprite's pixels already follow its palette.",
    );
  }

  let next: Rgba[];
  if (args.replace === true) {
    next = colors;
  } else if (args.append === true) {
    next = [...sprite.palette, ...colors];
  } else {
    const start = args.startIndex === undefined ? 0 : Number(args.startIndex);
    if (!(Number.isInteger(start) && start >= 0)) {
      throw new ToolError("invalid_args", `startIndex must be a whole number, got ${String(args.startIndex)}.`);
    }
    next = [...sprite.palette];
    // Entries opened up between the old end and startIndex are black, as a resized Aseprite palette's are.
    while (next.length < start) next.push(rgba(0, 0, 0));
    next.splice(start, colors.length, ...colors);
  }

  sprite.palette = next;
  if (args.remapArt === true) remapArt(sprite);
  sprite.modified = true;
  return answer(sprite);
}

function paletteStatsHandler(studio: Studio, args: Record<string, unknown>) {
  return paletteStats(studio.resolveSprite(args.sprite));
}

interface Bucket {
  colors: { rgb: [number, number, number]; count: number }[];
}

function widest(bucket: Bucket): { channel: 0 | 1 | 2; range: number } {
  let best: { channel: 0 | 1 | 2; range: number } = { channel: 0, range: -1 };
  for (const channel of [0, 1, 2] as const) {
    const values = bucket.colors.map((c) => c.rgb[channel]);
    const range = Math.max(...values) - Math.min(...values);
    if (range > best.range) best = { channel, range };
  }
  return best;
}

/**
 * Cut-based quantisation: the bucket with the widest channel is split at the
 * middle of that channel's range until there are `max` buckets or none can
 * split. Each bucket becomes the mean of its colours weighted by pixel count.
 */
function medianCut(counts: Map<number, number>, max: number): { color: Rgba; count: number }[] {
  const buckets: Bucket[] = [
    { colors: [...counts].map(([c, count]) => ({ rgb: channels(c).slice(0, 3) as [number, number, number], count })) },
  ];
  while (buckets.length < max) {
    let pick = -1;
    let pickRange = 0;
    buckets.forEach((b, i) => {
      if (b.colors.length < 2) return;
      const { range } = widest(b);
      if (range > pickRange) [pick, pickRange] = [i, range];
    });
    if (pick < 0) break;
    const bucket = buckets[pick]!;
    const { channel, range } = widest(bucket);
    const middle = Math.min(...bucket.colors.map((c) => c.rgb[channel])) + range / 2;
    buckets.splice(
      pick,
      1,
      { colors: bucket.colors.filter((c) => c.rgb[channel] <= middle) },
      { colors: bucket.colors.filter((c) => c.rgb[channel] > middle) },
    );
  }
  return buckets.map((b) => {
    const count = b.colors.reduce((sum, c) => sum + c.count, 0);
    const mean = (ch: 0 | 1 | 2) => Math.round(b.colors.reduce((sum, c) => sum + c.rgb[ch] * c.count, 0) / count);
    return { color: rgba(mean(0), mean(1), mean(2)), count };
  });
}

function paletteExtract(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  if (sprite.colorMode !== "rgb") throw new ToolError("invalid_args", "palette op 'extract' only works on RGB sprites.");
  const max = args.maxColors === undefined ? 16 : Number(args.maxColors);
  if (!(Number.isInteger(max) && max >= 2 && max <= 256)) {
    throw new ToolError("invalid_args", "maxColors must be between 2 and 256.");
  }

  // Alpha is left out, as ColorQuantization{withAlpha=false} leaves it out.
  const counts = new Map<number, number>();
  for (const layer of sprite.layers) {
    for (const cel of layer.cels.values()) {
      for (const value of cel.image.pixels) {
        if ((value & 255) === 0) continue;
        const opaque = ((value & 0xffffff00) | 255) >>> 0;
        counts.set(opaque, (counts.get(opaque) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) throw new ToolError("invalid_args", "The sprite has no painted pixels to take colours from.");

  sprite.palette = medianCut(counts, max)
    .sort((a, b) => b.count - a.count)
    .map((b) => b.color);
  sprite.modified = true;
  return { sprite: displayName(sprite), colors: hexes(sprite) };
}

function paletteLoad(studio: Studio, args: Record<string, unknown>) {
  const s = studio.resolveSprite(args.sprite);
  const file = need(args.path, "path");
  if (typeof file !== "string") throw new ToolError("invalid_args", "path must be a string.");
  const full = path.resolve(file);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(full);
  } catch (err) {
    throw new ToolError("io_error", `Cannot read '${file}': ${(err as Error).message}`, { path: full });
  }
  if (args.remapArt === true && s.colorMode === "indexed") {
    throw new ToolError(
      "invalid_args",
      "remapArt repaints rgb and grayscale art; an indexed sprite's pixels already follow its palette.",
    );
  }
  const colors = decodePaletteFile(bytes, path.extname(full));
  if (colors.length === 0) {
    throw new ToolError("io_error", `Could not read a palette from '${file}'.`, { path: full });
  }

  s.palette = args.replace === false ? [...s.palette, ...colors] : colors;
  if (args.remapArt === true) remapArt(s);
  s.modified = true;
  return { ...answer(s), path: file };
}

export const paletteHandlers: HandlerTable = {
  "palette.get": paletteGet,
  "palette.set": paletteSet,
  "palette.load": paletteLoad,
  "palette.stats": paletteStatsHandler,
  "palette.extract": paletteExtract,
};
