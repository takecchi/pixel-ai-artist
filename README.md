# Pixel AI Artist

Your coding agent makes pixel art with the same tools, skills and pixel-art
rulebook as [aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
— with no editor and no window. The sprites live inside the MCP server, the
agent draws into them and looks at them there, and they leave as PNG and GIF
files and sprite sheets with a JSON atlas, ready for a game engine or any image
editor.

Nothing to install besides the server itself: no Aseprite, no extension, no
display. That makes it work the same on a laptop, over SSH, or in CI.

For Claude Code, omp, OpenCode, Codex CLI, Gemini CLI, Cursor, VS Code and
Windsurf. Node 22.6+ on macOS, Linux or Windows.

> **Work in progress.** The tools are being ported command by command; a
> command that is not ported yet answers `unsupported_command` rather than
> pretending to work.

## Derived from aseprite-ai-artist

This is a port of
[with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
(MIT, Copyright (c) 2026 with-pebbly), imported at commit `dcd5a77` (0.8.1).
The pixel-art rulebook, the skills, the subagents and the tool surface come
from there; what changed is underneath. The original drives a running Aseprite
through a Lua extension. Here the same commands are answered in-process by a
document model written in TypeScript.

The tool names, arguments and results follow the original, so its skills work
unchanged. A few Aseprite features are not ported: tilesets, slices, layer
groups, linked cels, blend modes and `run_lua`.

## Install

See [docs/INSTALL.md](docs/INSTALL.md). In short, for Claude Code:

```
/plugin marketplace add takecchi/pixel-ai-artist
/plugin install pixel-ai-artist@pixel-ai-artist
```

For any other MCP client, start it straight from GitHub — the package is
**not on npm yet**, and npm clones and builds it on first use:

```json
{
  "mcpServers": {
    "pixel-ai-artist": {
      "command": "npx",
      "args": ["-y", "github:takecchi/pixel-ai-artist", "serve"]
    }
  }
}
```

The first start takes about ten seconds (clone, install, build); later starts
reuse npm's cache and take two or three. Pin a branch, tag or commit with
`github:takecchi/pixel-ai-artist#<ref>`. Working from a checkout instead?
`npm ci`, then `node dist/cli.js install <client> --local` points the client at
it. Once the package is published,
`npx pixel-ai-artist install codex` (or `gemini`, `cursor`, `opencode`,
`--all`) writes the config for you.

## How it draws

Ask `/pixel-ai-artist:studio` for anything and it runs the whole job: a brief
when the request is open-ended, a concept, the drawing — silhouette first,
written as a text grid of one character per pixel — then shading, a rig and
frames for animation, a cold review by a critic that did not draw it, and the
export. After every step that changes pixels, the agent **looks** at the result
(`look` returns an upscaled PNG, or the exact pixels as text) before moving on.

The agent doesn't improvise a hand at 16 px or a horse's walk — it looks them
up in [`rules/`](rules/): 62 files from line craft to walk cycles, with pixel
templates it can paste onto the canvas, served to every client as `rules://`
resources. About 2000 palettes come bundled.

## Skills

`studio` picks these for you; call one directly when you know the step you
want — `/pixel-ai-artist:<name>` in Claude Code, omp and OpenCode, or an MCP
prompt elsewhere.

| Skill | For |
|---|---|
| `studio` | anything — it plans and runs the rest |
| `brief` | a vague idea |
| `concept` | a design or storyboard before drawing |
| `new` | a fresh document set up right |
| `palette` | colour: a retro look, ramps, cleanup |
| `draw` | making the thing, text included |
| `shade` | flat art that needs light |
| `rig` | splitting a character for animation |
| `animate` | walk, idle, attack cycles |
| `review` | an honest critique |
| `fix` | changing art without wrecking it |
| `export` | files for your engine |

In Claude Code and omp, four specialists take stages off the main agent:
palette-smith, rig-builder, animation-director and the read-only pixel-critic.

## Under the hood

```
your agent ──stdio/MCP──▶ server: tools ──▶ Studio ──▶ documents in memory ──▶ files
```

- **17 tools, grouped by noun** (`draw`, `look`, `layer`, `frame`, `export`…)
  instead of ninety: every tool costs context on every turn.
  [Reference](docs/TOOLS.md).
- **One process.** No network listener and no other program to drive; the
  server only reads and writes the files the agent names.
  [Architecture](docs/ARCHITECTURE.md) · [security](SECURITY.md).

## Development

```bash
npm ci && npm run build
npm test
```

Read [AGENTS.md](AGENTS.md) before changing anything.

## License

MIT — see [LICENSE](LICENSE). Aseprite is a trademark of Igara Studio S.A.;
neither this project nor aseprite-ai-artist is affiliated with them.
