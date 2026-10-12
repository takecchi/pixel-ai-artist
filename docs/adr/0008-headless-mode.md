# ADR-0008 — Headless mode: a batch Aseprite the server owns, chosen explicitly

**Status:** accepted · 2026-09-29

## Context

Everything so far assumes a person with Aseprite open. That excludes CI, a
scripted asset build, a remote box with no display, and an agent run where
nobody wants a window. Other Aseprite MCP servers ([diivi/aseprite-mcp] is the
best known) work only this way: every tool call runs `aseprite -b file.aseprite
--script tmp.lua` and saves the file back.

Two things stand in the way of copying that:

1. **The project's first rule** is that a failure never becomes a disk edit.
   An agent whose live link drops and "recovers" by editing the `.aseprite` file
   makes changes the user's open window does not show and their next save
   destroys. Headless mode edits files on disk by definition.
2. **One process per call** loses everything the editor keeps between calls:
   unsaved documents, the active layer and frame, undo history. It also reopens
   and resaves every document on every call, so tools that behave one way live
   would behave another way headless.

## Decision

- **A mode chosen explicitly, never by failure** — at startup (`serve
  --headless`, `LIBRESPRITE_AI_HEADLESS=1`), or per session with `preflight
  mode="headless"|"live"`, which `libresprite:studio` sets from the request and
  `--headless`/`--live` in the request force. Never a runtime fallback: a live
  session whose window goes away still refuses with `not_connected`, and the
  skill tells the agent to ask the user rather than switch. Both links, once
  created, live for the whole server, so switching loses no documents on
  either side.
- **One long-lived `aseprite -b`** running `headless/runner.lua`, reading
  JSON-line commands on stdin and writing marked reply lines on stdout.
  Documents stay in memory; nothing reaches disk until `save`, `save_as` or
  `export`. `preflight` reports `mode: "headless"` and tells the agent to save.
- **The same command table.** The runner `dofile`s the shipped
  `extension/ai-artist.lua`, whose transport is already skipped in batch mode
  (that is how `tests/extension.test.lua` runs). Tools are typed against an
  `AsepriteLink` interface and do not know which link they have.
- **An editor guard.** When the user's own Aseprite is attached through the
  bridge, headless `open`, `save`, `save_as` and `export` op `aseprite` refuse
  a path that window has open (`file_open_in_editor`). This is the one way a
  headless session can reach work a person is doing, and it is closed.
- **An isolated user folder** by default, so batch Aseprite does not load the
  user's extensions or rewrite their recent-files list.
- **Crashes are loud.** In-flight calls fail with `headless_exited`; a crash
  between calls is reported by the next call before a fresh process starts,
  because the documents it held are gone and "sprite not found" three calls
  later would hide why.

## Consequences

**Good.** Headless and live share every tool, schema and handler, so a fix to
one is a fix to both, and the Lua suite covers both.

**Good.** State survives between calls, so an agent's workflow — create, draw,
look, fix, save — is the same in both modes.

**Bad.** Unsaved work dies with the server. Mitigated by the `preflight`
directive and the server instructions, which both say to save before
finishing; there is deliberately no autosave, because writing files the agent
did not ask to write is its own surprise.

**Bad.** The editor guard only sees an editor attached through the bridge. A
window without the extension is invisible to it. That is the same blind spot a
person has running two Aseprites on one file, and not one this server can close.

[diivi/aseprite-mcp]: https://github.com/diivi/aseprite-mcp
