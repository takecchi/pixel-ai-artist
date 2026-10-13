# Changelog

## 0.1.0

First release. A port of
[with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
0.8.1 that needs no editor: the same tools answer from a document model inside
the server process.

### Tools

Seventeen MCP tools, with the original's names, arguments and results:

- `preflight`, `sprite_info`, `sprite_manage`
- `layer`, `frame`, `tag`, `cel`
- `draw`, `select`, `transform`, `recolor`
- `look`, `read_pixels`, `validate`
- `palette`, `reference`, `export`

### Features

- In-process sprites in RGB, grayscale and indexed modes, with layers, frames,
  tags, a palette and a Background layer, held in memory until saved or exported.
- Files:
  - open PNG, GIF and JPEG the way Aseprite opens them (palette PNGs and GIFs
    as indexed, images with no transparency as a Background);
  - open `.aseprite` with its layers, frames, tags, palette and pixel ratio.
    Layers that share a name are renamed (`Ink 2`), and Background layers
    are moved to the bottom, where they are drawn; the reply says which;
  - save `.aseprite`, PNG (one file per frame, named as Aseprite names them)
    and GIF.
- `.aseprite`:
  - keeps layer flags, user data, the colour profile and the grid through a
    save;
  - a file that uses something the model cannot hold is refused, and the
    reply says what;
  - linked cels open as copies and are saved as separate images, which the
    reply on opening reports.
- Reference layers made by `reference` import are ordinary layers, as in the
  original. They are drawn and exported like any other layer, and a mark in
  the layer's user data keeps them reference layers through `.aseprite`.
- Export:
  - PNG, GIF, numbered frames, and sprite sheets with an Aseprite-style JSON
    atlas (`rows`, `columns`, `horizontal`, `vertical`, `packed`, padding,
    trim, split by tag);
  - a copy as `.aseprite`.
- Palettes:
  - load `.gpl`, `.hex`, JASC `.pal`, `.act`, `.col`, images and `.aseprite`;
  - bundled presets, ramps, extraction and usage counts.
- The pixel-art rulebook, skills and subagents from the original, rewritten for
  a server with no editor. Plugins for Claude Code, omp and OpenCode, and
  `install` for Codex CLI, Gemini CLI, Cursor, VS Code and Windsurf.

### Not ported

Tilesets, slices, layer groups, linked cels (opened as copies), blend modes and
`run_lua`. Requests for them answer `unsupported_command`.
