# Install

One piece: an **MCP server** your agent starts. It draws into documents it
keeps in memory and writes image files, so there is no editor to install and
nothing to keep open.

## Requirements

- **Node 22.6 or newer.**
- **git**, until the package is on npm.

## 1. Get the server

`pixel-ai-artist` is **not published on npm yet**. Until it is, there are three
routes, and none needs a release:

| Route | For | How |
|-------|-----|-----|
| **Plugin** | Claude Code, omp | `/plugin marketplace add takecchi/pixel-ai-artist` — see [Claude Code](#claude-code) and [omp](#omp-oh-my-pi). Brings the skills, subagents and hook too. |
| **From GitHub** | Any MCP client | Name `npx -y github:takecchi/pixel-ai-artist serve` as the server. npm clones and builds it on first start (ten to thirty seconds, depending on the machine and the network), then caches it (two or three). Pin a version with `#<branch, tag or commit>`. |
| **A checkout** | Working on the server itself | `git clone`, then `npm ci` (which builds); the server is `node /path/to/pixel-ai-artist/dist/cli.js serve`, and `node dist/cli.js install <client> --local` writes it into a client's config. |

The GitHub route, in a JSON client config:

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

`install` (below) writes `npx -y pixel-ai-artist@latest serve` by default, which
starts only once the package is published. Until then, either:

- write the GitHub entry by hand —
  `npx -y github:takecchi/pixel-ai-artist install <client> --dry-run` prints the
  file and the exact entry each client wants; swap in the GitHub `command` and
  `args` above; or
- from a checkout, run `node dist/cli.js install <client> --local` (or
  `--all --local`). It writes entries that start this checkout's build by
  absolute path, and refuses a checkout that has not been built. After pulling
  changes, `npm run build` again; the entries keep pointing at the same place.

## 2. Wire up your agent

The `npx pixel-ai-artist …` commands below work as written once the package is
on npm; until then, `npx -y github:takecchi/pixel-ai-artist …` runs the same
command, and see step 1 for the entries `install` writes.

### Everything at once

```bash
npx pixel-ai-artist install --all --agents
```

Writes config for Claude Code, Codex, Gemini CLI, Cursor, OpenCode, VS Code
and Windsurf, and adds an `AGENTS.md` section for the clients that read one.
Existing config files are backed up first (`.bak-<timestamp>`); a file that
already holds exactly the new content is left alone, with no backup. `--dry-run`
prints, for each client, the file and the entry under the key it goes in
(`mcpServers`, `servers`, `mcp.servers` or the TOML table), and writes nothing.

`--agents` takes an optional path, and `--dir` a required one; neither takes a
client name as its value, so `install --agents codex` installs Codex with the
default `AGENTS.md`. To pass a path that is also a client name, write
`--agents=<path>` or `--dir=<path>`. An unknown option is refused rather than
ignored. A client that fails is reported on stderr, the command exits 1, and
the others are still written.

### Workflow names

Every client sees the same twelve workflows under the same names:
`pixel-ai-artist:studio` (the front door — give it any request and it picks and runs
the rest), `pixel-ai-artist:brief`, `pixel-ai-artist:concept`, `pixel-ai-artist:new`, `pixel-ai-artist:palette`, `pixel-ai-artist:draw`,
`pixel-ai-artist:shade`, `pixel-ai-artist:rig`, `pixel-ai-artist:animate`,
`pixel-ai-artist:review`, `pixel-ai-artist:fix`, `pixel-ai-artist:export`.

| Client | How they appear |
|--------|-----------------|
| Claude Code (plugin) | `/pixel-ai-artist:draw` — plugin skills |
| omp (plugin) | `/pixel-ai-artist:draw` — commands from the omp extension |
| OpenCode (plugin) | `/pixel-ai-artist:draw` — commands from the OpenCode plugin |
| Gemini CLI, Cursor, other prompt-aware MCP clients | MCP prompt `pixel-ai-artist:draw` |
| Codex, and any client without prompts | resource `skill://draw`; the server instructions list the names |

### Claude Code

The plugin is the better route — it brings the `/pixel-ai-artist:*` workflows, the
specialist subagents and the look hook, not just the tools:

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
omp does not run Claude's `hooks/hooks.json`, so the plugin ships its hook
again as an omp extension (`omp/pixel-ai-artist.mjs`, declared in
`package.json` under `omp.extensions`): the once-per-session nudge to `look`
after a mutating call.

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
source of "it silently does nothing". A reinstall replaces that table and its
sub-tables (`[mcp_servers.pixel-ai-artist.env]`) and leaves every other table
as it was, including ones whose names merely start the same way.
When `CODEX_HOME` is set and not empty, the file is `$CODEX_HOME/config.toml`
instead, the same one Codex reads.

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
the skills and the look hook:

```bash
opencode plugin add github:takecchi/pixel-ai-artist::path:opencode
```

From a checkout, point at the directory instead:

```jsonc
{ "plugins": ["/path/to/pixel-ai-artist/opencode"] }
```

MCP prompts are off for this client on purpose: the plugin already lists the
twelve workflows, and the prompts would double every one of them. Without the
plugin the skills still reach the model as `skill://` resources, like Codex.

### Project scope instead of user scope

```bash
npx pixel-ai-artist install codex cursor --project
```

Writes into the current directory (`.codex/config.toml`, `.cursor/mcp.json`) so
the setup travels with the repository; `--dir <path>` names another one.

Two clients ignore the scope. VS Code is always written to the project
(`.vscode/mcp.json`), and Windsurf always to the user file
(`~/.codeium/windsurf/mcp_config.json`), with or without `--project`.

## 3. Check it

```bash
node dist/cli.js doctor          # in the checkout; npx pixel-ai-artist doctor once published
```

```
pixel-ai-artist 0.1.0
Node 22.23.3
```

Then restart your agent so it picks up the new server, and ask it to call
`preflight`. Documents live in the server's memory until the agent saves them
(`sprite_manage` `save` / `save_as`) or exports them — `preflight` tells it
so.

## Once it is on npm: `npx` inside the checkout

Inside a checkout of this repository keep using `node dist/cli.js`, not
`npx pixel-ai-artist`. npm sees that the current project *is* that package, so it skips
fetching it and looks for the binary in `node_modules/.bin` — where a package's
own bin is never linked. You get:

```
sh: pixel-ai-artist: command not found
```

which reads like a broken package and is only ever a wrong working directory.
The `npx` form is correct everywhere else.

## Uninstall

Remove the server entry from your agent's config, or uninstall the plugin
(`/plugin uninstall pixel-ai-artist@pixel-ai-artist` in Claude Code,
`omp plugin uninstall pixel-ai-artist@pixel-ai-artist` in omp). There is no
other process or file to clean up.
