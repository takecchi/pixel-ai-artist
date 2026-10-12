# Skills

Workflows an agent follows, in the order that catches mistakes while they are
still cheap. Each one is a procedure, not a description.

They are served from this one directory, under the same `pixel-ai-artist:<name>`
names everywhere:

- **Claude Code** loads them as plugin skills (`/pixel-ai-artist:draw`); **omp** gets
  the same commands from the plugin's omp extension.
- **Any MCP client** reads them as `skill://<name>` resources and can invoke
  them as MCP prompts named `pixel-ai-artist:<name>` — so Codex, Gemini CLI and Cursor
  get the same workflows.
- **The server instructions** list them, so an agent knows they exist without
  being told.

| Skill | Use when |
|-------|----------|
| `pixel-ai-artist:studio` | Any request — picks, orders and runs the others; the default entry point |
| `pixel-ai-artist:brief` | The request is open-ended and needs decisions before drawing |
| `pixel-ai-artist:concept` | Anything new: art spec → image-model prompt for a concept sheet or storyboard → import it as a reference |
| `pixel-ai-artist:new` | Starting a fresh document |
| `pixel-ai-artist:palette` | Choosing, building or repairing colours |
| `pixel-ai-artist:draw` | The main drawing work |
| `pixel-ai-artist:shade` | Flat art needs volume |
| `pixel-ai-artist:rig` | A character needs to be animatable |
| `pixel-ai-artist:animate` | Building a cycle |
| `pixel-ai-artist:tileset` | Level art and anything that repeats |
| `pixel-ai-artist:review` | Before saying anything is finished |
| `pixel-ai-artist:fix` | Editing art that already exists |
| `pixel-ai-artist:export` | Handing files to a game engine |
| `pixel-ai-artist:submit` | Sharing a finished sprite to the community gallery as a pull request |

Skills reference `rules://` rather than restating craft, so a rule has exactly
one place to be wrong.
