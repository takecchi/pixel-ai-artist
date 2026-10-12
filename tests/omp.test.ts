import { strict as assert } from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
// @ts-ignore — plain .mjs on purpose: omp loads it from a git clone with no build step.
import extension, { isPixelMutation } from "../omp/pixel-ai-artist.mjs";
// @ts-ignore
import { LOOK_NUDGE, loadSkillCommands, skillPrompt } from "../hooks/shared.mjs";

// Nothing listens here, so the status probe answers fast and never touches a
// real Aseprite session.
process.env.PIXEL_AI_CONTROL_PORT = "19961";

type Handler = (event?: unknown) => unknown;

function load() {
  const handlers = new Map<string, Handler>();
  extension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerCommand: () => {},
    sendUserMessage: () => {},
  });
  const emit = (name: string, event?: unknown) => {
    const fn = handlers.get(name);
    assert.ok(fn, `extension registers ${name}`);
    return fn(event);
  };
  return { emit };
}

const text = (t: string) => ({ type: "text", text: t });
const result = (toolName: string, isError = false) => ({
  type: "tool_result",
  toolName,
  toolCallId: "1",
  input: {},
  content: [text("412 pixels changed")],
  isError,
});

test("every skill becomes an /pixel-ai-artist:<workflow> command carrying its body", () => {
  const commands = loadSkillCommands();
  // Every skill directory on disk, not a hardcoded count: a new skill that the
  // omp extension silently skipped is the bug this test exists to catch.
  const onDisk = readdirSync(new URL("../skills/", import.meta.url)).filter((name) =>
    existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
  );
  assert.deepEqual(commands.map((c: { name: string }) => c.name).sort(), onDisk.map((n) => `pixel-ai-artist:${n}`).sort());
  assert.ok(commands.some((c: { name: string }) => c.name === "pixel-ai-artist:studio"));
  const draw = commands.find((c: { name: string }) => c.name === "pixel-ai-artist:draw");
  assert.ok(draw, "draw maps to pixel-ai-artist:draw");
  assert.ok(!draw.body.startsWith("---"), "frontmatter is stripped");
  assert.ok(!draw.description.startsWith("description"), "description is parsed");
  const prompt = skillPrompt(draw, " a knight ");
  assert.ok(prompt.includes(draw.body));
  assert.ok(prompt.endsWith("User request: a knight"));
  assert.ok(!skillPrompt(draw, "").includes("User request"));
});

test("mutating tools match under both harnesses' MCP naming", () => {
  for (const name of [
    "mcp__pixel-ai-artist_pixel-ai-artist_draw",
    "mcp__pixel-ai-artist_pixel-ai-artist_recolor",
    "mcp__pixel-ai-artist_pixel-ai-artist_transform",
    "mcp__plugin_pixel-ai-artist_pixel-ai-artist__draw",
    "mcp__pixel-ai-artist_draw",
  ]) {
    assert.equal(isPixelMutation(name), true, name);
  }
  for (const name of [
    "mcp__pixel-ai-artist_pixel-ai-artist_look",
    "mcp__pixel-ai-artist_pixel-ai-artist_draw_extra",
    "mcp__other_draw",
    "write",
    undefined,
  ]) {
    assert.equal(isPixelMutation(name), false, String(name));
  }
});

test("look nudge is appended once per session, only after a successful mutation", async () => {
  const { emit } = load();
  emit("session_start", { type: "session_start" });

  assert.equal(await emit("tool_result", result("mcp__pixel-ai-artist_pixel-ai-artist_look")), undefined);
  assert.equal(await emit("tool_result", result("mcp__pixel-ai-artist_pixel-ai-artist_draw", true)), undefined);

  const first = (await emit("tool_result", result("mcp__pixel-ai-artist_pixel-ai-artist_draw"))) as {
    content: unknown[];
  };
  assert.deepEqual(first.content, [text("412 pixels changed"), text(LOOK_NUDGE)]);
  assert.equal(await emit("tool_result", result("mcp__pixel-ai-artist_pixel-ai-artist_recolor")), undefined);

  emit("session_start", { type: "session_start" });
  assert.ok(await emit("tool_result", result("mcp__pixel-ai-artist_pixel-ai-artist_transform")));
});

test("bridge status reaches the model once per session, hidden from the transcript", async () => {
  const { emit } = load();
  emit("session_start", { type: "session_start" });

  const first = (await emit("before_agent_start", { prompt: "draw a knight" })) as {
    message: { content: string; display: boolean };
  };
  assert.match(first.message.content, /no bridge on :19961/);
  assert.equal(first.message.display, false);
  assert.equal(await emit("before_agent_start", { prompt: "now shade it" }), undefined);

  emit("session_switch", { type: "session_switch" });
  assert.ok(await emit("before_agent_start", { prompt: "resumed" }));
});
