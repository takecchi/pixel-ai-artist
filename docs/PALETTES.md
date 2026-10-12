# Palettes

`knowledge/palettes.json` is the catalogue `palette` op `preset` loads from — about
2000 palettes — and the one the site's knowledge base shows at `/knowledge/palettes`.

## What is in it

- **Hand-written classics** (`pico8`, `gameboy`, `gameboy-pocket`, `cga`, `1bit`,
  `grayscale-8`). Transcribed from each palette's published definition, with notes on
  when each fits. They have no `source` field, come first, and a refresh never touches
  them.
- **Lospec's most-downloaded palettes**, from
  [lospec.com/palette-list](https://lospec.com/palette-list) sorted by downloads. Each
  keeps its author, its Lospec URL in `source`, its tags and a shortened description in
  `notes`. Palettes identical to a hand-written one are skipped.

Keys are slugs (`endesga-32`, `resurrect-64`): what an agent types and what the site puts
in a URL. A key that does not exist is a search — `preset: "endesga"` answers with every
palette whose key, name, author or tags contain the words — so an agent never needs the
whole list in its context. The `knowledge://palettes` resource still serves the full file
(about 1 MB) for clients that want it.

## Licence and credit

Lospec palettes are published by their authors for anyone to use; the catalogue keeps each
author's name and a link back, and the site shows both. If an author asks for a palette to
be removed, add its Lospec slug to `EXCLUDED` in `scripts/fetch-lospec-palettes.ts` and
refresh, so it does not come back with the next ranking.

## Refreshing

```bash
node --experimental-strip-types scripts/fetch-lospec-palettes.ts [count=2000]
pnpm run build && node --test --experimental-strip-types tests/palettes.test.ts
```

The script rewrites the Lospec part from the current download ranking. The file is written
one preset per line, so a refresh reads as a per-palette diff. `tests/palettes.test.ts`
holds every preset to the shape the tool needs: a slug key, a name, 1–256 `#rrggbb`
colours and a `size` that matches.

## Adding one by hand

Add a line without `source` to `presets` — `name`, `author`, `size`, `notes` (when it
fits, in one sentence) and `colors` — near the other hand-written ones. Keep values exactly
as the palette's author published them.
