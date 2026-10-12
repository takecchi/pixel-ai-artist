/**
 * Shared text and the skill-command loader, kept in one file so harnesses do
 * not drift. Three harnesses read it: Claude Code runs the scripts next to
 * this file from `hooks.json`, omp loads `omp/pixel-ai-artist.mjs` as an
 * extension, and OpenCode loads `opencode/index.mjs` as a plugin. The wording
 * must not drift between them.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOOK_NUDGE =
  "You just changed pixels. Call `look` before deciding whether it worked — op 'preview' for the overall read, op 'ascii' for exact pixel positions. A tool result saying pixels changed is not evidence that the sprite is right.";

// The SKILL.md command loader lives here, not in a harness file, so every
// harness that registers `/pixel-ai-artist:<workflow>` commands reads them identically.
const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

/**
 * Command definitions for every skill, consumed by the harnesses that cannot
 * derive `/pixel-ai-artist:<name>` from the skills themselves. Claude Code and MCP
 * clients already surface the workflows as `/pixel-ai-artist:<name>` prompts, but omp
 * lists plugin skills as `/skill:<name>` and OpenCode lists them as bare
 * `skill://<name>` skills — so omp and OpenCode both register these names as
 * commands, from the same SKILL.md files.
 */
export function loadSkillCommands(dir = SKILLS_DIR) {
  const commands = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let raw;
    try {
      raw = readFileSync(path.join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const description = match?.[1].match(/^description:\s*(.+)$/m)?.[1].trim() ?? entry.name;
    commands.push({
      name: `pixel-ai-artist:${entry.name}`,
      skill: entry.name,
      description,
      body: match ? raw.slice(match[0].length).trim() : raw.trim(),
    });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillPrompt(command, args) {
  const request = args.trim();
  return [
    `Follow the \`${command.name}\` workflow below (also at skill://${command.skill}).`,
    "",
    command.body,
    ...(request ? ["", `User request: ${request}`] : []),
  ].join("\n");
}
