/**
 * Shared text and the skill-command loader, kept in one file so harnesses do
 * not drift. Three harnesses read it: Claude Code runs the scripts next to
 * this file from `hooks.json`, omp loads `omp/pixel-ai-artist.mjs` as an
 * extension, and OpenCode loads `opencode/index.mjs` as a plugin. The wording
 * and the probe must not drift between them.
 */

import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_BUDGET_MS = 400;

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_BUDGET_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Deliberately cheap: a raw TCP connect to the bridge's control port, no
 * dependencies, hard 400ms budget. A hook that slows session start is a hook
 * people disable. Never rejects.
 */
export async function bridgeStatusMessage() {
  // Headless sessions have no bridge by design; probing for one would tell
  // the model to go fix a setup that is not broken.
  if (/^(1|true|yes)$/.test(process.env.PIXEL_AI_HEADLESS ?? "")) {
    return "pixel-ai-artist: headless mode — a batch Aseprite starts on the first tool call and there is no window. Call preflight first, and save with sprite_manage before finishing.";
  }
  const controlPort = Number(process.env.PIXEL_AI_CONTROL_PORT || 9942);
  const bridge = await probe(controlPort);
  // The control port being open means the bridge is up, not that Aseprite has
  // connected — only `preflight` can answer that, so say so rather than
  // implying a readiness this probe cannot see.
  return bridge
    ? `pixel-ai-artist: bridge is up on :${controlPort}. Call preflight before any drawing to confirm Aseprite itself is attached.`
    : `pixel-ai-artist: no bridge on :${controlPort} yet — it starts on the first tool call. If drawing fails, run \`npx pixel-ai-artist doctor\`.`;
}

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
