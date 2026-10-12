# Working on this repository

Guidance for agents and humans changing this code. For using the tool, see the
[README](README.md).

This is a port of
[with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
imported at `dcd5a77` (0.8.1). Docs, tool descriptions and skills still speak
of Aseprite where the port has not reached them yet; rewrite them as the code
under them changes, not ahead of it.

## Shape

| Path | What |
|------|------|
| `src/` | The MCP server, bridge, control client and CLI (TypeScript) |
| `rules/` | Pixel-art craft, served as `rules://` resources |
| `skills/` | Workflows, served as `skill://` resources and MCP prompts |
| `agents/`, `hooks/` | Claude Code plugin surface; omp reads the same tree as a marketplace plugin |
| `omp/`, `opencode/` | omp and OpenCode plugins replaying the hooks and skills |
| `tests/` | Node tests |
| `docs/adr/` | Decisions inherited from aseprite-ai-artist. Read before arguing with them. |

## How the port differs from aseprite-ai-artist

- No editor is involved. The documents live in the server's memory and the
  tools draw into them; results leave as files (PNG, GIF, sprite sheets, and
  later `.ase` so Aseprite can open them).
- The Aseprite link — the Lua extension, the WebSocket bridge, the control
  client and headless `aseprite -b` — is being removed; code still under
  `src/bridge/` is on its way out.
- Tilesets, slices, linked cels, blend modes, layer groups and `run_lua` are
  not ported. Requests for them return `unsupported_command`.

## The rules that are not negotiable

**Nothing may be declared and not implemented.** A schema field, an `op` value
or a check name that nothing reads validates, succeeds, and does nothing. If
you add a field, add the branch that reads it in the same change, and a test
that fails without it.

**The tool count stays at or under 24.** A test enforces it
([ADR-0003](docs/adr/0003-compact-tool-surface.md)).

**Unsupported means unsupported.** An unknown command returns
`unsupported_command`. Never no-op silently.

## Where information goes

| Place | Holds |
|-------|-------|
| Code | How |
| Test names | What — externally observable behaviour, named as the spec |
| Commit messages | Why |
| Code comments | Why not — only where the code deliberately avoids the obvious |

Say each thing in one place. Do not restate the code in a comment or the
commit message in the code.

## CI

Every workflow under `.github/workflows/`:

- skips draft pull requests (`types` includes `ready_for_review`, and each job
  has `if: github.event_name != 'pull_request' || !github.event.pull_request.draft`);
- cancels an older run on the same branch (`concurrency` keyed on workflow and
  branch, `cancel-in-progress: true`).

Copy both blocks into any new workflow.

## Testing

```bash
npm test   # colour, rendering, bridge transport, MCP surface
```

`package-lock.json` is the only lockfile; `bin/pixel-ai-artist.mjs`
builds a git install with `npm ci`, and CI uses the same tree.
