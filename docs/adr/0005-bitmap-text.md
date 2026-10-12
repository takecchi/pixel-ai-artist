# ADR-0005 — Text is bitmap-only, laid out in TypeScript

**Status:** accepted · 2026-09-29

## Context

Sprites need words: HUD labels, badges, title cards, speech bubbles. Something
has to produce the glyphs and write them as pixels. (In aseprite-ai-artist the
reason was sharper: Aseprite's Lua API has no call that rasterises text into a
cel.)

Two sources were on the table: TrueType/OpenType files, or bitmap fonts whose
glyphs are already pixel grids.

## Decision

- **Bitmap fonts only.** A font is a JSON file in `knowledge/fonts/`: cell size,
  baseline, space width, and each glyph as rows of `#` and `.`. The format is
  ours, documented in [TOOLS.md](../TOOLS.md), and readable and editable by hand
  or by an agent.
- **Layout happens in the tool.** `draw` op kind `text` is expanded into an
  ordinary `pixels` op before it reaches `draw.batch`, which has no text code;
  the text lands all or nothing, with the same palette lock, as the rest of the
  batch.
- **One original font ships**: `pixel5x7`, ASCII 32–126, drawn for this project
  and released CC0.
- `measureOnly` returns the ink box without touching the sprite, so a label can
  be centred or a panel sized in one pass.

## Consequences

**Good.** No native dependency (ADR-0001 holds): rasterising TrueType without
one means shipping a font renderer. Bitmap glyphs are pixel art already, so the
result obeys the rulebook; a vector font rendered small is soft, uneven, or both.

**Good.** The layout is pure code with unit tests.

**Bad.** Users who want a specific typeface must transcribe it into the format.
Fine for pixel fonts, which are small by nature.

## Revisit when

Users ask repeatedly for a specific non-bitmap face.
