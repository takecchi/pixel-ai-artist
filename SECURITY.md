# Security

## Threat model

This is a local developer tool. It assumes you already trust the coding agent
you are running with your filesystem. Within that assumption, here is exactly
what it does and what it does not do.

## No network surface

The server speaks MCP over stdio to the agent that started it, and nothing
else. It opens no port, listens on no interface and starts no other program.
The documents it edits live in its own memory and go away with it.

## Filesystem access

Tools that take a `path` — `export`, `sprite_manage` (`open`, `save_as`),
`reference` (`import`), `palette` (`load`) — read or write wherever the model
asks, creating missing directories on write. There is no sandbox root. Paths are
used as given; nothing is interpolated into a shell.

In short: these tools read and write files wherever you point them, with the
same reach you have yourself. That is deliberate for a local tool, but it is
worth knowing before you hand a path to an agent.

Images read from disk are refused above 16384 pixels on either side, so a
hostile or broken file cannot make the server allocate an unbounded canvas.

## Editing your agent configuration

`install` modifies files that belong to your agent:
`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`,
`~/.cursor/mcp.json`, `.vscode/mcp.json`, `~/.codeium/windsurf/mcp_config.json`,
`~/.config/opencode/opencode.json`.

Two protections:

- **A timestamped backup** (`<file>.bak-<iso>`) is written before every change.
- **Writes are atomic** — a temp file in the same directory, renamed over the
  target. `~/.claude.json` in particular holds Claude Code's own project list and
  session state and can be over 100KB; a partial write would break your whole
  setup, and a rename cannot produce one.

Rewriting is also surgical where it can be: the Codex TOML editor replaces only
its own `[mcp_servers.pixel-ai-artist]` table, matched at the start of a
line so the same text inside a comment or a string cannot misdirect the splice.

There is no file lock. If your agent writes its own config at the same moment,
one side's change can still be lost. Run `install` while the agent is closed, or
use `--dry-run` first to see exactly what would change.

## Instructions served to the agent

The server serves `skill://` and `rules://` resources read from `skills/` and
`rules/` on disk, plus an `instructions` string. Anything that can write into
those directories controls what your agent is told to do. Treat them as you
would any other executable content in a repository you have installed.

## What is never sent anywhere

Nothing leaves the machine. There is no telemetry, no network egress, and no
credential handling anywhere in this codebase.

## Reporting a vulnerability

Open a security advisory on the repository rather than a public issue:
https://github.com/takecchi/pixel-ai-artist/security/advisories/new
