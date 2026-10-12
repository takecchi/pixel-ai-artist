import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { Image, createStudio, rgba } from "../dist/doc/index.js";
import { decodeAse, encodeAse } from "../dist/lib/ase.js";
import type { AseFile, AseLayer } from "../dist/lib/ase.js";
import { decodeGif } from "../dist/lib/gif.js";
import { decodePng } from "../dist/lib/png.js";

type Reply = Record<string, any>;
type Studio = ReturnType<typeof createStudio>;

async function inTempDir(body: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-ai-artist-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const manage = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("sprite.manage", args);
const img = (width: number, height: number, pixels: number[]) => Image.from(width, height, new Uint32Array(pixels));
const readPng = (file: string) => decodePng(new Uint8Array(readFileSync(file)));
const readGif = (file: string) => decodeGif(new Uint8Array(readFileSync(file)));

const BLACK = rgba(0, 0, 0);
const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const HALF_GREEN = rgba(0, 255, 0, 128);
const BLUE = rgba(0, 0, 255);

/** A 2x1 RGB sprite with a layer per entry of `cels`, bottom to top; `background` names the ones that are Background layers. */
async function sprite2x1(cels: Record<string, number[]>, background: string[] = []) {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 1 });
  const sprite = studio.activeSprite()!;
  sprite.palette = [RED, GREEN, BLUE];
  sprite.layers = [];
  for (const [name, pixels] of Object.entries(cels)) {
    const layer = studio.addLayer(sprite, name);
    if (background.includes(name)) layer.background = true;
    studio.ensureCel(sprite, layer, 1).image = img(2, 1, pixels);
  }
  return { studio, sprite };
}

// ── compositing ─────────────────────────────────────────────────────────

test("an indexed Background layer composites its transparent index as the palette colour, and another layer leaves it clear", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 1, colorMode: "indexed" });
  const sprite = studio.activeSprite()!;
  sprite.palette = [BLACK, RED, BLUE];
  sprite.transparentIndex = 0;
  const layer = sprite.layers[0]!;
  studio.ensureCel(sprite, layer, 1).image = img(2, 1, [0, 1]);
  assert.deepEqual([...studio.composite(sprite, 1).pixels], [0, RED]);
  layer.background = true;
  assert.deepEqual([...studio.composite(sprite, 1).pixels], [BLACK, RED]);
});

test("an indexed Background shows its transparent index in the palette colour, ignoring the alpha the palette entry carries", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 1, height: 1, colorMode: "indexed" });
  const sprite = studio.activeSprite()!;
  sprite.palette = [rgba(10, 20, 30, 0), RED];
  sprite.transparentIndex = 0;
  sprite.layers[0]!.background = true;
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = img(1, 1, [0]);
  assert.deepEqual([...studio.composite(sprite, 1).pixels], [rgba(10, 20, 30)]);
});

test("a Background layer is drawn first, however high it sits in the stack", async () => {
  const { studio, sprite } = await sprite2x1({ Ink: [RED, 0], Paper: [BLUE, BLUE] }, ["Paper"]);
  assert.deepEqual([...studio.composite(sprite, 1).pixels], [RED, BLUE]);
  sprite.layers[1]!.background = undefined;
  assert.deepEqual([...studio.composite(sprite, 1).pixels], [BLUE, BLUE]);
});

// ── save_as .png and .gif ───────────────────────────────────────────────

test("save_as .png of a sprite with a visible Background writes every pixel opaque and keeps their colours", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await sprite2x1({ Ink: [RED, 0], Paper: [0, HALF_GREEN] }, ["Paper"]);
    const file = path.join(dir, "opaque.png");
    await manage(studio, { op: "save_as", path: file });
    assert.deepEqual([...readPng(file).pixels], [RED, GREEN]);
  });
});

test("save_as .png of a sprite whose pixels are all clear under a visible Background writes opaque black", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await sprite2x1({ Paper: [0, 0] }, ["Paper"]);
    const file = path.join(dir, "empty.png");
    await manage(studio, { op: "save_as", path: file });
    assert.deepEqual([...readPng(file).pixels], [BLACK, BLACK]);
  });
});

test("save_as .gif of a sprite with a visible Background writes no transparent pixel", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await sprite2x1({ Ink: [RED, 0], Paper: [0, HALF_GREEN] }, ["Paper"]);
    const file = path.join(dir, "opaque.gif");
    await manage(studio, { op: "save_as", path: file });
    const gif = readGif(file);
    assert.equal(gif.transparentIndex, -1);
    assert.deepEqual([...gif.frames[0]!.image.pixels], [RED, GREEN]);
  });
});

test("save_as .png and .gif keep their transparency when the Background is hidden or there is none", async () => {
  await inTempDir(async (dir) => {
    for (const hidden of [true, false]) {
      const { studio, sprite } = await sprite2x1({ Ink: [RED, 0], Paper: [0, 0] }, hidden ? ["Paper"] : []);
      sprite.layers[1]!.visible = !hidden;
      const png = path.join(dir, `${hidden}.png`);
      const gif = path.join(dir, `${hidden}.gif`);
      await manage(studio, { op: "save_as", path: png });
      await manage(studio, { op: "save_as", path: gif });
      assert.deepEqual([...readPng(png).pixels], [RED, 0], `png hidden=${hidden}`);
      assert.deepEqual([...readGif(gif).frames[0]!.image.pixels], [RED, 0], `gif hidden=${hidden}`);
    }
  });
});

// ── export ──────────────────────────────────────────────────────────────

test("export gif and frames write a Background's sprite opaque, as save does, while png and spritesheet keep a hole transparent, as the Lua handler and Aseprite wrote them", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await sprite2x1({ Ink: [RED, 0], Paper: [0, 0] }, ["Paper"]);
    const run = (args: Record<string, unknown>) => studio.call<Reply>("export.run", args);
    await run({ op: "gif", path: path.join(dir, "a.gif") });
    await run({ op: "frames", path: path.join(dir, "frames.png") });
    await run({ op: "png", path: path.join(dir, "still.png") });
    await run({ op: "spritesheet", path: path.join(dir, "sheet.png"), includeJson: false });
    assert.ok(readGif(path.join(dir, "a.gif")).frames[0]!.image.pixels.every((v) => (v & 255) === 255), "gif");
    assert.deepEqual([...readPng(path.join(dir, "frames.png")).pixels], [RED, BLACK], "frames");
    assert.deepEqual([...readPng(path.join(dir, "still.png")).pixels], [RED, 0], "png");
    assert.deepEqual([...readPng(path.join(dir, "sheet.png")).pixels], [RED, 0], "spritesheet");
  });
});

test("an indexed Background's transparent index is clear in an exported spritesheet, as Aseprite renders a sheet, but opaque in save_as png", async () => {
  await inTempDir(async (dir) => {
    const studio = createStudio();
    await manage(studio, { op: "new", width: 2, height: 1, colorMode: "indexed" });
    const sprite = studio.activeSprite()!;
    sprite.palette = [BLACK, RED, BLUE];
    sprite.transparentIndex = 0;
    sprite.layers[0]!.background = true;
    studio.ensureCel(sprite, sprite.layers[0]!, 1).image = img(2, 1, [0, 1]);
    const sheet = path.join(dir, "sheet.png");
    await studio.call<Reply>("export.run", { op: "spritesheet", path: sheet, includeJson: false });
    assert.deepEqual([...readPng(sheet).pixels], [0, RED]);
    const saved = path.join(dir, "saved.png");
    await manage(studio, { op: "save_as", path: saved });
    assert.deepEqual([...readPng(saved).pixels], [BLACK, RED]);
  });
});

test("a Background below 255 opacity composites faintly, as Aseprite draws it", async () => {
  const { studio, sprite } = await sprite2x1({ Paper: [RED, RED] }, ["Paper"]);
  sprite.layers[0]!.opacity = 128;
  assert.deepEqual([...studio.composite(sprite, 1).pixels], [rgba(255, 0, 0, 128), rgba(255, 0, 0, 128)]);
});

test("export gif and frames keep transparency when `layers` leaves the Background out", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await sprite2x1({ Ink: [RED, 0], Paper: [BLUE, BLUE] }, ["Paper"]);
    const run = (args: Record<string, unknown>) => studio.call<Reply>("export.run", args);
    await run({ op: "frames", path: path.join(dir, "frames.png"), layers: ["Ink"] });
    await run({ op: "gif", path: path.join(dir, "a.gif"), layers: ["Ink"] });
    assert.deepEqual([...readPng(path.join(dir, "frames.png")).pixels], [RED, 0]);
    assert.equal(readGif(path.join(dir, "a.gif")).frames[0]!.image.get(1, 0), 0);
  });
});

test("export gif and frames keep transparency when the Background is hidden", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await sprite2x1({ Ink: [RED, 0], Paper: [BLUE, BLUE] }, ["Paper"]);
    sprite.layers[1]!.visible = false;
    await studio.call("export.run", { op: "frames", path: path.join(dir, "frames.png") });
    assert.deepEqual([...readPng(path.join(dir, "frames.png")).pixels], [RED, 0]);
  });
});

// ── the .aseprite flags ─────────────────────────────────────────────────

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

function aseFile(layers: AseLayer[]): AseFile {
  return {
    width: 2,
    height: 2,
    colorMode: "rgba",
    transparentIndex: 0,
    palette: Uint8Array.from([0, 0, 0, 255, 255, 0, 0, 255]),
    layers,
    frames: [{ durationMs: 100, cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, image: { width: 2, height: 2, pixels: new Uint8Array(16).fill(255) } }] }],
    tags: [],
  };
}

/** The opacity byte of every layer chunk in the first frame, read raw because decodeAse ignores it on a Background layer. */
function rawLayerOpacities(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameEnd = 128 + view.getUint32(128, true);
  const opacities: number[] = [];
  for (let pos = 128 + 16; pos < frameEnd; pos += view.getUint32(pos, true)) {
    if (view.getUint16(pos + 4, true) === 0x2004) opacities.push(bytes[pos + 6 + 12]!);
  }
  return opacities;
}

test("open then save_as keeps a layer's Background, lockMovement, collapsed, preferLinkedCels and unnamed flag bits", async () => {
  await inTempDir(async (dir) => {
    const flagged = aseLayer("Background", { background: true, lockMovement: true, collapsed: true, preferLinkedCels: true, otherFlags: 128 });
    const source = path.join(dir, "flags.aseprite");
    writeFileSync(source, encodeAse(aseFile([flagged, aseLayer("Ink")])));
    const studio = createStudio();
    await manage(studio, { op: "open", path: source });
    const sprite = studio.activeSprite()!;
    assert.equal(sprite.layers[0]!.background, true);
    assert.equal(sprite.layers[1]!.background, undefined);
    const out = path.join(dir, "out.aseprite");
    await manage(studio, { op: "save_as", path: out });
    const layers = decodeAse(new Uint8Array(readFileSync(out))).layers;
    assert.deepEqual(
      layers.map((l) => [l.background, l.lockMovement, l.collapsed, l.preferLinkedCels, l.otherFlags]),
      [[true, true, true, true, 128], [false, false, false, false, 0]],
    );
  });
});

test("save_as writes a Background layer's opacity as 255 and another layer's as it is", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await sprite2x1({ Paper: [RED, RED], Ink: [RED, 0] }, ["Paper"]);
    sprite.layers[0]!.opacity = 128;
    sprite.layers[1]!.opacity = 128;
    const out = path.join(dir, "opacity.aseprite");
    await manage(studio, { op: "save_as", path: out });
    assert.deepEqual(rawLayerOpacities(new Uint8Array(readFileSync(out))), [255, 128]);
  });
});

test("an image with no transparency saved as .aseprite has a Background layer that is locked in place", async () => {
  await inTempDir(async (dir) => {
    const source = path.join(dir, "opaque.png");
    const chunk = (type: string, body: number[] | Uint8Array): Uint8Array => {
      const out = new Uint8Array(12 + body.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, body.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(body, 8);
      view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
      return out;
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 2);
    new DataView(ihdr.buffer).setUint32(4, 1);
    ihdr[8] = 8;
    ihdr[9] = 3;
    const png = [
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      chunk("IHDR", ihdr),
      chunk("PLTE", [0, 0, 0, 255, 0, 0]),
      chunk("IDAT", deflateSync(Uint8Array.of(0, 0, 1))),
      chunk("IEND", []),
    ];
    writeFileSync(source, Uint8Array.from(png.flatMap((p) => [...p])));
    const studio = createStudio();
    await manage(studio, { op: "open", path: source });
    const out = path.join(dir, "out.aseprite");
    await manage(studio, { op: "save_as", path: out });
    const layer = decodeAse(new Uint8Array(readFileSync(out))).layers[0]!;
    assert.deepEqual([layer.name, layer.background, layer.lockMovement], ["Background", true, true]);
  });
});
