# Rules

The pixel-art craft this project encodes. One source of truth, consumed three
ways:

- **Claude Code** reads these files directly from the plugin.
- **Every other MCP client** reads them as `rules://` resources served by the
  MCP server, so Codex, Gemini CLI and Cursor get the same discipline.
- **The tools themselves** implement the mechanical parts — palette snapping,
  hue-shifted shading, the validation checks — so an agent that never reads a
  word of this still cannot casually break the palette.

Read `rules://index` for the list, or start at `00-core-principles.md`.
Files are numbered in bands:
`0x` core discipline, `1x` technique, `2x` colour and materials, `3x`
characters, `4x` animation, `5x` creatures, `6x` environments, `7x` objects and
3D, `8x` effects and UI, `9x` style. Subject files carry ` ```grid ` templates
in the format `draw` kind `grid` accepts.

Where a rule says `draw` kind `grid` (or `blit`, `line`, `dither`…), it means
one entry of the `draw` tool's `ops` array: `draw ops:[{kind:"grid", x, y,
legend, rows}]`. `kind` picks the shape; there is no `op` inside `ops`.

Changing a rule here changes behaviour everywhere. Skills reference rules by
name rather than restating them, so a rule has exactly one place to be wrong.
