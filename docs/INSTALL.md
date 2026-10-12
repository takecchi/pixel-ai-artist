# Install

> **Before the npm release.** `pixel-ai-artist` is not published on npm yet, so
> the `npx pixel-ai-artist …` commands below do not work. Start the server
> straight from GitHub instead — in any MCP client config, the server is
> `npx -y github:takecchi/pixel-ai-artist serve` (npm clones and builds it on
> first use, then caches it). See the [README](../README.md#run-it).

Two pieces: an **Aseprite extension** (so Aseprite can be driven) and an **MCP
server** (so your agent can drive it). The extension is the same in every case;
only the agent wiring differs.

## Requirements

- **Aseprite 1.3 or newer.** The Lua WebSocket API this depends on does not
  exist in 1.2.
- **Node 22.6 or newer.**
- Aseprite must have been **run at least once**, so its config directory exists.

## 1. Install the Aseprite extension

```bash
npx pixel-ai-artist install-extension
```

Then **restart Aseprite**. It connects on startup.

If the config directory cannot be found, the command prints where it looked;
pass `--dir <path>` to override. On macOS it is
`~/Library/Application Support/Aseprite`, on Windows `%APPDATA%\Aseprite`, on
Linux `~/.config/aseprite`.

## 2. Wire up your agent

### Everything at once

```bash
npx pixel-ai-artist install --all --agents
```

Writes config for Claude Code, Codex, Gemini CLI, Cursor, OpenCode, VS Code
and Windsurf, and adds an `AGENTS.md` section for the clients that read one.
Existing config files are backed up first (`.bak-<timestamp>`), and `--dry-run`
prints the change without making it.

### Workflow names

Every client sees the same fourteen workflows under the same names:
`pixel-ai-artist:studio` (the front door — give it any request and it picks and runs
the rest), `pixel-ai-artist:brief`, `pixel-ai-artist:concept`, `pixel-ai-artist:new`, `pixel-ai-artist:palette`, `pixel-ai-artist:draw`,
`pixel-ai-artist:shade`, `pixel-ai-artist:rig`, `pixel-ai-artist:animate`, `pixel-ai-artist:tileset`,
`pixel-ai-artist:review`, `pixel-ai-artist:fix`, `pixel-ai-artist:export`, `pixel-ai-artist:submit`.

| Client | How they appear |
|--------|-----------------|
| Claude Code (plugin) | `/pixel-ai-artist:draw` — plugin skills |
| omp (plugin) | `/pixel-ai-artist:draw` — commands from the omp extension |
| OpenCode (plugin) | `/pixel-ai-artist:draw` — commands from the OpenCode plugin |
| Gemini CLI, Cursor, other prompt-aware MCP clients | MCP prompt `pixel-ai-artist:draw` |
| Codex, and any client without prompts | resource `skill://draw`; the server instructions list the names |

### Claude Code

The plugin is the better route — it brings the `/pixel-ai-artist:*` workflows, the
specialist subagents and the hooks, not just the tools:

```
/plugin marketplace add takecchi/pixel-ai-artist
/plugin install pixel-ai-artist@pixel-ai-artist
```

Or wire the server alone:

```bash
npx pixel-ai-artist install claude
```

### omp (oh-my-pi)

omp installs the same plugin from its own marketplace:

```bash
omp plugin marketplace add takecchi/pixel-ai-artist
omp plugin install pixel-ai-artist@pixel-ai-artist
```

The skills, subagents and MCP server come from the same tree Claude Code reads.
omp does not run Claude's `hooks/hooks.json`, so the plugin ships the two hooks
again as an omp extension (`omp/pixel-ai-artist.mjs`, declared in
`package.json` under `omp.extensions`): the bridge status on the first prompt
and the once-per-session nudge to `look` after a mutating call.

omp lists plugin skills as `/skill:<name>`, so the same extension registers the
`/pixel-ai-artist:*` commands itself, from the same `SKILL.md` files. They inject the
skill as a prompt, with anything typed after the command as the request.

omp also imports Claude Code's plugins. Install it in omp under the same ID as
in Claude Code — omp's registry wins for a shared ID, so this replaces the
imported copy instead of starting a second server. For the same reason, do not
also run `install claude`: omp reads `~/.claude.json` too, and you would load
every tool twice.

From a checkout, point the marketplace at the directory instead:

```bash
omp plugin marketplace add /path/to/pixel-ai-artist
omp plugin install pixel-ai-artist@pixel-ai-artist
```

omp copies the tree into its plugin cache, so after changing it run
`omp plugin marketplace update pixel-ai-artist` and
`omp plugin install --force pixel-ai-artist@pixel-ai-artist`, then restart
the session.

### Codex CLI

```bash
npx pixel-ai-artist install codex
```

Writes `[mcp_servers.pixel-ai-artist]` into `~/.codex/config.toml`. Codex uses
TOML — the JSON config from other clients will not work, which is a common
source of "it silently does nothing".

Codex does not expose MCP **prompts**, so the skills do not appear as commands
there. It does read MCP **resources**, which is where the same skill content
lives (`skill://draw` and friends), and in practice it finds and follows
them on its own — verified against Codex CLI 0.145.0.

### Gemini CLI

```bash
npx pixel-ai-artist install gemini
```

### Cursor

```bash
npx pixel-ai-artist install cursor
```

### OpenCode

```bash
npx pixel-ai-artist install opencode
```

Writes `mcp.servers.pixel-ai-artist` into
`~/.config/opencode/opencode.json`. That is OpenCode 2.x's native config shape,
and the plugin below is 2.x-only too. OpenCode 1.x cannot read a file in that
shape, so on 1.x — including after `install --all` — skip this target and put
the same entry directly under `mcp` as `mcp.pixel-ai-artist`, without the
`servers` level. On 2.x, add the plugin — it brings the `/pixel-ai-artist:*` commands,
the skills and the two hooks:

```bash
opencode plugin add github:takecchi/pixel-ai-artist::path:opencode
```

From a checkout, point at the directory instead:

```jsonc
{ "plugins": ["/path/to/pixel-ai-artist/opencode"] }
```

MCP prompts are off for this client on purpose: the plugin already lists the
fourteen workflows, and the prompts would double every one of them. Without the
plugin the skills still reach the model as `skill://` resources, like Codex.

### Project scope instead of user scope

```bash
npx pixel-ai-artist install codex cursor --project
```

Writes into the current directory (`.codex/config.toml`, `.cursor/mcp.json`) so
the setup travels with the repository.

### Headless: no Aseprite window

```bash
npx pixel-ai-artist install codex --headless --aseprite /path/to/aseprite
```

Writes `PIXEL_AI_HEADLESS=1` (and `ASEPRITE_PATH`) into the client config.
The server then runs one batch Aseprite (`aseprite -b`) itself; neither the
extension nor the bridge is involved. For the Claude Code, omp and OpenCode
plugins, set `PIXEL_AI_HEADLESS=1` — and `ASEPRITE_PATH` if Aseprite is not in
a standard place — in the environment the agent is started from.

One variable belongs to Aseprite itself: `lua.run` refuses unless the Aseprite
process carries `PIXEL_AI_ALLOW_LUA=1`. A headless server passes it to the
batch process when started with `--allowLua`; a live session needs it on
Aseprite's own environment. See
[SECURITY](../SECURITY.md#run_lua).

Without `--aseprite`/`ASEPRITE_PATH` the server looks in the standard and Steam
install locations, then on `PATH`. `doctor` prints the one it would use:

```
✓ Aseprite executable   /Applications/Aseprite.app/Contents/MacOS/aseprite (used by --headless)
```

Documents live in memory until saved (`sprite_manage` `save`/`save_as`) or
exported — the agent is told so by `preflight`.

## 3. Check it

```bash
npx pixel-ai-artist doctor
```

```
pixel-ai-artist 0.1.0

✓ Aseprite config dir   /Users/you/Library/Application Support/Aseprite
✓ Bridge                 ws://127.0.0.1:9942
✓ Aseprite extension     0.1.0 on Aseprite 1.3.17-arm64
  features               draw_batch, recolor, validate, tileset, reference, filmstrip
✓ Active sprite          knight.aseprite
```

Then restart your agent so it picks up the new server, and ask it to call
`preflight`.

## Troubleshooting

**"Aseprite extension not connected"** — Aseprite is closed, or the extension is
not installed, or it was installed while Aseprite was running. Install, then
restart Aseprite. Check `Edit ▸ Preferences ▸ Extensions` for
`Pixel AI Artist`.

To tell "never loaded" apart from "loaded but could not connect", look for the
marker the extension writes on startup:

```
<Aseprite config dir>/pixel-ai-artist.status
```

No file at all means Aseprite never ran the script — the extension is not
installed or not enabled. `"state": "loaded"` means it ran but never reached the
bridge. `"state": "connected"` means the link is up and the problem is
elsewhere.

**A dialog is blocking startup** — Aseprite gates script access to the network
and filesystem, and a brand-new config directory also shows a first-run dialog.
Either will stop the extension from connecting until dismissed. If this is the
very first time Aseprite has run on this machine, open it once and dismiss
whatever it asks before installing.

**The agent draws nothing and reports success** — it is editing files on disk
instead of the live window. That should be impossible: every tool refuses with
`not_connected` and `doNotFallBackToDisk`. If you see it, please open an issue
with the transcript.

**Ports already in use** — something else owns 9941/9942. Move both:

```bash
npx pixel-ai-artist install --all --plugin-port 9941 --control-port 9942
```

and set `PIXEL_AI_PLUGIN_PORT` in Aseprite's environment to match.

**A reconnect is not happening** — the extension's reconnect timer runs on
Aseprite's UI loop. Click the Aseprite window once. A connection that is already
live keeps working unfocused; only re-establishing a dropped one needs focus.

## Running from a checkout

```bash
git clone https://github.com/takecchi/pixel-ai-artist
cd pixel-ai-artist
pnpm install && pnpm run build
node dist/cli.js install --all
node dist/cli.js install-extension
```

Use `node dist/cli.js`, not `npx pixel-ai-artist`, and only inside
this checkout. npm sees that the current project *is* that package, so it skips
fetching it and looks for the binary in `node_modules/.bin` — where a package's
own bin is never linked. You get:

```
sh: pixel-ai-artist: command not found
```

which reads like a broken package and is only ever a wrong working directory.
The `npx` form is correct everywhere else.

## Uninstall

Delete the `pixel-ai-artist` directory from Aseprite's `extensions` folder,
remove the server entry from your agent's config (in omp:
`omp plugin uninstall pixel-ai-artist@pixel-ai-artist`), and stop any
running bridge:

```bash
pkill -f "pixel-ai-artist bridge"    # macOS / Linux
```

On Windows there is no `pkill` — end the `node` process running
`pixel-ai-artist bridge` from Task Manager, or:

```powershell
Get-CimInstance Win32_Process |
  Where-Object CommandLine -like '*pixel-ai-artist*bridge*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```
