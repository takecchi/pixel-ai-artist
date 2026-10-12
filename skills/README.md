# Skills

Workflows an agent follows, in the order that catches mistakes while they are
still cheap. Each one is a procedure, not a description.

They are served from this one directory, under the same `libresprite:<name>`
names everywhere:

- **Claude Code** loads them as plugin skills (`/libresprite:draw`); **omp** gets
  the same commands from the plugin's omp extension.
- **Any MCP client** reads them as `skill://<name>` resources and can invoke
  them as MCP prompts named `libresprite:<name>` — so Codex, Gemini CLI and Cursor
  get the same workflows.
- **The server instructions** list them, so an agent knows they exist without
  being told.

| Skill | Use when |
|-------|----------|
| `libresprite:studio` | Any request — picks, orders and runs the others; the default entry point |
| `libresprite:brief` | The request is open-ended and needs decisions before drawing |
| `libresprite:concept` | Anything new: art spec → image-model prompt for a concept sheet or storyboard → import it as a reference |
| `libresprite:new` | Starting a fresh document |
| `libresprite:palette` | Choosing, building or repairing colours |
| `libresprite:draw` | The main drawing work |
| `libresprite:shade` | Flat art needs volume |
| `libresprite:rig` | A character needs to be animatable |
| `libresprite:animate` | Building a cycle |
| `libresprite:tileset` | Level art and anything that repeats |
| `libresprite:review` | Before saying anything is finished |
| `libresprite:fix` | Editing art that already exists |
| `libresprite:export` | Handing files to a game engine |
| `libresprite:submit` | Sharing a finished sprite to the community gallery as a pull request |

Skills reference `rules://` rather than restating craft, so a rule has exactly
one place to be wrong.
