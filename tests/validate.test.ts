import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { paletteStats } from "../dist/doc/stats.js";
import { ToolError, createStudio, rgba, type Studio } from "../dist/doc/index.js";

type Reply = { sprite: string; findings: Record<string, unknown>[] };

const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);
const BLACK = rgba(0, 0, 0);

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

function sketch(studio: Studio, width: number, height: number, pixels: [number, number, number][], opts = {}) {
  const sprite = studio.addSprite({ width, height, filename: "/tmp/hero.aseprite", ...opts });
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  for (const [x, y, v] of pixels) cel.image.set(x, y, v);
  return { sprite, cel };
}

async function run(studio: Studio, args: Record<string, unknown> = {}) {
  return (await studio.call<Reply>("validate.run", args)).findings;
}

/** A solid w x h block of one colour at (x0, y0). */
function block(x0: number, y0: number, w: number, h: number, v: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y, v]);
  return out;
}

test("a fresh unsaved sprite is told its layer is empty and that nothing is on disk, and nothing else", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 8, height: 8 });
  const r = await studio.call<Reply>("validate.run");
  assert.equal(r.sprite, "Sprite");
  assert.deepEqual(r.findings, [
    { check: "layers", severity: "note", message: "Layer 'Layer 1' has no cels on any frame.", layer: "Layer 1" },
    {
      check: "export_readiness",
      severity: "warning",
      message:
        "Sprite has never been saved as a document; files written by export do not count here. " +
        "To keep its layers and tags on disk, save_as an .aseprite file — a .png or .gif keeps only how it looks.",
    },
  ]);
});

test("after an export, export_readiness still flags an unsaved document, says exports do not count and points at .aseprite", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 2, height: 2 });
  const dir = mkdtempSync(path.join(tmpdir(), "pixel-ai-artist-readiness-"));
  await studio.call("export.run", { op: "png", path: path.join(dir, "out.png") });
  const [finding] = await run(studio, { checks: ["export_readiness"] });
  assert.equal(finding?.severity, "warning");
  assert.match(String(finding?.message), /files written by export do not count/);
  assert.match(String(finding?.message), /save_as an \.aseprite file/);
  assert.doesNotMatch(String(finding?.message), /nothing on disk/);
});

test("palette: off-palette colours are counted and the most used is named", async () => {
  const studio = createStudio();
  sketch(
    studio, 6, 1,
    [[0, 0, BLACK], [1, 0, RED], [2, 0, RED], [3, 0, RED], [4, 0, GREEN]],
    { palette: [BLACK] },
  );
  assert.deepEqual(await run(studio, { checks: ["palette"] }), [
    {
      check: "palette",
      severity: "warning",
      message:
        "2 colour(s) in the art are not in the palette; the most used is #ff0000 (3px). Run recolor op 'snap' to bring them in line.",
      count: 2,
    },
  ]);
});

test("palette: more than 64 entries earns a note, 64 does not", async () => {
  const studio = createStudio();
  const many = (n: number) => Array.from({ length: n }, (_, i) => rgba(i, 0, 0));
  sketch(studio, 1, 1, [], { palette: many(64) });
  assert.deepEqual(await run(studio, { checks: ["palette"] }), []);
  const big = createStudio();
  sketch(big, 1, 1, [], { palette: many(65) });
  assert.deepEqual(await run(big, { checks: ["palette"] }), [
    {
      check: "palette",
      severity: "note",
      message:
        "65 palette entries. Most sprites read better under 32 — a large palette usually means ramps that were never merged.",
      count: 65,
    },
  ]);
});

test("paletteStats lists every entry's usage, compares by #rrggbb, counts hidden layers, and sorts off-palette colours by use", async () => {
  const studio = createStudio();
  const { sprite } = sketch(
    studio, 4, 1,
    [[0, 0, RED], [1, 0, BLUE], [2, 0, BLUE], [3, 0, rgba(0, 255, 0, 100)]],
    { palette: [rgba(255, 0, 0, 128), BLACK] },
  );
  const hidden = studio.addLayer(sprite, "hidden");
  hidden.visible = false;
  const hiddenCel = studio.ensureCel(sprite, hidden, 1);
  hiddenCel.image.set(0, 0, GREEN);
  hiddenCel.image.set(1, 0, GREEN);
  assert.deepEqual(paletteStats(sprite), {
    sprite: "hero.aseprite",
    colors: ["#ff000080", "#000000"],
    usage: [
      { index: 0, hex: "#ff000080", pixels: 1 },
      { index: 1, hex: "#000000", pixels: 0 },
    ],
    // Green is drawn twice on the hidden layer and once at 100 alpha; blue twice.
    offPalette: [
      { hex: "#00ff00", pixels: 3 },
      { hex: "#0000ff", pixels: 2 },
    ],
  });
});

test("strays: an isolated pixel is a warning at its canvas position, more than three are an error", async () => {
  const studio = createStudio();
  const { cel } = sketch(studio, 8, 8, [[1, 1, RED], ...block(4, 4, 2, 2, RED)]);
  cel.x = 0;
  assert.deepEqual(await run(studio, { checks: ["strays"] }), [
    {
      check: "strays",
      severity: "warning",
      message: "1 isolated pixel(s) with no neighbour on 'Layer 1' frame 1. These read as noise at 1x.",
      layer: "Layer 1",
      frame: 1,
      at: { x: 1, y: 1 },
      count: 1,
    },
  ]);

  const noisy = createStudio();
  sketch(noisy, 8, 8, [[0, 0, RED], [2, 0, RED], [4, 0, RED], [6, 0, RED]]);
  const f = (await run(noisy, { checks: ["strays"] }))[0]!;
  assert.equal(f.severity, "error");
  assert.equal(f.count, 4);
  assert.deepEqual(f.at, { x: 0, y: 0 });
});

test("strays reports positions in canvas coordinates when the cel is offset", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 8, 8, []);
  cel.image = studio.newImage(sprite, 3, 3);
  cel.image.set(1, 2, RED);
  cel.x = 4;
  cel.y = 3;
  const f = (await run(studio, { checks: ["strays"] }))[0]!;
  assert.deepEqual(f.at, { x: 5, y: 5 });
});

test("outline: a 75% black edge with one red pixel is a broken outline located at the odd pixel", async () => {
  const studio = createStudio();
  sketch(studio, 4, 4, [[1, 1, BLACK], [2, 1, BLACK], [1, 2, BLACK], [2, 2, RED]]);
  assert.deepEqual(await run(studio, { checks: ["outline"] }), [
    {
      check: "outline",
      severity: "warning",
      message:
        "Outline is 75% '#000000' but 1 edge pixel(s) use a different colour on 'Layer 1'. A broken outline reads as a hole in the silhouette.",
      layer: "Layer 1",
      frame: 1,
      at: { x: 2, y: 2 },
      count: 1,
    },
  ]);
});

test("outline: a silhouette no colour owns is only a note, and a clean outline says nothing", async () => {
  const studio = createStudio();
  sketch(studio, 4, 4, [[1, 1, BLACK], [2, 1, RED], [1, 2, GREEN], [2, 2, BLUE]]);
  assert.deepEqual(await run(studio, { checks: ["outline"] }), [
    {
      check: "outline",
      severity: "note",
      message:
        "No single colour owns the silhouette edge on 'Layer 1', so this sprite is not outlined. That is a valid style — just keep it consistent.",
      layer: "Layer 1",
      frame: 1,
    },
  ]);
  const clean = createStudio();
  sketch(clean, 5, 5, [...block(1, 1, 3, 3, BLACK).filter(([x, y]) => x !== 2 || y !== 2), [2, 2, RED]]);
  assert.deepEqual(await run(clean, { checks: ["outline"] }), [], "the interior does not count as edge");
});

test("banding: a 24-pixel straight boundary is reported with where it starts", async () => {
  const studio = createStudio();
  const px = [...block(0, 0, 24, 1, rgba(170, 0, 0)), ...block(0, 1, 24, 1, rgba(0, 0, 170))];
  sketch(studio, 24, 2, px);
  assert.deepEqual(await run(studio, { checks: ["banding"] }), [
    {
      check: "banding",
      severity: "note",
      message:
        "A 24-pixel straight boundary between #aa0000 and #0000aa on 'Layer 1'. Let the edge wander, or dither part of it, so it reads as a surface rather than a contour line.",
      layer: "Layer 1",
      frame: 1,
      at: { x: 0, y: 0 },
      count: 24,
    },
  ]);
});

test("banding: a boundary shorter than max(8, width/3) is fine", async () => {
  const studio = createStudio();
  // Width 24 needs 8; a 7-pixel boundary does not qualify.
  sketch(studio, 24, 2, [...block(0, 0, 7, 1, RED), ...block(0, 1, 7, 1, BLUE)]);
  assert.deepEqual(await run(studio, { checks: ["banding"] }), []);
});

test("antialiasing: semi-transparent pixels are counted in rgb and grayscale, never in indexed", async () => {
  const studio = createStudio();
  sketch(studio, 3, 1, [[0, 0, rgba(255, 0, 0, 128)], [1, 0, rgba(255, 0, 0, 1)], [2, 0, RED]]);
  assert.deepEqual(await run(studio, { checks: ["antialiasing"] }), [
    {
      check: "antialiasing",
      severity: "warning",
      message:
        "2 semi-transparent pixel(s) on 'Layer 1'. Partial alpha usually comes from a soft brush or a resize and reads as blur.",
      layer: "Layer 1",
      frame: 1,
      count: 2,
    },
  ]);
  const gray = createStudio();
  sketch(gray, 2, 1, [[0, 0, rgba(90, 90, 90, 100)]], { colorMode: "grayscale" });
  assert.equal((await run(gray, { checks: ["antialiasing"] })).length, 1);
  const indexed = createStudio();
  sketch(indexed, 2, 1, [[0, 0, 1]], { colorMode: "indexed", palette: [rgba(0, 0, 0, 0), rgba(255, 0, 0, 128)] });
  assert.deepEqual(await run(indexed, { checks: ["antialiasing"] }), []);
});

test("antialiasing: opaque pixels on a cel or layer below 255 opacity are semi-transparent, faded as they show", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 1, [[0, 0, RED], [1, 0, RED]]);
  cel.opacity = 142;
  assert.deepEqual(await run(studio, { checks: ["antialiasing"] }), [
    {
      check: "antialiasing",
      severity: "warning",
      message:
        "2 semi-transparent pixel(s) on 'Layer 1' frame 1: layer × cel opacity is 142/255, so they show partly transparent, and a GIF rounds them to opaque or clear. Fade with opaque palette colours, or set the opacity to 255.",
      layer: "Layer 1",
      frame: 1,
      count: 2,
    },
  ]);
  cel.opacity = 255;
  sprite.layers[0]!.opacity = 200;
  assert.equal((await run(studio, { checks: ["antialiasing"] }))[0]?.count, 2);
});

test("antialiasing: opaque pixels at full opacity, clear pixels at any opacity and a cel at opacity 0 are not semi-transparent", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 1, [[0, 0, RED]]);
  assert.deepEqual(await run(studio, { checks: ["antialiasing"] }), []);
  sprite.layers[0]!.opacity = 128;
  assert.equal((await run(studio, { checks: ["antialiasing"] }))[0]?.count, 1, "the clear pixel stays clear");
  cel.opacity = 0;
  assert.deepEqual(await run(studio, { checks: ["antialiasing"] }), []);
});

test("layers: a layer with no cel is noted by name", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 2, 2, [[0, 0, RED]]);
  studio.addLayer(sprite, "shadow");
  assert.deepEqual(await run(studio, { checks: ["layers"] }), [
    { check: "layers", severity: "note", message: "Layer 'shadow' has no cels on any frame.", layer: "shadow" },
  ]);
});

test("animation: several frames with no tags is an error, identical durations over three frames a note", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 2, 2, []);
  sprite.frames.push({ durationMs: 100 }, { durationMs: 100 }, { durationMs: 100 });
  assert.deepEqual(await run(studio, { checks: ["animation"] }), [
    {
      check: "animation",
      severity: "error",
      message: "4 frames and no animation tags. An engine cannot address untagged frames — add a tag per cycle.",
      count: 4,
    },
    {
      check: "animation",
      severity: "note",
      message:
        "Every frame has the same duration. Uniform timing reads mechanical; hold contact poses longer than pass poses.",
    },
  ]);
  sprite.tags.push({ name: "idle", from: 1, to: 4, direction: "forward", repeats: 0, color: BLACK });
  sprite.frames[2]!.durationMs = 250;
  assert.deepEqual(await run(studio, { checks: ["animation"] }), []);
});

test("animation: three frames of equal length are not flagged, and a single frame is never checked", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 2, 2, []);
  assert.deepEqual(await run(studio, { checks: ["animation"] }), []);
  sprite.frames.push({ durationMs: 100 }, { durationMs: 100 });
  sprite.tags.push({ name: "all", from: 1, to: 3, direction: "forward", repeats: 0, color: BLACK });
  assert.deepEqual(await run(studio, { checks: ["animation"] }), []);
});

test("export_readiness is clear once the sprite has a filename", async () => {
  const studio = createStudio();
  sketch(studio, 2, 2, []);
  assert.deepEqual(await run(studio, { checks: ["export_readiness"] }), []);
});

test("expect.layerFrames flags art outside the ranges and a missing cel inside them", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 4, 4, [[1, 1, RED], [1, 2, RED]]);
  sprite.frames.push({ durationMs: 100 });
  const findings = await run(studio, { checks: [], expect: { layerFrames: { "Layer 1": [[2, 2]] } } });
  assert.deepEqual(findings, [
    {
      check: "animation",
      severity: "warning",
      message: "Layer 'Layer 1' has art on frame 1, outside its expected range(s).",
      layer: "Layer 1",
      frame: 1,
    },
    {
      check: "animation",
      severity: "warning",
      message: "Layer 'Layer 1' expected art on frame 2 but the cel is missing or empty.",
      layer: "Layer 1",
      frame: 2,
    },
  ]);
});

test("expect.layerFrames treats a cel with no opaque pixel as empty", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 4, 4, []);
  sprite.frames.push({ durationMs: 100 });
  const findings = await run(studio, { checks: [], expect: { layerFrames: { "Layer 1": [[1, 2]] } } });
  assert.deepEqual(findings.map((f) => f.frame), [1, 2]);
});

test("expect.mustNotOverlap reports the first shared opaque pixel per frame", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 6, 6, [...block(1, 1, 3, 3, RED)]);
  const other = studio.addLayer(sprite, "shadow");
  const cel = studio.ensureCel(sprite, other, 1);
  for (const [x, y, v] of block(3, 2, 2, 2, BLUE)) cel.image.set(x, y, v);
  const findings = await run(studio, { checks: [], expect: { mustNotOverlap: [["Layer 1", "shadow"]] } });
  assert.deepEqual(findings, [
    {
      check: "layers",
      severity: "error",
      message: "Layers 'Layer 1' and 'shadow' have overlapping opaque pixels on frame 1.",
      at: { x: 3, y: 2 },
      frame: 1,
    },
  ]);
  cel.image.set(3, 2, 0);
  cel.image.set(3, 3, 0);
  assert.deepEqual(await run(studio, { checks: [], expect: { mustNotOverlap: [["Layer 1", "shadow"]] } }), []);
});

test("expect names a layer that does not exist: invalid_args", async () => {
  const studio = createStudio();
  sketch(studio, 2, 2, []);
  await rejectsWith(
    studio.call("validate.run", { checks: [], expect: { layerFrames: { ghost: [[1, 1]] } } }),
    "invalid_args",
    /ghost/,
  );
});

test("hidden layers are left out of the per-pixel scans and counted in a closing note", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4, filename: "/tmp/hero.aseprite" });
  const draft = studio.addLayer(sprite, "draft");
  draft.visible = false;
  studio.ensureCel(sprite, draft, 1).image.set(1, 1, rgba(255, 0, 0, 90));
  const findings = await run(studio, { checks: ["strays", "antialiasing", "layers"] });
  assert.deepEqual(findings, [
    { check: "layers", severity: "note", message: "Layer 'Layer 1' has no cels on any frame.", layer: "Layer 1" },
    {
      check: "layers",
      severity: "note",
      message:
        "1 hidden layer(s) were not scanned for strays, outline, banding or antialiasing — those checks describe what the sprite shows. Make a layer visible to include it.",
      count: 1,
    },
  ]);
});

test("the hidden-layer note appears only when a check that skips hidden layers runs", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 2, filename: "/tmp/hero.aseprite" });
  const draft = studio.addLayer(sprite, "draft");
  draft.visible = false;
  studio.ensureCel(sprite, draft, 1).image.set(0, 0, rgba(255, 0, 0));
  const note = (findings: Awaited<ReturnType<typeof run>>) => findings.filter((f) => /hidden layer/.test(f.message));
  assert.deepEqual(note(await run(studio, { checks: ["palette"] })), []);
  assert.equal(note(await run(studio, { checks: ["strays"] })).length, 1);
  assert.equal(note(await run(studio, {})).length, 1);
});

test("checks limits what runs", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 2, height: 2 });
  assert.deepEqual(await run(studio, { checks: ["palette"] }), []);
});

test("the validate tool scores and summarises the findings over MCP", async () => {
  const { server, studio } = createServer();
  sketch(studio, 8, 8, [[0, 0, RED], [2, 0, RED], [4, 0, RED], [6, 0, RED]]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name: "validate", arguments: { checks: ["strays"] } });
  assert.notEqual(result.isError, true);
  const data = result.structuredContent as Record<string, any>;
  assert.equal(data.passed, false);
  assert.equal(data.score, 85);
  assert.equal(data.findings[0].check, "strays");
  assert.equal(data.findings[0].severity, "error");
  assert.deepEqual(data.findings[0].at, { x: 0, y: 0 });
  assert.equal(data.summary, "1 error(s), 0 warning(s). Fix the errors before calling this done.");
  await server.close();
});

async function validateText(studio: Studio, server: Awaited<ReturnType<typeof createServer>>["server"], args = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name: "validate", arguments: args });
  await server.close();
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  return { text, data: result.structuredContent as Record<string, any> };
}

test("a run with warnings and no errors is not summarised as clean, and says how many warnings there are", async () => {
  const { server, studio } = createServer();
  studio.addSprite({ width: 2, height: 2 });
  const { text, data } = await validateText(studio, server, { checks: ["export_readiness"] });
  assert.equal(data.passed, true);
  assert.equal(data.summary, "No errors, 1 warning(s): fix each, or say why you leave it.");
  assert.doesNotMatch(text, /Clean/);
});

test("a run with no findings at all is summarised as clean", async () => {
  const { server, studio } = createServer();
  sketch(studio, 2, 2, []);
  const { data } = await validateText(studio, server, { checks: ["export_readiness"] });
  assert.equal(data.summary, "Clean.");
});

test("the text lists the first 15 findings and says how many more there are and where to see them", async () => {
  const { server, studio } = createServer();
  const sprite = studio.addSprite({ width: 2, height: 2 });
  for (let i = 0; i < 17; i++) studio.addLayer(sprite, `empty ${i}`);
  const { text, data } = await validateText(studio, server, { checks: ["layers", "export_readiness"] });
  assert.equal(data.findings.length, 19);
  const lines = text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("[")).length, 15);
  assert.match(lines.at(-1)!, /^… and 4 more finding\(s\), not shown: every one is in the result's `findings`, or narrow the run with `checks`\.$/);
});

test("the text adds no 'more findings' line when every finding fits", async () => {
  const { server, studio } = createServer();
  studio.addSprite({ width: 2, height: 2 });
  const { text } = await validateText(studio, server, { checks: ["export_readiness"] });
  assert.doesNotMatch(text, /more finding/);
});
