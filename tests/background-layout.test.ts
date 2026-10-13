import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { decodeAse, encodeAse } from "../dist/lib/ase.js";
import type { AseFile, AseLayer } from "../dist/lib/ase.js";
import { decodeGif } from "../dist/lib/gif.js";
import { decodePng } from "../dist/lib/png.js";
import { createServer } from "../dist/server.js";

type Reply = Record<string, any>;
type Studio = ReturnType<typeof createStudio>;

const BLACK = rgba(0, 0, 0);
const WHITE = rgba(255, 255, 255);
const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);
const HALF_RED = rgba(255, 0, 0, 128);
const HALF_GREEN = rgba(0, 255, 0, 128);
const MARK = "pixel-ai-artist:reference";

async function inTempDir(body: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-ai-artist-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rejectsInvalidArgs(promise: Promise<unknown>) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, "invalid_args");
    return true;
  });
}

const img = (width: number, height: number, pixels: number[]) => Image.from(width, height, new Uint32Array(pixels));
const readPng = (file: string) => [...decodePng(new Uint8Array(readFileSync(file))).pixels];
const readGif = (file: string) => [...decodeGif(new Uint8Array(readFileSync(file))).frames[0]!.image.pixels];
const manage = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("sprite.manage", args);
const exportRun = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("export.run", args);
const layerApply = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("layer.apply", args);
const composite = (studio: Studio, sprite: NonNullable<ReturnType<Studio["activeSprite"]>>) => [...studio.composite(sprite, 1).pixels];
const layerNames = (sprite: NonNullable<ReturnType<Studio["activeSprite"]>>) => sprite.layers.map((l) => l.name);

async function connected() {
  const { server, studio } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, studio, close: async () => { await server.close(); } };
}

const textOf = (result: { content?: unknown }): string => (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";

// ── building .aseprite files ────────────────────────────────────────────

function aseLayer(name: string, extra: Partial<AseLayer> = {}): AseLayer {
  return {
    name,
    type: "image",
    childLevel: 0,
    visible: true,
    editable: true,
    background: false,
    lockMovement: false,
    preferLinkedCels: false,
    collapsed: false,
    reference: false,
    blendMode: 0,
    opacity: 255,
    ...extra,
  };
}

const rgbaBytes = (...pixels: number[]) => Uint8Array.from(pixels.flatMap((p) => [p >>> 24, (p >>> 16) & 255, (p >>> 8) & 255, p & 255]));

/** A 2x1 RGBA file; `cels` are [layer index, x, width, pixels]. */
function rgbaFile(layers: AseLayer[], cels: [number, number, number, number[]][]): AseFile {
  return {
    width: 2,
    height: 1,
    colorMode: "rgba",
    transparentIndex: 0,
    palette: rgbaBytes(BLACK, WHITE),
    layers,
    frames: [{ durationMs: 100, cels: cels.map(([layer, x, width, pixels]) => ({ layer, x, y: 0, opacity: 255, zIndex: 0, image: { width, height: 1, pixels: rgbaBytes(...pixels) } })) }],
    tags: [],
  };
}

async function openFile(dir: string, file: AseFile, name = "in.aseprite") {
  const target = path.join(dir, name);
  writeFileSync(target, encodeAse(file));
  const studio = createStudio();
  const reply = await manage(studio, { op: "open", path: target });
  return { studio, sprite: studio.activeSprite()!, reply };
}

// ── Background layers sit together at the bottom ────────────────────────

test("merging one Background into another keeps the composite, the upper one winning", async () => {
  await inTempDir(async (dir) => {
    const file = rgbaFile(
      [aseLayer("Blue", { background: true }), aseLayer("Red", { background: true })],
      [[0, 0, 2, [BLUE, BLUE]], [1, 0, 1, [RED]]],
    );
    const { studio, sprite } = await openFile(dir, file);
    const before = composite(studio, sprite);
    assert.deepEqual(before, [RED, BLUE]);
    await layerApply(studio, { op: "merge", name: "Red" });
    assert.deepEqual(layerNames(sprite), ["Blue"]);
    assert.deepEqual(composite(studio, sprite), before);
  });
});

function twoBackgrounds() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1 });
  sprite.layers[0]!.name = "A";
  sprite.layers[0]!.background = true;
  studio.addLayer(sprite, "B").background = true;
  studio.addLayer(sprite, "c");
  return { studio, sprite };
}

test("with two Backgrounds, reorder and create refuse to put a plain layer between them or below them, and change nothing", async () => {
  const { studio, sprite } = twoBackgrounds();
  await rejectsInvalidArgs(layerApply(studio, { op: "reorder", name: "c", index: 2 }));
  await rejectsInvalidArgs(layerApply(studio, { op: "reorder", name: "c", index: 1 }));
  await rejectsInvalidArgs(layerApply(studio, { op: "create", name: "x", index: 2 }));
  await rejectsInvalidArgs(layerApply(studio, { op: "create", name: "x", index: 1 }));
  assert.deepEqual(layerNames(sprite), ["A", "B", "c"]);
  await layerApply(studio, { op: "create", name: "x", index: 3 });
  assert.deepEqual(layerNames(sprite), ["A", "B", "x", "c"]);
});

test("with two Backgrounds, they can be reordered between themselves but not lifted above a plain layer", async () => {
  const { studio, sprite } = twoBackgrounds();
  await layerApply(studio, { op: "reorder", name: "A", index: 2 });
  assert.deepEqual(layerNames(sprite), ["B", "A", "c"]);
  await rejectsInvalidArgs(layerApply(studio, { op: "reorder", name: "B", index: 3 }));
  await layerApply(studio, { op: "reorder", name: "A", index: 1 });
  assert.deepEqual(layerNames(sprite), ["A", "B", "c"]);
});

test("opening a file whose Background sits between plain layers moves it to the bottom, and the picture is the one Aseprite draws", async () => {
  await inTempDir(async (dir) => {
    // Aseprite draws a Background before every other layer, so Ink survives on Paper whatever the stack says.
    const file = rgbaFile(
      [aseLayer("L0"), aseLayer("Paper", { background: true }), aseLayer("L2")],
      [[0, 0, 1, [RED]], [1, 0, 2, [BLUE, BLUE]], [2, 1, 1, [GREEN]]],
    );
    const { studio, sprite, reply } = await openFile(dir, file);
    assert.deepEqual(layerNames(sprite), ["Paper", "L0", "L2"]);
    assert.deepEqual(reply.misplacedBackground, ["Paper"]);
    assert.deepEqual(composite(studio, sprite), [RED, GREEN]);
  });
});

// ── a Background's pixels are written as drawn ──────────────────────────

/** 3x1 indexed, palette [red, green, blue, white, black], transparent index 3; the Background's cel is 2x1 and leaves x=2 a hole. */
function holey() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 3, height: 1, colorMode: "indexed", palette: [RED, GREEN, BLUE, WHITE, BLACK] });
  sprite.transparentIndex = 3;
  const layer = sprite.layers[0]!;
  layer.background = true;
  studio.ensureCel(sprite, layer, 1, { x: 0, y: 0, width: 2, height: 1 }).image = img(2, 1, [0, 3]);
  return { studio, sprite };
}

test("an indexed Background's cel pixels, the transparent index 3 among them, are palette colours in every export and save_as; only the hole differs", async () => {
  await inTempDir(async (dir) => {
    const { studio } = holey();
    const file = (name: string) => path.join(dir, name);
    const cleared = [RED, WHITE, 0];
    const solid = [RED, WHITE, BLACK];

    await exportRun(studio, { op: "png", path: file("still.png") });
    await exportRun(studio, { op: "spritesheet", path: file("sheet.png"), includeJson: false });
    assert.deepEqual(readPng(file("still.png")), cleared, "export png");
    assert.deepEqual(readPng(file("sheet.png")), cleared, "export spritesheet");

    const frames = await exportRun(studio, { op: "frames", path: file("frames.png") });
    const gif = await exportRun(studio, { op: "gif", path: file("out.gif") });
    assert.deepEqual(readPng(file("frames.png")), solid, "export frames");
    assert.deepEqual(readGif(file("out.gif")), solid, "export gif");
    assert.equal(frames.alphaDropped, 1);
    assert.equal(gif.alphaDropped, 1);

    const savedPng = await manage(studio, { op: "save_as", path: file("saved.png") });
    assert.deepEqual(readPng(file("saved.png")), solid, "save_as png");
    const savedGif = await manage(studio, { op: "save_as", path: file("saved.gif") });
    assert.deepEqual(readGif(file("saved.gif")), solid, "save_as gif");
    assert.equal(savedPng.alphaDropped, 1);
    assert.equal(savedGif.alphaDropped, 1);
  });
});

test("export png and spritesheet report no alphaDropped, because they write transparency", async () => {
  await inTempDir(async (dir) => {
    const { studio } = holey();
    const png = await exportRun(studio, { op: "png", path: path.join(dir, "still.png") });
    const sheet = await exportRun(studio, { op: "spritesheet", path: path.join(dir, "sheet.png"), includeJson: false });
    assert.equal("alphaDropped" in png, false);
    assert.equal("alphaDropped" in sheet, false);
  });
});

test("validate counts a Background's lone transparent-index pixel in a 1x1 cel as a stray colour", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 3, height: 3, colorMode: "indexed", palette: [WHITE, RED] });
  sprite.transparentIndex = 0;
  const layer = sprite.layers[0]!;
  layer.background = true;
  studio.ensureCel(sprite, layer, 1, { x: 1, y: 1, width: 1, height: 1 }).image = img(1, 1, [0]);
  const found = (await studio.call<{ findings: Reply[] }>("validate.run", { checks: ["strays"] })).findings;
  assert.deepEqual(found.map((f) => [f.check, f.layer, f.count]), [["strays", "Layer 1", 1]]);
});

// ── dropping alpha is the same on every path ────────────────────────────

/** A 2x1 RGB sprite with a visible Background at opacity 128 holding [red, green]. */
function faintPaper(studio = createStudio()) {
  const sprite = studio.addSprite({ width: 2, height: 1 });
  sprite.palette = [RED, GREEN, BLUE];
  const layer = sprite.layers[0]!;
  layer.name = "Paper";
  layer.background = true;
  layer.opacity = 128;
  studio.ensureCel(sprite, layer, 1).image = img(2, 1, [RED, GREEN]);
  return { studio, sprite };
}

test("a Background below 255 opacity is written solid, colour kept and counted in alphaDropped, by save_as png and gif and export frames and gif", async () => {
  await inTempDir(async (dir) => {
    const { studio } = faintPaper();
    const file = (name: string) => path.join(dir, name);
    const replies = [
      await manage(studio, { op: "save_as", path: file("saved.png") }),
      await manage(studio, { op: "save_as", path: file("saved.gif") }),
      await exportRun(studio, { op: "frames", path: file("frames.png") }),
      await exportRun(studio, { op: "gif", path: file("out.gif") }),
    ];
    assert.deepEqual(replies.map((r) => r.alphaDropped), [2, 2, 2, 2]);
    assert.deepEqual(readPng(file("saved.png")), [RED, GREEN]);
    assert.deepEqual(readGif(file("saved.gif")), [RED, GREEN]);
    assert.deepEqual(readPng(file("frames.png")), [RED, GREEN]);
    assert.deepEqual(readGif(file("out.gif")), [RED, GREEN]);
  });
});

test("export png and spritesheet write a Background below 255 opacity as composited, half transparent, with no alphaDropped", async () => {
  await inTempDir(async (dir) => {
    const { studio } = faintPaper();
    const png = await exportRun(studio, { op: "png", path: path.join(dir, "still.png") });
    const sheet = await exportRun(studio, { op: "spritesheet", path: path.join(dir, "sheet.png"), includeJson: false });
    assert.deepEqual(readPng(path.join(dir, "still.png")), [HALF_RED, HALF_GREEN]);
    assert.deepEqual(readPng(path.join(dir, "sheet.png")), [HALF_RED, HALF_GREEN]);
    assert.equal("alphaDropped" in png, false);
    assert.equal("alphaDropped" in sheet, false);
  });
});

test("a save_as png of an opaque Background reports no alphaDropped", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = faintPaper();
    sprite.layers[0]!.opacity = 255;
    assert.equal("alphaDropped" in (await manage(studio, { op: "save_as", path: path.join(dir, "a.png") })), false);
  });
});

// ── faintBackground ─────────────────────────────────────────────────────

test("layer set below 255 opacity on a Background answers faintBackground, and no other set does", async () => {
  const { studio, sprite } = faintPaper();
  sprite.layers[0]!.opacity = 255;
  studio.addLayer(sprite, "Ink");
  assert.deepEqual((await layerApply(studio, { op: "set", name: "Paper", opacity: 128 })).faintBackground, [{ layer: "Paper", opacity: 128 }]);
  assert.equal((await layerApply(studio, { op: "set", name: "Paper", opacity: 255 })).faintBackground, undefined);
  assert.equal((await layerApply(studio, { op: "set", name: "Ink", opacity: 128 })).faintBackground, undefined);
  assert.equal((await layerApply(studio, { op: "set", name: "Paper", visible: false })).faintBackground, undefined);
});

test("the layer tool's reply text names a faint Background, and says nothing of it for a plain layer", async () => {
  const { client, studio, close } = await connected();
  const { sprite } = faintPaper(studio);
  sprite.layers[0]!.opacity = 255;
  studio.addLayer(sprite, "Ink");
  const faint = await client.callTool({ name: "layer", arguments: { op: "set", name: "Paper", opacity: 128 } });
  assert.ok(!faint.isError, textOf(faint));
  assert.deepEqual((faint.structuredContent as Reply).faintBackground, [{ layer: "Paper", opacity: 128 }]);
  assert.match(textOf(faint), /Background opacity below 255 \('Paper' 128\).*\(faintBackground\)/);
  const plain = await client.callTool({ name: "layer", arguments: { op: "set", name: "Ink", opacity: 128 } });
  assert.doesNotMatch(textOf(plain), /faintBackground/);
  await close();
});

// ── reply texts of the tools ────────────────────────────────────────────

test("the sprite_manage and export tools' reply texts say how many pixels were written opaque", async () => {
  await inTempDir(async (dir) => {
    const { client, studio, close } = await connected();
    faintPaper(studio);
    const saved = await client.callTool({ name: "sprite_manage", arguments: { op: "save_as", path: path.join(dir, "a.png") } });
    assert.ok(!saved.isError, textOf(saved));
    assert.equal((saved.structuredContent as Reply).alphaDropped, 2);
    assert.match(textOf(saved), /2 pixel\(s\) written opaque because a visible Background leaves the file no transparency \(alphaDropped\)/);
    const frames = await client.callTool({ name: "export", arguments: { op: "frames", path: path.join(dir, "frames.png") } });
    assert.ok(!frames.isError, textOf(frames));
    assert.equal((frames.structuredContent as Reply).alphaDropped, 2);
    assert.match(textOf(frames), /2 pixel\(s\) written opaque because a visible Background leaves the file no transparency \(alphaDropped\)/);
    const still = await client.callTool({ name: "export", arguments: { op: "png", path: path.join(dir, "still.png") } });
    assert.doesNotMatch(textOf(still), /alphaDropped/);
    await close();
  });
});

// ── the reference mark's line ending ────────────────────────────────────

async function savedLayerText(dir: string, text: string) {
  const { studio } = await openFile(dir, rgbaFile([aseLayer("ref", { userData: { text } })], [[0, 0, 2, [RED, RED]]]));
  const file = path.join(dir, "saved.aseprite");
  await manage(studio, { op: "save_as", path: file });
  return decodeAse(new Uint8Array(readFileSync(file))).layers[0]!.userData?.text;
}

test("a mark line ended with CRLF among LF lines is written back as it was", async () => {
  await inTempDir(async (dir) => {
    const text = `a\nb\n${MARK}\r\n`;
    assert.equal(await savedLayerText(dir, text), text);
  });
});

test("a mark line that sat mid-text is written at the end, ended as it was in the file", async () => {
  await inTempDir(async (dir) => {
    assert.equal(await savedLayerText(dir, `a\r\n${MARK}\nb`), `a\r\nb\n${MARK}`);
  });
});
