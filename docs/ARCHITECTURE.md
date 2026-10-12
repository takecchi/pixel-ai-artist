# Architecture

## The constraint everything follows from

Aseprite's Lua API provides a WebSocket **client**. It cannot listen. So
something outside Aseprite has to hold a listening socket, and the extension
dials out to it.

That single fact produces the three-process shape below.

```
   Agent host (Claude Code / Codex / Gemini / Cursor / VS Code / Windsurf)
   ┌──────────────────────────────────────────────────────────────┐
   │  skills (skill://…)   rules (rules://…)   18 tools           │
   └───────────────────────────┬──────────────────────────────────┘
                               │ stdio, MCP JSON-RPC
                               ▼
   ┌──────────────────────────────────────────────┐   one per agent window;
   │  pixel-ai-artist serve   (src/server.ts)  │   the host owns its
   │  LiveClient  =  control client               │   lifecycle and may
   └───────────────────────────┬──────────────────┘   restart or duplicate it
                               │ WebSocket  ws://127.0.0.1:9942
                               │ • spawns the bridge if nothing owns the port
                               │ • reconnects with backoff
                               │ • reads bridge_state → pluginConnected
                               ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  pixel-ai-artist bridge   (src/bridge/bridge.ts)          │
   │  SINGLETON by port ownership · owns :9941 and :9942          │
   │  dumb relay; outlives every MCP server restart               │
   └───────────────────────────┬──────────────────────────────────┘
                               │ WebSocket  ws://127.0.0.1:9941
                               ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Aseprite 1.3 + extension/ai-artist.lua  (client-only WS)     │
   │  executes named commands, draws into the OPEN window          │
   └──────────────────────────────────────────────────────────────┘
```

## Why the bridge is its own process

The agent host starts, stops and duplicates the MCP server as it pleases. When
the listening socket lives inside that process:

- every restart drops Aseprite's connection, and
- a second agent window fights the first over the listen port.

As a standalone singleton, the bridge keeps Aseprite attached across MCP
restarts, and a second MCP server simply becomes a second control client. The
loser of the port-bind race exits 0 without complaint, so "spawn the bridge if
it is missing" is safe to run unconditionally.

See [ADR-0002](adr/0002-standalone-bridge.md).

## Request routing

The bridge accepts **N control clients** but **at most one Aseprite** (last
connection wins, so restarting Aseprite is never locked out by a half-open
socket). Replies therefore have to be routed back to the client that asked,
which is what the id namespacing is for:

```
 MCP server                bridge                       Aseprite
 ──────────                ──────                       ────────
 {id:"r42", …}   ────────▶ rewrite id → "c3::r42" ────▶ {id:"c3::r42"}
                                                          (draws)
 {id:"r42", …}   ◀──────── split "c3::r42" →      ◀──── {id:"c3::r42",
                           client 3, orig "r42"            ok:true, …}
```

`hello` and other id-less frames from Aseprite update bridge state and are
**broadcast** to every client as `bridge_state`, which is how `preflight` can
answer truthfully without a round trip.

## Failing loudly

When Aseprite is not attached, the bridge answers the client itself with
`not_connected` and `doNotFallBackToDisk: true`, rather than letting the call
hang until it times out.

This matters more than it looks. A timeout reads to an agent as "slow, try
something else", and the something else is editing the `.aseprite` file on disk
— which the user does not see in their open editor and which their next save
silently overwrites. A fast, structured, explicit refusal is the only failure
mode that does not quietly destroy work.

## Headless mode

`serve --headless` (or `PIXEL_AI_HEADLESS=1`) swaps the link, not the tools.
Every tool talks to an `AsepriteLink` (`src/bridge/link.ts`); the live one goes
through the bridge, the headless one (`src/bridge/headless.ts`) owns a single
`aseprite -b` running `headless/runner.lua`:

```
your agent ──stdio/MCP──▶ server ──stdin: {id,cmd,args}\n──▶ aseprite -b ─▶ runner.lua ─▶ extension/ai-artist.lua
                                 ◀──stdout: "\x1eaia {…}"\n──
```

- **One process, kept alive.** Documents, the active site and undo history
  live in memory between calls, exactly as in the editor. Nothing is on disk
  until `save`/`save_as`/`export`.
- **The same command table.** The runner `dofile`s the shipped extension; its
  WebSocket transport is skipped because `app.isUIAvailable` is false. There
  is no second implementation to drift.
- **Framed replies.** Every reply line carries a `\x1eaia ` marker, because
  `print` inside a handler and Aseprite's own warnings share stdout.
- **An isolated user folder** (a scratch directory unless
  `ASEPRITE_USER_FOLDER` is set), so a batch session never loads the user's
  extensions or touches their recent files.
- **A crash is reported, not papered over.** Calls in flight fail with
  `headless_exited`; a crash between calls is reported by the next call before
  a fresh process starts, because the documents it held are gone.
- **The editor guard.** If the user's own Aseprite is attached through the
  bridge, headless `open`, `save`, `save_as` and `export` op `aseprite` refuse a
  path that window has open (`file_open_in_editor`).

`serve --headless` picks the starting mode; after that a `LinkSelector`
(`src/bridge/selector.ts`) switches only on `preflight mode=…`. Both links live
for the rest of the server, so a switch loses no documents on either side. It
is never entered as a recovery from a dropped live session. See
[ADR-0008](adr/0008-headless-mode.md).

## Ports

| Port | Owner | Purpose | Environment override |
|------|-------|---------|---------------------|
| 9941 | bridge | The Aseprite extension dials here | `PIXEL_AI_PLUGIN_PORT` |
| 9942 | bridge | MCP servers dial here as control clients | `PIXEL_AI_CONTROL_PORT` |

Both bind `127.0.0.1` only. Nothing listens on a public interface, and there is
no authentication because there is no remote surface to authenticate.

## Where work happens

| Concern | Lives in | Why there |
|---------|----------|-----------|
| Tool schemas, validation, batching | `src/tools/` | Where the agent's contract is |
| CIELAB colour maths | Both sides | Server for reports, Lua for per-pixel passes |
| Image upscaling | Aseprite | Keeps the npm package free of native deps |
| ASCII grids and diffs | `src/lib/render.ts` | Text formatting is cheap and testable in Node |
| Pixel loops | Lua | Sending a 64×64 image over the wire per op would not scale |

The colour maths is deliberately duplicated (`src/lib/color.ts` and the CIELAB
block in `extension/ai-artist.lua`), because a palette snap that disagrees
between the report and the pixels is worse than either being wrong alone. Both
sides are pinned to the same numeric fixtures — `tests/color.test.ts` and the
"Lua CIELAB agrees with the TypeScript port" check in `tests/extension.test.lua`
assert the same white/black L\*, the same ΔE bounds, the same grey-snaps-to-grey
case and the same hue-shift direction. The Lua half runs only under
`pnpm run test:extension`, not in CI (CI has no Aseprite), so a drift is caught
locally rather than on a pull request.

## Known limits

- **Reconnect may wait for focus.** A live connection keeps working while
  Aseprite is unfocused, but the extension's reconnect timer is driven by the UI
  loop, so re-establishing a *dropped* connection can wait until the window is
  focused once.
- **Text grids are bounded by the canvas.** `look` op `ascii` reads up to the
  whole canvas and `draw` kind `grid` accepts up to its size. Glyphs follow
  palette indices — 261 of them — and `ascii` refuses only when the palette
  plus off-palette colours outgrow that: a grid whose glyphs collide would
  misreport which colour is where.
- **`transform` acts on one cel**, the target layer's image on the target frame.
  There is no selection- or sprite-scoped transform; crop a region out with
  `draw` op `blit` first if you need one.
- **blob47 export assumes canonical ordering.** The wangset it writes maps
  atlas slot *n* to the *n*-th canonical blob mask in ascending order. A tileset
  authored in a different order exports a wangset that autotiles wrongly, so
  the export refuses unless the set has all 47 tiles. `tileset` op `export` with
  `format: "json"` reports the index-to-mask mapping if you need to check.
- **Godot export targets Godot 4.** It writes a `TileSet` with a single
  `TileSetAtlasSource`; Godot 3's format is different and is not emitted.
