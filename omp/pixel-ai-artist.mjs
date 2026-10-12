/**
 * omp (oh-my-pi) extension: the omp half of `hooks/hooks.json`.
 *
 * omp installs this repository as a marketplace plugin and picks up the
 * skills, agents and MCP server from the same tree Claude Code uses — but it
 * does not run Claude's `hooks.json`. This module restores the hook there
 * with omp's event API, so neither harness gets less discipline than the other:
 *
 * - PostToolUse on draw/recolor/transform → the "look at it" nudge, appended to
 *   the first successful mutating result of the session.
 *
 * Plain `.mjs` with no imports from omp: a plugin cloned from git has no build
 * step and no dev dependencies, and the handlers only use the event payloads.
 */

import { LOOK_NUDGE, loadSkillCommands, skillPrompt } from "../hooks/shared.mjs";

// Claude names plugin MCP tools `mcp__plugin_pixel-ai-artist_pixel-ai-artist__draw`; omp
// names the same tool `mcp__pixel-ai-artist_pixel-ai-artist_draw`, and a server wired by hand
// as `pixel-ai-artist` gives `mcp__pixel-ai-artist__draw`.
const PIXEL_MUTATION = /^mcp__.*pixel-ai-artist.*_(?:draw|recolor|transform)$/;

export function isPixelMutation(toolName) {
  return typeof toolName === "string" && PIXEL_MUTATION.test(toolName);
}

export default function pixelAiArtist(pi) {
  let nudged = false;

  const reset = () => {
    nudged = false;
  };
  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  for (const command of loadSkillCommands()) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: async (args, ctx) => {
        await pi.sendUserMessage(skillPrompt(command, args ?? ""));
        // Print/RPC runs exit when the command returns; wait for the turn it started.
        await ctx?.waitForIdle?.();
      },
    });
  }

  // Once per session: a reminder the model sees on every draw becomes noise it
  // learns to skip.
  pi.on("tool_result", async (event) => {
    if (nudged || event.isError || !isPixelMutation(event.toolName)) return;
    nudged = true;
    return { content: [...event.content, { type: "text", text: LOOK_NUDGE }] };
  });
}
