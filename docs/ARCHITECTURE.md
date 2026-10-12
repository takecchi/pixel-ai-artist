# Architecture

One process. The agent's host starts the server and talks MCP to it over stdio;
the server keeps the sprites in memory, draws into them, and reads or writes
files only when a tool names a path.

```
  your agent (Claude Code, Codex, …)
      │  stdio, MCP
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  pixel-ai-artist serve   (src/server.ts)                      │
  │                                                               │
  │  tools        src/tools/      schemas, validation, batching,  │
  │      │                        text and grid expansion         │
  │      │  studio.call(cmd, args)                                │
  │      ▼                                                        │
  │  Studio       src/doc/studio.ts   documents, resolution,      │
  │      │                            dispatch                    │
  │      ▼                                                        │
  │  handlers     src/doc/handlers/   one module per area         │
  │      │                                                        │
  │      ▼                                                        │
  │  documents    src/doc/model.ts    sprites, layers, frames,    │
  │                                   cels, tags, palette,        │
  │                                   selection                   │
  └──────────────────────────────────────────────────────────────┘
      │  only when a tool names a path
      ▼
  PNG · GIF · JPEG in;  PNG · GIF · sprite sheet + JSON atlas out
```

## Why it is shaped like this

aseprite-ai-artist, which this is a port of, sent every tool's work to a
running Aseprite: a Lua extension answered named commands (`draw.batch`,
`layer.apply`, `export.run`…) over a WebSocket bridge. Every tool already went
through one call, `link.call(cmd, args)`. Replacing what answers that call —
not the tools — let the port keep the tool names, arguments and results, and
with them every skill, unchanged.

So `Studio.call` takes the same command names, and each handler is a port of
the Lua function that answered it: the same fields, the same error codes and
messages, the same quirks unless they were bugs. Where a handler departs from
the Lua, its commit and pull request say why.

## The document model

`src/doc/model.ts`. Pixels hold the raw value of the sprite's colour mode, as
Aseprite's do: packed RGBA for rgb and grayscale, a palette index for indexed.
Editing a palette entry therefore recolours an indexed sprite's pixels, and the
transparent index means no paint. Code reads and writes pixels through
`pixelToRgba` / `pixelToHex` / `isOpaque` / `rgbaToPixel`, never by assuming a
mode; `Studio.composite` always returns RGBA.

Frames are 1-based, layers are ordered bottom to top, a selection is a
canvas-sized mask. Not modelled, and not on the tool surface: layer groups,
tilemaps and tilesets, slices, linked cels, blend modes.

## Commands

`src/doc/studio.ts` resolves "which sprite, layer, frame" in one place, as the
Lua's `find_sprite` / `find_layer` / `find_frame` did: `'#7'` or `7`, a path or
file name; a name two documents share is refused with their ids. It dispatches
to the handler table built in `src/doc/commands.ts` from `src/doc/handlers/`.

- A command with no handler answers `unsupported_command`. Nothing is a silent
  no-op.
- A handler that throws anything but a `ToolError` is an `internal_error`.
- Fields the Lua left nil are `undefined`, so they drop out of results the way
  they dropped out of its JSON.

## Failing loudly

Every tool returns its errors as tool results with `isError` and a structured
`{ ok: false, code, message, details }`, never as protocol errors: the model has
to see an error to recover from it, and most hosts swallow JSON-RPC errors.

There is no undo. Instead, a `draw` or `layer` batch lands whole or not at
all: a failing op puts back what the batch changed.

## Where work happens

| Concern | Lives in |
|---------|----------|
| Tool schemas, validation, batching | `src/tools/` |
| Bitmap text and `grid` expansion into plain pixel ops | `src/lib/text.ts`, `src/lib/grid.ts` |
| Documents, resolution, compositing | `src/doc/model.ts`, `src/doc/studio.ts` |
| Drawing primitives, selections | `src/doc/raster.ts`, `src/doc/selection.ts` |
| One handler per command area | `src/doc/handlers/` |
| CIELAB colour maths | `src/lib/color.ts`, shared by handlers and reports |
| PNG, GIF, JPEG decoding and encoding; sprite sheets | `src/lib/` (Node's zlib, no native dependencies) |
| ASCII grids and diffs for `look` | `src/lib/render.ts` |

## Known limits

- **Everything is in memory.** Documents last as long as the server process;
  nothing is on disk until `sprite_manage` saves or `export` writes it.
- **Text grids are bounded by the canvas.** `look` op `ascii` reads up to the
  whole canvas and `draw` kind `grid` accepts up to its size. Glyphs follow
  palette indices — 261 of them — and `ascii` refuses only when the palette
  plus off-palette colours outgrow that: a grid whose glyphs collide would
  misreport which colour is where.
- **`transform` acts on one cel**, the target layer's image on the target frame.
  There is no sprite-scoped transform; crop a region out with `draw` op `blit`
  first if you need one.
