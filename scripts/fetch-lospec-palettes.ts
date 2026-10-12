/**
 * Refreshes the Lospec part of knowledge/palettes.json: the most-downloaded palettes on
 * https://lospec.com/palette-list, each with its author and source URL. Hand-written presets
 * (the ones without a `source`) are kept as they are and always come first.
 *
 *     node --experimental-strip-types scripts/fetch-lospec-palettes.ts [count=2000]
 *
 * See docs/PALETTES.md. The file is written one preset per line so a refresh diffs per palette.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Preset {
  name: string;
  author: string;
  size: number;
  notes: string;
  colors: string[];
  source?: string;
  tags?: string[];
}

interface LospecPalette {
  slug: string;
  title: string;
  description?: string;
  colors: string[];
  tags?: string[];
  user?: { name?: string } | null;
}

const FILE = path.resolve(import.meta.dirname, "..", "knowledge", "palettes.json");
const wanted = Number(process.argv[2] ?? 2000);

/** Lospec slugs never bundled, e.g. at the author's request (docs/PALETTES.md). */
const EXCLUDED = new Set<string>([]);

const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Descriptions are HTML; titles are plain text that may contain `<`, so only these lose tags. */
function notes(html: string): string {
  const text = decode(html.replace(/<[^>]+>/g, " "));
  return text.length > 280 ? `${text.slice(0, 277).replace(/\s+\S*$/, "")}…` : text;
}

const current = JSON.parse(readFileSync(FILE, "utf8")) as { $comment: string; presets: Record<string, Preset> };
const out: Record<string, Preset> = {};
for (const [key, preset] of Object.entries(current.presets)) if (!preset.source) out[key] = preset;
const seen = new Set(Object.values(out).map((preset) => preset.colors.join()));

let added = 0;
for (let page = 0; added < wanted; page++) {
  const url = `https://lospec.com/palette-list/load?colorNumberFilterType=any&colorNumber=8&page=${page}&tag=&sortingType=downloads`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const { palettes } = (await response.json()) as { palettes?: LospecPalette[] };
  if (!palettes?.length) break;
  for (const palette of palettes) {
    if (added >= wanted) break;
    const colors = palette.colors.map((color) => `#${color.toLowerCase()}`);
    const slug = palette.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    // A key that is all digits ("31") is an array index to JavaScript: object order puts it
    // before every other key, which would jump it ahead of the classics everywhere.
    const key = /^\d+$/.test(slug) ? `lospec-${slug}` : slug;
    // A palette identical to one already bundled (the hand-written classics) is not repeated.
    if (!key || out[key] || EXCLUDED.has(palette.slug) || seen.has(colors.join())) continue;
    if (colors.length === 0 || colors.length > 256 || colors.some((c) => !/^#[0-9a-f]{6}$/.test(c))) continue;
    seen.add(colors.join());
    out[key] = {
      name: decode(palette.title) || key,
      author: palette.user?.name?.trim() || "Unknown",
      size: colors.length,
      notes: notes(palette.description ?? ""),
      colors,
      source: `https://lospec.com/palette-list/${palette.slug}`,
      tags: [...new Set(palette.tags ?? [])].filter((tag) => tag && tag.length < 32).slice(0, 8),
    };
    added++;
  }
}

const lines = Object.entries(out).map(([key, preset]) => `    ${JSON.stringify(key)}: ${JSON.stringify(preset)}`);
writeFileSync(FILE, `{\n  "$comment": ${JSON.stringify(current.$comment)},\n  "presets": {\n${lines.join(",\n")}\n  }\n}\n`);
console.log(`${Object.keys(out).length} presets (${added} from Lospec) → ${path.relative(process.cwd(), FILE)}`);
