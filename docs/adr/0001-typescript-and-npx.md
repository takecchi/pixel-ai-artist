# ADR-0001 — TypeScript on npm, not a compiled binary

**Status:** accepted · 2026-09-08

## Context

The server has to run under Claude Code, Codex CLI, Gemini CLI and Cursor, on
macOS, Windows and Linux. Existing Aseprite MCP servers are written in Rust,
Python and TypeScript.

The Rust implementations produce the best runtime, and the worst installation
story: the MCP config has to name a per-OS binary path (`…/aseprite_mcp.exe` on
Windows), which means the config a user copies from the README is wrong for half
of them, and a plugin cannot ship one file that works everywhere.

## Decision

TypeScript, published to npm, launched with `npx -y pixel-ai-artist`.

No native dependencies. Specifically, no image library such as `sharp`: in
aseprite-ai-artist, previews were upscaled inside Aseprite; in this port the
PNG, GIF and JPEG codecs and the nearest-neighbour upscale are plain
TypeScript over Node's zlib.

## Consequences

**Good.** One config line is identical on every OS and in every client. The
plugin, the docs and `install` all say the same thing. `npx` means no install
step at all for a user who just wants to try it.

**Good.** The MCP TypeScript SDK is a Tier-1 SDK and tracks the spec first.

**Amended (port).** aseprite-ai-artist kept per-pixel loops in Lua, inside
Aseprite, because sending a 64×64 image over the wire per drawing operation
would not scale. With the documents in the server's own memory there is no
wire, and the loops are TypeScript; at pixel-art sizes they are fast enough.

**Bad.** `npx` adds a cold-start delay on the first run of each version.
Acceptable for a tool whose next action waits on a human looking at a sprite.

**Amended (port).** The CIELAB colour maths used to exist twice, in TypeScript
and in Lua. It now exists once, in `src/lib/color.ts`.
