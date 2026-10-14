# Working on this repository

Guidance for agents and humans changing this code. For using the tool, see the
[README](README.md).

This is a port of
[with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
imported at `dcd5a77` (0.8.1). Docs, tool descriptions and skills describe the
port, with every command ported; a command still being ported answers
`unsupported_command` until it is. Keep them in step with the code — a change
to what a tool does changes its description and the skills that use it in the
same pull request.

## Shape

| Path | What |
|------|------|
| `src/` | The MCP server and CLI (TypeScript) |
| `src/doc/` | The in-process documents: model, `Studio`, and one handler module per area under `handlers/` |
| `rules/` | Pixel-art craft, served as `rules://` resources |
| `skills/` | Workflows, served as `skill://` resources and MCP prompts |
| `agents/`, `hooks/` | Claude Code plugin surface; omp reads the same tree as a marketplace plugin |
| `omp/`, `opencode/` | omp and OpenCode plugins replaying the hooks and skills |
| `tests/` | Node tests |
| `docs/adr/` | Decisions inherited from aseprite-ai-artist. Read before arguing with them. 0006, 0007 and 0012 are its gallery and website, which were not imported. |

## How the port differs from aseprite-ai-artist

- No editor is involved. The documents live in the server's memory and the
  tools draw into them; results leave as files (PNG, GIF, sprite sheets, and
  later `.ase` so Aseprite can open them).
- The Aseprite link — the Lua extension, the WebSocket bridge, the control
  client and headless `aseprite -b` — is gone. Tools call `Studio.call` with
  the extension's command names.
- Tilesets, slices, linked cels, blend modes, layer groups and `run_lua` are
  not ported and not on the tool surface: no schema field or op names them.
  A command still being ported answers `unsupported_command`.
- The `submit` skill (a pull request to aseprite-ai-artist's gallery) is not
  ported; there is no gallery here.
- No undo. A batch (`draw`, `layer`) lands whole or not at all instead.

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

## Releasing

Set the same version in `package.json` and `opencode/package.json`, merge, then
push a tag `v<version>` on that commit. `.github/workflows/release.yml`
publishes it to npm through Trusted Publishing, with provenance, and refuses a
tag that does not match both versions. Nothing else publishes.

## Testing

```bash
npm test   # colour, rendering, documents, MCP surface
```

`package-lock.json` is the only lockfile; `bin/pixel-ai-artist.mjs`
builds a git install with `npm ci`, and CI uses the same tree.
