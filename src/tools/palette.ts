import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AsepriteLink } from "../bridge/link.js";
import { buildRamp, contrastRatio, parseHex, snapToPalette, toHex } from "../lib/color.js";
import { fail, hexColor, ok, targetShape } from "./kit.js";

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
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/tools/palette.js → package root
  const file = path.resolve(here, "..", "..", "knowledge", "palettes.json");
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

export function registerPaletteTools(server: McpServer, live: AsepriteLink): void {
  server.registerTool(
    "palette",
    {
      title: "Palette",
      description:
        "Read and shape the sprite's palette. Ops:\n" +
        "• 'get' — current palette with per-colour usage counts.\n" +
        "• 'set' — write specific indices, or replace the palette wholesale.\n" +
        "• 'preset' — load a bundled palette by key: ~2000 of them, the classics (pico8, gameboy, cga, nes…) and the most-downloaded on Lospec (sweetie-16, endesga-32, resurrect-64, aap-64…). An unknown key or a name answers with the matching keys, so 'preset: \"gameboy\"' or 'preset: \"endesga\"' is a search.\n" +
        "• 'load' — read a .gpl/.hex/.pal/.png palette file from disk.\n" +
        "• 'ramp' — generate a hue-shifted ramp from a base colour and append it. Shadows rotate toward blue, highlights toward orange; a ramp that only changes brightness is the clearest tell of machine-made pixel art.\n" +
        "• 'analyze' — report ramp structure, contrast, near-duplicate entries and colours used in the art that are not in the palette.\n" +
        "• 'extract' — replace the palette with one quantized from the art itself (RGB sprites only). Use to derive a curated palette from a reference image imported at full colour.\n" +
        "Decide the palette before drawing. Retro-fitting one onto finished art means repainting.",
      inputSchema: {
        op: z.enum(["get", "set", "preset", "load", "ramp", "analyze", "extract"]),
        sprite: targetShape.sprite,
        preset: z.string().optional().describe("Preset key for op 'preset'."),
        path: z.string().optional().describe("Palette file for op 'load'."),
        colors: z
          .array(hexColor)
          .optional()
          .describe("For op 'set': the colours to write."),
        startIndex: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("For op 'set': where `colors` starts. Ignored when `replace` is true."),
        replace: z
          .boolean()
          .default(false)
          .describe("For op 'set'/'preset': replace the whole palette instead of merging."),
        base: hexColor.optional().describe("Base colour for op 'ramp'."),
        steps: z.number().int().min(2).max(16).default(5).describe("Ramp length."),
        spread: z
          .number()
          .min(0.1)
          .max(1)
          .default(0.55)
          .describe("How far the ramp reaches into shadow and light."),
        remapArt: z
          .boolean()
          .default(false)
          .describe(
            "When replacing a palette, repaint existing pixels to the nearest new colour instead of leaving them off-palette.",
          ),
        maxColors: z
          .number()
          .int()
          .min(2)
          .max(256)
          .default(16)
          .describe("For op 'extract': target palette size."),
      },
      outputSchema: {
        op: z.string(),
        sprite: z.string().optional(),
        colors: z.array(z.string()).optional(),
        size: z.number().int().optional(),
        path: z.string().optional().describe("Palette file read by op 'load'."),
        usage: z
          .array(z.object({ index: z.number().int(), hex: z.string(), pixels: z.number().int() }))
          .optional(),
        ramp: z.array(z.string()).optional(),
        analysis: z
          .object({
            size: z.number().int(),
            unusedIndices: z.array(z.number().int()),
            nearDuplicates: z.array(
              z.object({ a: z.string(), b: z.string(), deltaE: z.number() }),
            ),
            offPaletteColors: z.array(z.object({ hex: z.string(), pixels: z.number().int() })),
            lowestContrastPair: z
              .object({ a: z.string(), b: z.string(), ratio: z.number() })
              .nullish(),
            verdict: z.string(),
          })
          .optional(),
        total: z.number().int().optional().describe("Op 'preset' with no such key: presets bundled."),
        matches: z
          .array(
            z.object({
              key: z.string(),
              name: z.string(),
              author: z.string(),
              size: z.number().int(),
              notes: z.string().optional(),
            }),
          )
          .optional()
          .describe("Op 'preset' with no such key: presets whose key, name, author or tags match it."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        switch (args.op) {
          case "ramp": {
            if (!args.base) return fail(new Error("op 'ramp' needs a `base` colour."));
            const ramp = buildRamp(parseHex(args.base), args.steps, args.spread);
            const data = await live.call<Record<string, unknown>>("palette.set", {
              sprite: args.sprite,
              colors: ramp,
              append: true,
            });
            return ok(
              { op: "ramp", ramp, ...data },
              `Appended a ${args.steps}-step hue-shifted ramp from ${args.base}: ${ramp.join(" ")}`,
            );
          }

          case "preset": {
            const query = (args.preset ?? "").trim();
            const table = presets();
            // Keys are Lospec-style slugs; "Sweetie 16" and "sweetie_16" mean sweetie-16. Lospec's
            // all-digit slugs ("32") are stored as lospec-32, so the bare number still finds them.
            const slug = query.toLowerCase().replace(/[\s_]+/g, "-");
            // Own keys only: "constructor" or "toString" would otherwise resolve on the prototype.
            const own = (key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);
            const chosen = own(slug) ?? own(`lospec-${slug}`);
            if (!chosen) {
              const matches = searchPresets(query);
              return ok(
                {
                  op: "preset",
                  total: Object.keys(table).length,
                  matches: matches.map(({ key, preset }) => ({
                    key,
                    name: preset.name,
                    author: preset.author,
                    size: preset.size,
                    ...(preset.notes ? { notes: preset.notes } : {}),
                  })),
                },
                matches.length > 0
                  ? `No preset with the key '${query}'. ${matches.length} match: ${matches.map(({ key, preset }) => `${key} (${preset.size})`).join(", ")}. Call again with one of these keys.`
                  : `No preset matches '${query}' among ${Object.keys(table).length}. Search by a word of the name or author (e.g. 'endesga', 'gameboy', 'nes'), or load a palette file with op 'load'.`,
              );
            }
            const data = await live.call<Record<string, unknown>>("palette.set", {
              sprite: args.sprite,
              colors: chosen.colors,
              replace: args.replace !== false,
              remapArt: args.remapArt,
            });
            return ok(
              { op: "preset", colors: chosen.colors, size: chosen.colors.length, ...data },
              `Loaded ${chosen.name} by ${chosen.author} (${chosen.colors.length} colours).${chosen.notes ? ` ${chosen.notes}` : ""}`,
            );
          }

          case "load": {
            if (!args.path) return fail(new Error("op 'load' needs a `path`."));
            const data = await live.call<Record<string, unknown>>("palette.load", {
              sprite: args.sprite,
              path: args.path,
              replace: args.replace,
              remapArt: args.remapArt,
            });
            return ok({ op: "load", ...data });
          }

          case "set": {
            if (!args.colors || args.colors.length === 0) {
              return fail(new Error("op 'set' needs at least one colour."));
            }
            const data = await live.call<Record<string, unknown>>("palette.set", {
              sprite: args.sprite,
              colors: args.colors,
              startIndex: args.startIndex,
              replace: args.replace,
              remapArt: args.remapArt,
            });
            return ok({ op: "set", ...data });
          }

          case "analyze": {
            const state = await live.call<{
              sprite: string;
              colors: string[];
              usage: { index: number; hex: string; pixels: number }[];
              offPalette: { hex: string; pixels: number }[];
            }>("palette.stats", { sprite: args.sprite });
            return ok(
              { op: "analyze", sprite: state.sprite, colors: state.colors, analysis: analyze(state) },
              describeAnalysis(analyze(state)),
            );
          }

          case "extract": {
            const data = await live.call<{ sprite: string; colors: string[] }>("palette.extract", {
              sprite: args.sprite,
              maxColors: args.maxColors,
            });
            return ok(
              { op: "extract", ...data },
              `Extracted a ${data.colors.length}-colour palette from the art: ${data.colors.join(" ")}`,
            );
          }

          default: {
            const data = await live.call<Record<string, unknown>>("palette.get", {
              sprite: args.sprite,
            });
            const colors = (data.colors as string[]) ?? [];
            return ok(
              { op: "get", ...data },
              `${colors.length} colours: ${colors.join(" ")}`,
            );
          }
        }
      } catch (err) {
        return fail(err);
      }
    },
  );
}

interface PaletteStats {
  sprite: string;
  colors: string[];
  usage: { index: number; hex: string; pixels: number }[];
  offPalette: { hex: string; pixels: number }[];
}

function analyze(state: PaletteStats) {
  const unusedIndices = state.usage.filter((u) => u.pixels === 0).map((u) => u.index);

  const nearDuplicates: { a: string; b: string; deltaE: number }[] = [];
  for (let i = 0; i < state.colors.length; i++) {
    const a = state.colors[i];
    if (!a) continue;
    // Only compare forward, and only against the rest of the palette.
    const rest = state.colors.slice(i + 1);
    if (rest.length === 0) continue;
    const snap = snapToPalette(parseHex(a), rest);
    if (snap.distance < 3) {
      nearDuplicates.push({ a, b: snap.hex, deltaE: round(snap.distance) });
    }
  }

  let lowestContrastPair: { a: string; b: string; ratio: number } | null = null;
  const used = state.usage.filter((u) => u.pixels > 0).slice(0, 32);
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = used[i]!;
      const b = used[j]!;
      const ratio = contrastRatio(parseHex(a.hex), parseHex(b.hex));
      if (!lowestContrastPair || ratio < lowestContrastPair.ratio) {
        lowestContrastPair = { a: a.hex, b: b.hex, ratio: round(ratio) };
      }
    }
  }

  const problems: string[] = [];
  if (state.offPalette.length > 0) {
    problems.push(`${state.offPalette.length} colour(s) in the art are not in the palette`);
  }
  if (nearDuplicates.length > 0) {
    problems.push(`${nearDuplicates.length} near-duplicate palette entr(ies) (ΔE < 3)`);
  }
  if (state.colors.length > 64) {
    problems.push(`${state.colors.length} colours is large for pixel art; most sprites read better under 32`);
  }

  return {
    size: state.colors.length,
    unusedIndices,
    nearDuplicates,
    offPaletteColors: state.offPalette,
    lowestContrastPair,
    verdict: problems.length === 0 ? "clean" : problems.join("; "),
  };
}

function describeAnalysis(a: ReturnType<typeof analyze>): string {
  const lines = [`Palette: ${a.size} colours — ${a.verdict}.`];
  if (a.offPaletteColors.length > 0) {
    lines.push(
      `Off-palette: ${a.offPaletteColors
        .slice(0, 8)
        .map((c) => `${c.hex} (${c.pixels}px)`)
        .join(", ")}. Use recolor op 'snap' to bring them in line.`,
    );
  }
  if (a.nearDuplicates.length > 0) {
    lines.push(
      `Near-duplicates: ${a.nearDuplicates.slice(0, 5).map((d) => `${d.a}≈${d.b}`).join(", ")}. Merging them makes ramps read more clearly.`,
    );
  }
  if (a.unusedIndices.length > 0) lines.push(`${a.unusedIndices.length} palette slot(s) unused.`);
  return lines.join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
