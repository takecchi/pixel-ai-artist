# Changelog

## 0.1.0

First release. A port of
[with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
0.8.1 that needs no editor: the same tools answer from a document model inside
the server process.

### Tools

Seventeen MCP tools, with the original's names, arguments and results, except
where *Differences from the original* below says otherwise:

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

### Differences from the original

- Layer names are unique. `layer` create, rename and `set` `newName` refuse a
  name another layer has (`invalid_args`); names the server picks (`Layer N`,
  `<name> Copy`, `reference`) take the next free one, and `reference` import
  returns the name it used.
- `sprite_manage` `save` and `save_as` return `files`, the files actually
  written (`walk1.png`, `walk2.png`, … for frames saved as PNG); `path` stays
  the name passed in.
- Saving to `.png` or `.gif` returns `lostOnSave`, what the file could not
  keep: layers drawn into one picture, tags, and for PNG the frames (written
  as numbered files without durations) and an indexed sprite's palette.
- `sprite_info` and the layer list mark a Background layer with
  `background: true`.
- `export` returns `outputWidth`, `outputHeight` and `scale`: the size of the
  image written, next to `width` and `height`, which stay the sprite's.
- `draw` kind `clear` with no `rect` counts in `pixelsChanged` only the pixels
  it cleared, and its `bounds` cover those; the original counted the whole
  cel. With a `rect` or a selection the count is the original's.
- The text of `validate`, `sprite_manage` `list`, `tag` and `cel` `move` /
  `set` replies says what to do next (a warning is no longer called clean;
  findings past the fifteenth are counted). Their structured results are the
  original's.
- `install`:
  - a Codex reinstall replaces only `[mcp_servers.pixel-ai-artist]` and its
    sub-tables, and finds that header when it ends in a comment;
  - Codex's user config is `$CODEX_HOME/config.toml` when `CODEX_HOME` is set;
  - a file that would not change is not rewritten or backed up;
  - `--dry-run` shows each entry under the key it goes in;
  - an unknown option is refused, and `--agents` and `--dir` never take a
    client name as their value (`--agents=<path>` and `--dir=<path>` do);
  - a client that fails is reported on stderr, the command exits 1, and the
    restart advice is not printed.

### Not ported

Tilesets, slices, layer groups, linked cels (opened as copies), blend modes and
`run_lua`. There is no tool for tilesets or `run_lua`. The slice ops of
`sprite_manage` and `cel` `link` / `unlink` answer `unsupported_command`, saying
what to do instead. Arguments that asked for these, or for other dropped
features, answer `invalid_args`, naming the argument, instead of being ignored:
`draw` `label`, `transform` `allowLossy`, `preflight` `mode`, `sprite_info`
`includeSlices`, `layer` `parent`, `blendMode` and `names`, `frame` `linkCels`
and `cel` `frames`. A value that asks for nothing missing (`false`,
`"normal"`, empty) is accepted.
