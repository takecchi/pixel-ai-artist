# Tools

Seventeen tools, grouped by noun with an `op` enum for the verbs. See
[ADR-0003](adr/0003-compact-tool-surface.md) for why.

Every successful call returns `structuredContent` validated against the tool's
`outputSchema`. Errors come back as tool results — never as protocol errors —
because the model has to see them to recover: `isError: true`, no structured
content, and text whose first line is `<code>: <message>` (`invalid_args`,
`no_active_sprite`, `refused`, `unsupported_command`…).

## Session

| Tool | Ops | Notes |
|------|-----|-------|
| `preflight` | — | `ready`, the server `version`, the active sprite and a one-line directive. **Call this first.** Always answers, never fails. |
| `sprite_info` | — | Full document state: dimensions, colour mode, palette, layers, frames with durations, tags, selection. |
| `sprite_manage` | `list` `new` `open` `activate` `save` `save_as` `close` `resize_canvas` `set_properties` | Documents live in the server's memory; `open` reads a file into one, `save`/`save_as` write it back. `close` refuses on unsaved changes unless `force` — there is no undo. |

## Looking

| Tool | Ops | Notes |
|------|-----|-------|
| `look` | `preview` `ascii` `filmstrip` `diff` `onion` `compare` | The see-your-work tool. |
| `read_pixels` | — | Structured pixel data: distinct colours plus a row-major index grid. |

- **`preview`** — nearest-neighbour upscale to a ~1024px long edge (bounded so
  the output never exceeds ~2048px). For judging the overall read.
- **`ascii`** — exact text grid, one glyph per pixel, with coordinate rulers and
  a colour legend. For verifying precise positions, and for clients with no
  vision. Reads up to the whole canvas; pass a `region` to crop. Glyph *n* is
  palette entry *n* on every read, so regions of one sprite share a legend;
  colours outside the palette are listed in `offPalette` and are the only
  glyphs that can change between reads. `rulers: false` prints the bare rows; either way
  the result carries `gridRows`, `legend` and `origin`, which `draw` kind `grid`
  takes back unchanged — read, edit the rows, write.
- **`filmstrip`** — every frame in one image. A vision model reads only the
  first frame of a GIF, so this is the only way to review animation. `layer`
  limits it to one layer.
- **`diff`** — pixel-level text diff between two frames. `.` unchanged,
  `-` erased, glyph = the new colour. Reports `changedBounds` (tight bounding
  box of every changed pixel, null when nothing changed) and `percentChanged`.
- **`onion`** — the target frame at full opacity over ghosted neighbouring
  frames (`framesBefore`/`framesAfter`, default 1 each; `ghostOpacity`
  0-255, default 90), oldest-first. For checking in-betweens and spacing while
  animating without stepping through frames one at a time. Over an opaque
  background the target hides the ghosts — pass `layer` to show only the part
  that moves. Reports
  `framesUsed`, the 1-based frame numbers composited.
- **`compare`** — the reference layer (`reference`, default `"reference"`) at
  full opacity on the left, the art with every reference layer removed on the
  right, same frame and scale, one grey pixel between. For the loop that makes a
  reference pay off: name the few largest mismatches, fix only those, compare
  again. Rendered from a scratch copy, so no layer in the document is hidden
  or shown to produce it.

## Drawing

| Tool | Ops / kinds | Notes |
|------|-------------|-------|
| `draw` | `pixels` `line` `polyline` `rect` `ellipse` `fill` `replace` `dither` `gradient` `clear` `blit` `text` `grid` | Batch, all or nothing: if any op fails, the cel is left as it was. |
| `select` | `get` `none` `all` `rect` `ellipse` `color` `invert` `grow` `shrink` | Scopes `draw`, `transform` and `recolor`. `color` is a magic wand: `tolerance`, and `contiguous` from a start point `x`/`y`. |
| `transform` | `translate` `flip` `rotate` `scale` `outline` `crop_to_content` | Acts on ONE cel; there is no scope parameter. Rotation is by 90° steps only; other angles are refused. `outline`'s `side` (`outside` default, `inside`) picks which pixels get painted; `diagonals` (default `false`) switches 4- to 8-neighbour. |
| `recolor` | `shade` `snap` `replace` `hue_shift` `desaturate` | Operates on distinct colours, not pixels, in one pass. |

`draw` kind `text` lays out a string from a bitmap font and expands it to
plain pixels before it is drawn: `text`, `x`, `y`, `color`, `font`
(name in `knowledge/fonts/`, default `pixel5x7`), `anchor` (one of
`top_left` `top` `top_right` `left` `center` `right` `bottom_left` `bottom`
`bottom_right` `baseline_left` `baseline` `baseline_right`, resolved against
the glyph ink box — outline and shadow never shift it), `letterSpacing`,
`lineSpacing`, `bold` (0-3, grid-cell passes grown rightward), `outlineColor`,
`outlineDiagonals` (default `true`), `shadowColor`, `shadowOffset`
(default `{x:1,y:1}`), `scale` (1-8). Multiline via `\n`. Pass top-level
`measureOnly: true` with only `text` ops to get each one's ink bounds
(`textBounds`, null when there's no ink) without touching the sprite — size a
panel or centre a label first. See
[ADR-0005](adr/0005-bitmap-text.md) and the font format below.

`draw` kind `grid` is a picture written as text — the writable form of
`look op="ascii"`: `x`, `y` (top-left, default 0), `legend` (one character →
`#rrggbb` or `#rrggbbaa`, or `null` for transparent; `.` is transparent unless redefined),
`rows` (top to bottom, one character per pixel, every row the same width, at
most 256×256), `transparent` (`erase`, the default, clears transparent cells so
the rectangle ends up exactly as written; `skip` leaves what is underneath).
It is compiled on the server into `clear` rectangles and one `pixels` op per
colour: the palette lock snaps each legend colour once, and `selectionOnly`
clips both the painted and the erased cells. A
ragged row or a character missing from the legend is refused with its row and
column, never padded. See [ADR-0010](adr/0010-pixel-grid.md).

### Font format

A font is `knowledge/fonts/<name>.json`: `name`, `license`, `cellWidth`,
`cellHeight`, `baseline` (rows above the baseline, inclusive), `spaceWidth`,
`glyphs` (a map from character to rows of `#`/`.`, top to bottom — row length
is the glyph's width), and an optional `advance` map overriding a glyph's
default width. One font ships: `pixel5x7`, hand-drawn ASCII 32–126, CC0.

## Structure

| Tool | Ops | Notes |
|------|-----|-------|
| `layer` | `list` `create` `rename` `delete` `reorder` `set` `merge` `duplicate` `activate` | Accepts a `batch` array, applied all or nothing. `duplicate` takes an optional `toSprite` to copy a layer's cels into another OPEN sprite by frame index; frames past the target's frame count are dropped and reported. |
| `frame` | `list` `add` `duplicate` `delete` `set_duration` `activate` `reorder` | `durations` sets a whole cycle's timing at once. |
| `tag` | `list` `create` `update` `delete` | Untagged animation frames are unusable by an engine. |
| `cel` | `list` `create` `clear` `delete` `move` `copy` `set` `tween` `oscillate` | `move` shifts a limb without redrawing it. `tween` interpolates position or opacity between two frames with an easing curve (`linear` `ease_in` `ease_out` `ease_in_out` `smoothstep`); `oscillate` adds a sinusoidal position offset (`amplitudeX`/`amplitudeY`, `period`, `phase`) over a frame range. Both fill in any missing in-between cels from the start cel. |

Every `layer` parameter takes a layer name. A name that more than one layer
shares fails with `invalid_args` (`Layer name 'X' is ambiguous: 2 layers share
it.`) instead of silently picking one; rename one of them first.

## Colour and quality

| Tool | Ops | Notes |
|------|-----|-------|
| `palette` | `get` `set` `preset` `load` `ramp` `analyze` `extract` | `ramp` builds hue-shifted ramps; `analyze` finds near-duplicates and off-palette art; `extract` replaces the palette with one quantized from the art itself. |
| `validate` | — | Lints palette, strays, outlines, banding, anti-aliasing, layers, animation and export readiness. Findings carry coordinates. |

`extract` (op on `palette`) replaces the palette with one quantized from the
art itself (RGB sprites only, `maxColors` 2-256, default 16) — for deriving a
curated palette from a reference image imported at full colour.

`validate`'s `expect` runs independently of `checks`, whenever given: a
`layerFrames` map of per-layer `[from,to]` frame ranges flags art outside them
or a missing cel inside one, and `mustNotOverlap` layer-name pairs flag any
frame where both layers' opaque pixels intersect.

## Assets

| Tool | Ops | Notes |
|------|-----|-------|
| `reference` | `import` `sample_palette` `list` `remove` | Imports on a locked, semi-transparent layer. `region` crops one panel of the source (source pixels, also for `sample_palette`); `grid` `{columns, rows, count?, gap?}` cuts a storyboard into panels and puts panel i on frame `frame`+i-1 of one layer — the sprite needs the frames first. |
| `export` | `png` `gif` `spritesheet` `frames` `aseprite` | `spritesheet` writes a JSON atlas, in Aseprite's format, beside the PNG. `layers` (png, gif, frames, spritesheet) exports only those layers; `tags` (gif, frames, spritesheet) only the frames they cover. `aseprite` refuses both, and an unknown name is refused rather than exported as everything. Named layers export visible even if hidden; with `tags`, `frames` filenames count from the first kept frame. |

Tilesets, slices, layer groups, linked cels, blend modes and aseprite-ai-artist's
`run_lua` escape hatch are not ported.

## Resources and prompts

| URI | What |
|-----|------|
| `rules://index` | The pixel-art rulebook contents |
| `rules://{name}` | One chapter, e.g. `rules://02-shading-and-light` |
| `skill://{name}` | One workflow, e.g. `skill://animate` |
| `knowledge://palettes` | Bundled palette presets with notes |

Every skill is also registered as an MCP **prompt**, so clients that render
prompts get them as commands.
