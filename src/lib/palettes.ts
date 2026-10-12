import { readFileSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./version.js";

export interface Preset {
  name: string;
  author: string;
  size: number;
  notes: string;
  colors: string[];
  /** Where the palette is published (Lospec for most of the catalogue). */
  source?: string;
  tags?: string[];
}

let presetCache: Record<string, Preset> | null = null;

export function presets(): Record<string, Preset> {
  if (presetCache) return presetCache;
  const file = path.join(packageRoot(), "knowledge", "palettes.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { presets: Record<string, Preset> };
  presetCache = parsed.presets;
  return presetCache;
}

/**
 * The catalogue holds ~2000 palettes, so an unknown key cannot answer with the whole list. Every
 * word of the query must appear in the key, name, author or tags; smaller palettes rank first
 * among equals because a pixel-art request usually wants a tight one.
 */
export function searchPresets(query: string, limit = 20): { key: string; preset: Preset }[] {
  const words = query.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return [];
  return Object.entries(presets())
    .map(([key, preset]) => {
      const haystack = [key, preset.name, preset.author, ...(preset.tags ?? [])].join(" ").toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return null;
      const exactName = preset.name.toLowerCase() === query.toLowerCase().trim();
      return { key, preset, rank: exactName ? 0 : key.startsWith(words[0]!) ? 1 : 2 };
    })
    .filter((hit): hit is { key: string; preset: Preset; rank: number } => hit !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ key, preset }) => ({ key, preset }));
}
