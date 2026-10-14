import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOOK_NUDGE, loadSkillCommands, skillPrompt } from "../hooks/shared.mjs";

const OWN_DIR = path.dirname(fileURLToPath(import.meta.url));

export function isPixelMutation(toolName) {
  return typeof toolName === "string" && /^pixel(-ai-artist)?_(draw|recolor|transform)$/.test(toolName);
}

// Sibling tree first (checkout, and git layouts that keep it); then the npm
// package if the host happens to have it; otherwise null and setup stays alive.
export function resolveSkillsDir(pluginDir = OWN_DIR) {
  const sibling = path.join(pluginDir, "..", "skills");
  if (existsSync(path.join(sibling, "studio", "SKILL.md"))) return path.resolve(sibling);
  try {
    const pkg = createRequire(import.meta.url).resolve("pixel-ai-artist/package.json");
    const bundled = path.join(path.dirname(pkg), "skills");
    if (existsSync(path.join(bundled, "studio", "SKILL.md"))) return bundled;
  } catch { /* not installed — the caller reports */ }
  return null;
}

export default {
  id: "pixel-ai-artist",
  async setup(ctx) {
    const skillsDir = resolveSkillsDir();
    if (!skillsDir) {
      // A plugin load must not take the session down; the MCP tools and
      // resources work without us.
      process.stderr.write("[pixel-ai-artist] skills not found next to the plugin; /pixel-ai-artist:* commands and skills are skipped. See docs/INSTALL.md.\n");
      return;
    }
    const commands = loadSkillCommands(skillsDir);
    // The one look-nudge per session, split across two hooks: `execute.after`
    // detects the pixel mutation, and `context` delivers the reminder into the
    // next model call's system prompt. See the note on the `context` hook below
    // for why delivery does not happen in `execute.after` itself.
    const nudged = new Set();
    const pendingNudge = new Set();

    await ctx.skill.transform((editor) => {
      for (const command of commands) {
        editor.add({
          id: command.skill,
          name: command.skill,
          description: command.description,
          path: path.join(skillsDir, command.skill, "SKILL.md"),
          content: command.body,
        });
      }
    });

    await ctx.command.transform((editor) => {
      for (const command of commands) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({ ...prompt, sessionID, text: skillPrompt(command, prompt.text ?? ""), delivery });
          },
        });
      }
    });

    await ctx.session.hook("context", async (event) => {
      if (pendingNudge.has(event.sessionID)) {
        pendingNudge.delete(event.sessionID);
        nudged.add(event.sessionID);
        event.system.push({ type: "text", text: LOOK_NUDGE });
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      // Delivery happens on the next `context` hook, not here. OpenCode hands a
      // tool result back to the model two ways: the direct tool-call path keeps
      // the `content` blocks, but Code Mode — the build agent's default — decodes
      // only the structured `output` and drops anything appended to `content`, so
      // mutating `event.result` here never reaches the model on that path. The
      // `context` hook is prepended to every model call on both paths, so it is
      // the one reliable channel.
      if (event.status !== "completed" || !isPixelMutation(event.tool)) return;
      if (nudged.has(event.sessionID) || pendingNudge.has(event.sessionID)) return;
      // A malformed result must not spend the session's one nudge.
      if (!Array.isArray(event.result?.content)) return;
      pendingNudge.add(event.sessionID);
    });
  },
};
