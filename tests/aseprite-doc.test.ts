import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { createServer } from "../dist/server.js";
import { spriteFromAse } from "../dist/doc/aseprite.js";
import { decodeAse, encodeAse } from "../dist/lib/ase.js";
import type { AseFile, AseLayer } from "../dist/lib/ase.js";

type Reply = Record<string, any>;
type Studio = ReturnType<typeof createStudio>;
type Sprite = NonNullable<ReturnType<Studio["activeSprite"]>>;
type ColorMode = "rgb" | "grayscale" | "indexed";

async function rejectsWith(promise: Promise<unknown>, code: string, check?: (err: ToolError) => void) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    check?.(err);
    return true;
  });
}

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

const BLACK = rgba(0, 0, 0);
const RED = rgba(255, 0, 0);
const HALF_GREEN = rgba(0, 255, 0, 128);
const BLUE = rgba(0, 0, 255);

// ── building files ──────────────────────────────────────────────────────

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

const PALETTE = Uint8Array.from([0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]);

/** A 2x2 RGBA file of one frame whose layers and cels are as given; one opaque red cel on layer 0 unless told otherwise. */
function aseFile(layers: AseLayer[], extra: Partial<AseFile> = {}): AseFile {
  return {
    width: 2,
    height: 2,
    colorMode: "rgba",
    transparentIndex: 0,
    palette: PALETTE,
    layers,
    frames: [
      {
        durationMs: 100,
        cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, image: { width: 2, height: 2, pixels: new Uint8Array(16).fill(255) } }],
      },
    ],
    tags: [],
    ...extra,
  };
}

// The encoder refuses tilemap layers, slices and palette changes, so those files are assembled byte by byte.
class B {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { return this.u16(v & 0xffff).u16(v >>> 16); }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  str(s: string) {
    const e = new TextEncoder().encode(s);
    this.u16(e.length);
    for (const b of e) this.u8(b);
    return this;
  }
  raw(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.u8(b[i]!); return this; }
}

const mkChunk = (type: number, body: B | number[]): number[] => {
  const b = Array.isArray(body) ? body : body.bytes;
  return new B().u32(b.length + 6).u16(type).raw(b).bytes;
};

const mkFrame = (chunks: number[][]): number[] => {
  const body = chunks.flat();
  return new B().u32(16 + body.length).u16(0xf1fa).u16(chunks.length).u16(100).zeros(2).u32(chunks.length).raw(body).bytes;
};

/** `headerFlags` 4 makes every layer chunk carry a UUID. */
function mkFile(frames: number[][], headerFlags = 3): Uint8Array {
  const body = frames.flat();
  const head = new B().u32(128 + body.length).u16(0xa5e0).u16(frames.length).u16(2).u16(2).u16(32).u32(headerFlags).u16(100).zeros(128 - 20);
  return Uint8Array.from([...head.bytes, ...body]);
}

const mkLayer = (name: string, type = 0, uuid = false) =>
  mkChunk(
    0x2004,
    new B().u16(3).u16(type).u16(0).u16(0).u16(0).u16(0).u8(255).zeros(3).str(name).raw(type === 2 ? [0, 0, 0, 0] : []).raw(uuid ? new Array(16).fill(7) : []),
  );

/** A zlib-compressed RGBA cel, all zero unless `pixels` is given; the size is written as asked, whatever the pixels. */
const mkCel = (layer: number, width: number, height: number, pixels?: Uint8Array) =>
  mkChunk(
    0x2005,
    new B().u16(layer).u16(0).u16(0).u8(255).u16(2).u16(0).zeros(5).u16(width).u16(height).raw(deflateSync(pixels ?? new Uint8Array(width * height * 4))),
  );

const mkLinkedCel = (layer: number, frame: number) => mkChunk(0x2005, new B().u16(layer).u16(0).u16(0).u8(255).u16(1).u16(0).zeros(5).u16(frame));

const mkTags = (tags: [from: number, to: number, name: string][]) => {
  const b = new B().u16(tags.length).zeros(8);
  for (const [from, to, name] of tags) b.u16(from).u16(to).u8(0).u16(0).zeros(6).raw([1, 2, 3, 0]).str(name);
  return mkChunk(0x2018, b);
};

/** A frame that declares `declared` chunks, however many it holds. */
const mkFrameDeclaring = (chunks: number[][], declared: number): number[] => {
  const body = chunks.flat();
  return new B().u32(16 + body.length).u16(0xf1fa).u16(declared).u16(100).zeros(2).u32(declared).raw(body).bytes;
};
const mkPalette = (colors: number[][]) => {
  const b = new B().u32(colors.length).u32(0).u32(colors.length - 1).zeros(8);
  for (const c of colors) b.u16(0).raw(c);
  return mkChunk(0x2019, b);
};

function write(dir: string, name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

const MARK = "pixel-ai-artist:reference";

/** Saves the studio's active sprite as `name` in `dir` and decodes what was written. */
async function savedAse(studio: Studio, dir: string, name = "saved.aseprite") {
  const file = path.join(dir, name);
  await manage(studio, { op: "save_as", path: file });
  return decodeAse(new Uint8Array(readFileSync(file)));
}

async function opened(file: string) {
  const studio = createStudio();
  await manage(studio, { op: "open", path: file });
  return { studio, sprite: studio.activeSprite()! };
}

// ── save then open ──────────────────────────────────────────────────────

/** What a sprite is, as a plain value, so that two sprites can be compared whole. */
function snapshot(s: Sprite) {
  return {
    size: [s.width, s.height],
    colorMode: s.colorMode,
    transparentIndex: s.transparentIndex,
    palette: s.palette,
    pixelRatio: s.pixelRatio,
    frames: s.frames.map((f) => f.durationMs),
    tags: s.tags,
    layers: s.layers.map((l) => ({
      name: l.name,
      visible: l.visible,
      editable: l.editable,
      opacity: l.opacity,
      cels: [...l.cels].map(([frame, c]) => [frame, c.x, c.y, c.opacity, c.image.width, c.image.height, [...c.image.pixels]]),
    })),
  };
}

/** Three layers and frames, with an offset cel, a missing cel, a translucent palette entry and two tags. */
async function drawn(mode: ColorMode) {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 4, height: 3, colorMode: mode });
  const sprite = studio.activeSprite()!;
  sprite.palette = [BLACK, RED, HALF_GREEN, BLUE];
  sprite.transparentIndex = mode === "indexed" ? 2 : 0;
  sprite.pixelRatio = { w: 2, h: 1 };
  sprite.frames = [{ durationMs: 100 }, { durationMs: 250 }, { durationMs: 40 }];
  const colour = (i: number) =>
    mode === "indexed" ? i % 4 : mode === "grayscale" ? rgba(i * 20, i * 20, i * 20, 255 - i) : rgba(i * 20, 255 - i * 10, i, 200 + i);
  const pixels = (n: number, seed: number) => Array.from({ length: n }, (_, i) => colour(i + seed));

  const bottom = sprite.layers[0]!;
  bottom.name = "Bottom";
  studio.ensureCel(sprite, bottom, 1).image = img(4, 3, pixels(12, 0));
  bottom.cels.set(2, { x: 0, y: 0, image: img(4, 3, pixels(12, 3)), opacity: 255 });
  const mid = studio.addLayer(sprite, "Mid");
  mid.visible = false;
  mid.editable = false;
  mid.opacity = 90;
  mid.cels.set(1, { x: -2, y: 1, image: img(2, 2, pixels(4, 5)), opacity: 77 });
  const top = studio.addLayer(sprite, "Top");
  top.opacity = 200;
  top.cels.set(3, { x: 1, y: 1, image: img(3, 1, pixels(3, 7)), opacity: 255 });
  sprite.tags = [
    { name: "walk", from: 1, to: 2, direction: "forward", repeats: 0, color: rgba(10, 20, 30, 255) },
    { name: "back", from: 2, to: 3, direction: "pingpong_reverse", repeats: 3, color: rgba(255, 0, 128, 40) },
  ];
  return { studio, sprite };
}

for (const mode of ["rgb", "grayscale", "indexed"] as const) {
  test(`save_as .aseprite then open keeps a ${mode} sprite's layers, cels, durations, tags, palette and pixel ratio`, async () => {
    await inTempDir(async (dir) => {
      const { studio, sprite } = await drawn(mode);
      const file = path.join(dir, "art.aseprite");
      await manage(studio, { op: "save_as", path: file });
      const reopened = (await opened(file)).sprite;
      assert.deepEqual(snapshot(reopened), snapshot(sprite));
      assert.equal(reopened.modified, false);
      assert.equal(reopened.filename, file);
      assert.ok(path.isAbsolute(reopened.filename!));
    });
  });
}

test("open of an .aseprite answers the file's name and size, makes it active, and selects the top layer", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await drawn("rgb");
    const file = path.join(dir, "named.ase");
    await manage(studio, { op: "save_as", path: file });
    const other = createStudio();
    await manage(other, { op: "new", width: 1, height: 1 });
    const reply = await manage(other, { op: "open", path: file });
    assert.deepEqual(reply, { sprite: "named.ase", id: reply.id, width: 4, height: 3 });
    const sprite = other.activeSprite()!;
    assert.equal(sprite.id, reply.id);
    assert.equal(other.sprites().length, 2);
    assert.equal(sprite.activeLayerId, sprite.layers.at(-1)!.id);
    assert.equal(sprite.activeFrame, 1);
  });
});

test("save_as .aseprite writes the whole document, hidden layers included, and the sprite then belongs to the file", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    sprite.modified = true;
    const file = path.join(dir, "all.aseprite");
    const reply = await manage(studio, { op: "save_as", path: file });
    assert.deepEqual(reply, { sprite: "all.aseprite", id: sprite.id, path: file, files: [file] });
    assert.deepEqual(decodeAse(new Uint8Array(readFileSync(file))).layers.map((l) => [l.name, l.visible]), [["Bottom", true], ["Mid", false], ["Top", true]]);
    assert.equal(sprite.filename, file);
    assert.equal(sprite.modified, false);
  });
});

test("save writes an opened .aseprite back over its file", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("indexed");
    const file = path.join(dir, "again.aseprite");
    await manage(studio, { op: "save_as", path: file });
    const second = await opened(file);
    second.sprite.layers[0]!.cels.get(1)!.image.set(0, 0, 3);
    second.sprite.modified = true;
    await manage(second.studio, { op: "save" });
    assert.equal(second.sprite.modified, false);
    assert.equal((await opened(file)).sprite.layers[0]!.cels.get(1)!.image.get(0, 0), 3);
    assert.notEqual(sprite.layers[0]!.cels.get(1)!.image.get(0, 0), 3);
  });
});

// ── what open refuses ───────────────────────────────────────────────────

async function refuses(bytes: Uint8Array, unsupported: Record<string, number>) {
  await inTempDir(async (dir) => {
    const file = write(dir, "x.aseprite", bytes);
    const studio = createStudio();
    await rejectsWith(manage(studio, { op: "open", path: file }), "unsupported_command", (err) => {
      assert.deepEqual(err.details.unsupported, unsupported);
      assert.equal(err.details.path, file);
    });
    assert.equal(studio.sprites().length, 0);
  });
}

test("open refuses a file with a layer group, counting it", async () => {
  await refuses(encodeAse(aseFile([aseLayer("img"), aseLayer("grp", { type: "group" })])), { groups: 1 });
});

test("open refuses a file with a tilemap layer, counting it", async () => {
  await refuses(mkFile([mkFrame([mkLayer("img"), mkLayer("tiles", 2)])]), { tilemapLayers: 1 });
});

test("open refuses a layer with a blend mode other than normal, counting it", async () => {
  await refuses(encodeAse(aseFile([aseLayer("img"), aseLayer("mul", { blendMode: 1 })])), { blendModes: 1 });
});


test("open refuses a cel with a z-index other than 0, counting it", async () => {
  const file = aseFile([aseLayer("img")]);
  file.frames[0]!.cels[0]!.zIndex = 2;
  await refuses(encodeAse(file), { zIndexCels: 1 });
});

test("open refuses a file with a slice or a tileset, counting each", async () => {
  await refuses(mkFile([mkFrame([mkLayer("img"), mkChunk(0x2022, [0, 0, 0, 0])])]), { slices: 1 });
  await refuses(mkFile([mkFrame([mkLayer("img"), mkChunk(0x2023, [0, 0, 0, 0]), mkChunk(0x2023, [0, 0, 0, 0])])]), { tilesets: 2 });
});

test("open refuses a palette that changes after the first frame, counting the chunks", async () => {
  const first = mkFrame([mkPalette([[1, 2, 3, 255]]), mkLayer("img")]);
  await refuses(mkFile([first, mkFrame([mkPalette([[4, 5, 6, 255]])])]), { paletteChanges: 1 });
});

test("open of a file with several unsupported features counts every kind", async () => {
  await refuses(
    encodeAse(aseFile([aseLayer("g1", { type: "group" }), aseLayer("g2", { type: "group" }), aseLayer("mul", { blendMode: 3 })])),
    { groups: 2, blendModes: 1 },
  );
});

test("open refuses by content, whatever the file is called", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "pic.png", encodeAse(aseFile([aseLayer("g", { type: "group" })])));
    await rejectsWith(manage(createStudio(), { op: "open", path: file }), "unsupported_command");
  });
});

test("open answers io_error for a truncated or corrupt .aseprite and opens nothing", async () => {
  await inTempDir(async (dir) => {
    const good = encodeAse(aseFile([aseLayer("img")]));
    const corrupt = good.slice();
    corrupt[128 + 4] = 0;
    const studio = createStudio();
    for (const [name, bytes] of [["cut.aseprite", good.subarray(0, good.length - 5)], ["bad-frame.aseprite", corrupt], ["header.aseprite", good.subarray(0, 100)]] as const) {
      await rejectsWith(manage(studio, { op: "open", path: write(dir, name, bytes) }), "io_error");
    }
    assert.equal(studio.sprites().length, 0);
  });
});

// ── what open changes to fit the model ──────────────────────────────────

test("open turns a linked cel into a copy of the cel it links to, keeping the linked cel's own position and opacity", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("img")]);
    file.frames.push({ durationMs: 50, cels: [{ layer: 0, x: 1, y: -1, opacity: 100, zIndex: 0, linkedFrame: 0 }] });
    const sprite = (await opened(write(dir, "linked.aseprite", encodeAse(file)))).sprite;
    const [first, second] = [sprite.layers[0]!.cels.get(1)!, sprite.layers[0]!.cels.get(2)!];
    assert.deepEqual([...second.image.pixels], [...first.image.pixels]);
    assert.deepEqual([second.x, second.y, second.opacity], [1, -1, 100]);
    assert.deepEqual([first.x, first.y, first.opacity], [0, 0, 255]);
    assert.notEqual(second.image, first.image);
    second.image.set(0, 0, RED);
    assert.notEqual(first.image.get(0, 0), RED);
  });
});

test("open gives a background layer opacity 255 whatever the file says, and keeps another layer's", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("Background", { background: true, opacity: 128 }), aseLayer("Ink", { opacity: 128 })]);
    const sprite = (await opened(write(dir, "bg.aseprite", encodeAse(file)))).sprite;
    assert.deepEqual(sprite.layers.map((l) => [l.name, l.opacity]), [["Background", 255], ["Ink", 128]]);
  });
});

test("open accepts a background layer whatever its blend mode", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("Background", { background: true, blendMode: 1 })]);
    const sprite = (await opened(write(dir, "bg.aseprite", encodeAse(file)))).sprite;
    assert.equal(sprite.layers.length, 1);
  });
});

test("open reads a file saved by LibreSprite 1.3 as an indexed 8x6 sprite with one layer, Background", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/libresprite-1.3.ase", import.meta.url));
  const { sprite } = await opened(fixture);
  assert.deepEqual([sprite.width, sprite.height, sprite.colorMode], [8, 6, "indexed"]);
  assert.deepEqual(sprite.layers.map((l) => l.name), ["Background"]);
  assert.deepEqual(sprite.palette, [rgba(255, 0, 0), rgba(0, 255, 0), rgba(0, 0, 255)]);
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], Array.from({ length: 48 }, (_, i) => i % 3));
  assert.equal(sprite.modified, false);
});

// ── export ──────────────────────────────────────────────────────────────

test("export.run aseprite writes the whole sprite and leaves the sprite's filename and modified alone", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    sprite.modified = true;
    const file = path.join(dir, "copy.aseprite");
    const reply = await studio.call<Reply>("export.run", { op: "aseprite", path: file });
    assert.deepEqual(reply.files, [file]);
    assert.equal(sprite.filename, null);
    assert.equal(sprite.modified, true);
    assert.deepEqual(snapshot((await opened(file)).sprite), snapshot(sprite));
  });
});

test("export.run aseprite keeps the filename of a sprite that already has one", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    const home = path.join(dir, "home.aseprite");
    await manage(studio, { op: "save_as", path: home });
    sprite.modified = true;
    await studio.call("export.run", { op: "aseprite", path: path.join(dir, "elsewhere.aseprite") });
    assert.equal(sprite.filename, home);
    assert.equal(sprite.modified, true);
    assert.ok(existsSync(path.join(dir, "elsewhere.aseprite")));
  });
});

// ── reference layers ────────────────────────────────────────────────────

test("a reference layer saves with its mark in the layer's user data, not as an Aseprite reference layer", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    sprite.layers[1]!.reference = true;
    const file = path.join(dir, "ref.aseprite");
    await manage(studio, { op: "save_as", path: file });
    const layers = decodeAse(new Uint8Array(readFileSync(file))).layers;
    assert.deepEqual(layers.map((l) => [l.reference, l.userData?.text]), [[false, undefined], [false, MARK], [false, undefined]]);
    const back = await opened(file);
    assert.deepEqual(back.sprite.layers.map((l) => l.reference === true), [false, true, false]);
    assert.equal(back.sprite.layers[1]!.aseprite, undefined);
  });
});

const NOTED = "traced from photo\npixel-ai-artist:reference\nkeep at 50%";

test("open marks a layer whose user data has the mark as one of its lines, and keeps the other lines as the layer's user data", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "noted.aseprite", encodeAse(aseFile([aseLayer("art"), aseLayer("ref", { userData: { text: NOTED } })])));
    const { sprite } = await opened(file);
    assert.deepEqual(sprite.layers.map((l) => l.reference === true), [false, true]);
    assert.equal(sprite.layers[1]!.aseprite?.userData?.text, "traced from photo\nkeep at 50%");
  });
});

test("saving a marked layer keeps its other lines and writes the mark as one last line", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "noted.aseprite", encodeAse(aseFile([aseLayer("art"), aseLayer("ref", { userData: { text: NOTED } })])));
    const { studio } = await opened(file);
    assert.equal((await savedAse(studio, dir)).layers[1]!.userData?.text, `traced from photo\nkeep at 50%\n${MARK}`);
  });
});

test("a mark repeated in a layer's user data is written once", async () => {
  await inTempDir(async (dir) => {
    const text = `first\n${MARK}\nsecond\n${MARK}`;
    const file = write(dir, "twice.aseprite", encodeAse(aseFile([aseLayer("ref", { userData: { text } })])));
    const { studio } = await opened(file);
    assert.equal((await savedAse(studio, dir)).layers[0]!.userData?.text, `first\nsecond\n${MARK}`);
  });
});

test("saving a reference layer that already has a note appends the mark and keeps the note", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "note.aseprite", encodeAse(aseFile([aseLayer("art", { userData: { text: "my note" } })])));
    const { studio, sprite } = await opened(file);
    assert.equal(sprite.layers[0]!.reference, undefined);
    sprite.layers[0]!.reference = true;
    assert.equal((await savedAse(studio, dir)).layers[0]!.userData?.text, `my note\n${MARK}`);
  });
});

test("user data that only mentions the mark does not make a reference layer, and is written back as it was", async () => {
  await inTempDir(async (dir) => {
    const texts = [
      "pixel-ai-artist:references",
      "this is NOT pixel-ai-artist:reference here",
      "xpixel-ai-artist:reference",
      "pixel-ai-artist:reference ",
      "PIXEL-AI-ARTIST:REFERENCE",
    ];
    const file = write(dir, "mentions.aseprite", encodeAse(aseFile(texts.map((text, i) => aseLayer(`note ${i}`, { userData: { text } })))));
    const { studio, sprite } = await opened(file);
    assert.deepEqual(sprite.layers.map((l) => l.reference), texts.map(() => undefined));
    assert.deepEqual(sprite.layers.map((l) => l.aseprite?.userData?.text), texts);
    assert.deepEqual((await savedAse(studio, dir)).layers.map((l) => l.userData?.text), texts);
  });
});

test("clearing the reference of an opened layer removes only the mark line, and it does not come back on reopening", async () => {
  await inTempDir(async (dir) => {
    const only = write(dir, "only.aseprite", encodeAse(aseFile([aseLayer("a", { userData: { text: NOTED } }), aseLayer("b", { userData: { text: MARK } })])));
    const { studio, sprite } = await opened(only);
    for (const layer of sprite.layers) delete layer.reference;
    const saved = await savedAse(studio, dir, "cleared.aseprite");
    assert.deepEqual(saved.layers.map((l) => l.userData?.text), ["traced from photo\nkeep at 50%", undefined]);
    const back = (await opened(path.join(dir, "cleared.aseprite"))).sprite;
    assert.deepEqual(back.layers.map((l) => l.reference), [undefined, undefined]);
  });
});

test("an Aseprite reference layer opens as a marked layer and is written back with the flag and no mark line", async () => {
  await inTempDir(async (dir) => {
    const flagged = aseLayer("ref", { reference: true, userData: { text: `note\n${MARK}` } });
    const file = write(dir, "aseref.aseprite", encodeAse(aseFile([aseLayer("art"), flagged, aseLayer("bare", { reference: true })])));
    const { studio, sprite } = await opened(file);
    assert.deepEqual(sprite.layers.map((l) => l.reference === true), [false, true, true]);
    assert.deepEqual(sprite.layers.map((l) => l.aseprite?.referenceFlag), [undefined, true, true]);
    const layers = (await savedAse(studio, dir)).layers;
    assert.deepEqual(layers.map((l) => [l.reference, l.userData?.text]), [[false, undefined], [true, "note"], [true, undefined]]);
  });
});

test("clearing the reference of an Aseprite reference layer clears its flag too and keeps its notes", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "aseref.aseprite", encodeAse(aseFile([aseLayer("ref", { reference: true, userData: { text: "note" } })])));
    const { studio, sprite } = await opened(file);
    delete sprite.layers[0]!.reference;
    const layer = (await savedAse(studio, dir)).layers[0]!;
    assert.deepEqual([layer.reference, layer.userData?.text], [false, "note"]);
  });
});

test("an unmarked layer's user data text survives a save", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "plain.aseprite", encodeAse(aseFile([aseLayer("art", { userData: { text: "just a note" } })])));
    const { studio } = await opened(file);
    assert.equal((await savedAse(studio, dir)).layers[0]!.userData?.text, "just a note");
  });
});

test("sprite.info reports the pixel aspect an opened .aseprite carries", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "wide.aseprite", encodeAse(aseFile([aseLayer("art")], { pixelRatio: { w: 2, h: 1 } })));
    const { studio } = await opened(file);
    assert.equal((await studio.call<Record<string, any>>("sprite.info")).pixelAspect, "2:1");
  });
});

// ── shared layer names ──────────────────────────────────────────────────

test("open renames layers that share a name, bottom one first, and reports each rename", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "dup.aseprite", encodeAse(aseFile([aseLayer("Ink"), aseLayer("Ink"), aseLayer("Paint"), aseLayer("Ink")])));
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: file });
    assert.deepEqual(reply.renamedLayers, [{ from: "Ink", to: "Ink 2" }, { from: "Ink", to: "Ink 3" }]);
    assert.deepEqual(studio.activeSprite()!.layers.map((l) => l.name), ["Ink", "Ink 2", "Paint", "Ink 3"]);
    assert.equal(studio.activeSprite()!.modified, false);
  });
});

test("a rename skips a number another layer in the file already uses", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "taken.aseprite", encodeAse(aseFile([aseLayer("Ink"), aseLayer("Ink"), aseLayer("Ink 2")])));
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: file });
    assert.deepEqual(reply.renamedLayers, [{ from: "Ink", to: "Ink 3" }]);
    assert.deepEqual(studio.activeSprite()!.layers.map((l) => l.name), ["Ink", "Ink 3", "Ink 2"]);
  });
});

test("open of a file whose layer names are all different reports no renames", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "fine.aseprite", encodeAse(aseFile([aseLayer("A"), aseLayer("B")])));
    const reply = await manage(createStudio(), { op: "open", path: file });
    assert.equal(reply.renamedLayers, undefined);
  });
});

test("open names the second and later empty layer names as Aseprite does, one more than the highest 'Layer N' in the file", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "empty.aseprite", encodeAse(aseFile([aseLayer("Layer 4"), aseLayer(""), aseLayer(""), aseLayer("")])));
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: file });
    assert.deepEqual(studio.activeSprite()!.layers.map((l) => l.name), ["Layer 4", "", "Layer 5", "Layer 6"]);
    assert.deepEqual(reply.renamedLayers, [{ from: "", to: "Layer 5" }, { from: "", to: "Layer 6" }]);
  });
});

test("open numbers empty layer names from Layer 1 when the file has no 'Layer N'", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "empty.aseprite", encodeAse(aseFile([aseLayer(""), aseLayer("Ink"), aseLayer("")])));
    const studio = createStudio();
    await manage(studio, { op: "open", path: file });
    assert.deepEqual(studio.activeSprite()!.layers.map((l) => l.name), ["", "Ink", "Layer 1"]);
  });
});

test("open leaves a single empty layer name empty and reports no rename", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "one.aseprite", encodeAse(aseFile([aseLayer(""), aseLayer("Ink")])));
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: file });
    assert.deepEqual(studio.activeSprite()!.layers.map((l) => l.name), ["", "Ink"]);
    assert.equal(reply.renamedLayers, undefined);
  });
});

// ── what open refuses because a save could not write it back ────────────

async function refusesAsIoError(bytes: Uint8Array, message: RegExp) {
  await inTempDir(async (dir) => {
    const studio = createStudio();
    await rejectsWith(manage(studio, { op: "open", path: write(dir, "bad.aseprite", bytes) }), "io_error", (err) => {
      assert.match(err.message, message);
    });
    assert.equal(studio.sprites().length, 0);
  });
}

test("open answers io_error, not internal_error, for a cel on a layer number the file does not have", async () => {
  await refusesAsIoError(mkFile([mkFrame([mkLayer("only"), mkCel(1, 1, 1)])]), /layer/);
  await refusesAsIoError(mkFile([mkFrame([mkCel(0, 1, 1)])]), /layer/);
});

test("open answers io_error for a file with no frames", async () => {
  await refusesAsIoError(mkFile([]), /no frames/);
});

test("open answers io_error for a tag that covers frames the file does not have", async () => {
  await refusesAsIoError(mkFile([mkFrame([mkLayer("a"), mkTags([[0, 3, "late"]])])]), /late/);
  await refusesAsIoError(mkFile([mkFrame([mkLayer("a"), mkTags([[1, 0, "backwards"]])])]), /backwards/);
});

test("open answers io_error for an indexed file whose transparent index is outside its palette", async () => {
  const file = aseFile([aseLayer("a")], { colorMode: "indexed", transparentIndex: 5 });
  file.frames[0]!.cels[0]!.image!.pixels = new Uint8Array(4);
  await refusesAsIoError(encodeAse(file), /transparent index/);
});

test("open answers io_error when the cel images together hold more than 4096 * 4096 pixels, though each is small", async () => {
  await refusesAsIoError(mkFile([mkFrame([mkLayer("a"), mkLayer("b"), mkCel(0, 4096, 2049), mkCel(1, 4096, 2049)])]), /pixels/);
});

test("open answers io_error for a cel image with no pixels", async () => {
  await refusesAsIoError(mkFile([mkFrame([mkLayer("a"), mkCel(0, 0, 0)])]), /empty/);
  await refusesAsIoError(mkFile([mkFrame([mkLayer("a"), mkCel(0, 3, 0)])]), /empty/);
});

// ── what open leaves out, and says so ───────────────────────────────────

test("open counts a linked cel whose frame has no cel to link to as skipped and still opens the file", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("img")]);
    file.frames[0]!.cels = [];
    file.frames.push({ durationMs: 50, cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 0 }] });
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: write(dir, "dangling.aseprite", encodeAse(file)) });
    assert.deepEqual(reply.skippedOnOpen, { cels: 1 });
    assert.equal(reply.lostOnSave, undefined);
    assert.deepEqual([...studio.activeSprite()!.layers[0]!.cels.keys()], []);
  });
});

test("open keeps the first of two cels on one layer and frame and counts the second as skipped", async () => {
  await inTempDir(async (dir) => {
    const first = Uint8Array.from([9, 9, 9, 255]);
    const bytes = mkFile([mkFrame([mkLayer("a"), mkCel(0, 1, 1, first), mkCel(0, 1, 1, Uint8Array.from([1, 2, 3, 255]))])]);
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: write(dir, "twice.aseprite", bytes) });
    assert.deepEqual(reply.skippedOnOpen, { cels: 1 });
    assert.deepEqual([...studio.activeSprite()!.layers[0]!.cels.get(1)!.image.pixels], [rgba(9, 9, 9)]);
  });
});

test("open counts the bytes left in a frame after its declared chunks as skipped", async () => {
  await inTempDir(async (dir) => {
    const extra = mkLayer("never read");
    const bytes = mkFile([mkFrameDeclaring([mkLayer("a"), extra], 1)]);
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: write(dir, "tail.aseprite", bytes) });
    assert.deepEqual(reply.skippedOnOpen, { frameBytes: extra.length });
    assert.deepEqual(studio.activeSprite()!.layers.map((l) => l.name), ["a"]);
  });
});

test("open of a file with nothing to leave out reports no skippedOnOpen and no lostOnSave", async () => {
  await inTempDir(async (dir) => {
    const reply = await manage(createStudio(), { op: "open", path: write(dir, "clean.aseprite", encodeAse(aseFile([aseLayer("a")]))) });
    assert.equal(reply.skippedOnOpen, undefined);
    assert.equal(reply.lostOnSave, undefined);
  });
});

// ── what a save will not write back ─────────────────────────────────────

test("open reports how many linked cels a save will write as copies", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("img")]);
    file.frames.push({ durationMs: 50, cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 0 }] });
    file.frames.push({ durationMs: 50, cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 0 }] });
    const reply = await manage(createStudio(), { op: "open", path: write(dir, "linked.aseprite", encodeAse(file)) });
    assert.deepEqual(reply.lostOnSave, { linkedCels: 2 });
  });
});

test("open reports layer UUIDs and chunks of an unknown type as lost on save, counting each", async () => {
  await inTempDir(async (dir) => {
    const unknown = mkChunk(0x7777, [1, 2, 3]);
    const bytes = mkFile([mkFrame([mkLayer("a", 0, true), mkLayer("b", 0, true), unknown, unknown])], 7);
    const reply = await manage(createStudio(), { op: "open", path: write(dir, "uuid.aseprite", bytes) });
    assert.deepEqual(reply.lostOnSave, { layerUuids: 2, unknownChunks: 2 });
  });
});

// ── what a save writes back ─────────────────────────────────────────────

const PROPS = Uint8Array.from([12, 0, 0, 0, 0, 0, 0, 0, 9, 8, 7, 6]);
const PROFILE = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
const EXTERNAL = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const CEL_EXTRA = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function carryingFile(): AseFile {
  const file = aseFile([aseLayer("art", { userData: { text: "layer note", color: [1, 2, 3, 4], properties: PROPS } })], {
    userData: { text: "sprite note", color: [5, 6, 7, 255], properties: PROPS },
    colorProfile: PROFILE,
    externalFiles: EXTERNAL,
    tags: [{ name: "walk", from: 0, to: 0, direction: "forward", repeat: 0, color: [10, 20, 30, 255], userData: { text: "tag note", properties: PROPS } }],
  });
  Object.assign(file.frames[0]!.cels[0]!, { userData: { text: "cel note", color: [8, 9, 10, 11], properties: PROPS }, extra: CEL_EXTRA });
  return file;
}

test("save_as writes back the user data of the sprite, a layer, a cel and a tag, with its text, color and properties bytes", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await opened(write(dir, "carry.aseprite", encodeAse(carryingFile())));
    const saved = await savedAse(studio, dir);
    assert.deepEqual(saved.userData, { text: "sprite note", color: [5, 6, 7, 255], properties: PROPS });
    assert.deepEqual(saved.layers[0]!.userData, { text: "layer note", color: [1, 2, 3, 4], properties: PROPS });
    assert.deepEqual(saved.frames[0]!.cels[0]!.userData, { text: "cel note", color: [8, 9, 10, 11], properties: PROPS });
    assert.deepEqual(saved.tags[0]!.userData, { text: "tag note", properties: PROPS });
    assert.deepEqual(saved.frames[0]!.cels[0]!.extra, CEL_EXTRA);
  });
});

test("save_as writes back the color profile and external files chunks byte for byte", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await opened(write(dir, "carry.aseprite", encodeAse(carryingFile())));
    const saved = await savedAse(studio, dir);
    assert.deepEqual(saved.colorProfile, PROFILE);
    assert.deepEqual(saved.externalFiles, EXTERNAL);
  });
});

test("an opened tag's color is the document tag's color, and a changed color is what save_as writes", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await opened(write(dir, "carry.aseprite", encodeAse(carryingFile())));
    assert.equal(sprite.tags[0]!.color, rgba(10, 20, 30, 255));
    assert.deepEqual((await savedAse(studio, dir, "same.aseprite")).tags[0]!.color, [10, 20, 30, 255]);
    sprite.tags[0]!.color = rgba(200, 100, 50, 255);
    assert.deepEqual((await savedAse(studio, dir, "changed.aseprite")).tags[0]!.color, [200, 100, 50, 255]);
  });
});

test("an opened layer keeps its user data in layer.aseprite.userData, apart from the reference mark", async () => {
  await inTempDir(async (dir) => {
    const { sprite } = await opened(write(dir, "carry.aseprite", encodeAse(carryingFile())));
    assert.deepEqual(sprite.layers[0]!.aseprite, { userData: { text: "layer note", color: [1, 2, 3, 4], properties: PROPS } });
  });
});

// ── what a save has to bring into range ─────────────────────────────────

test("save_as brings a frame duration outside 1..65535 into range and answers what it changed", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    sprite.frames = [{ durationMs: 0 }, { durationMs: 250 }, { durationMs: 70000 }];
    const file = path.join(dir, "range.aseprite");
    const reply = await manage(studio, { op: "save_as", path: file });
    assert.deepEqual(reply.adjustedDurations, [{ frame: 1, from: 0, to: 1 }, { frame: 3, from: 70000, to: 65535 }]);
    assert.deepEqual(decodeAse(new Uint8Array(readFileSync(file))).frames.map((f) => f.durationMs), [1, 250, 65535]);
    assert.equal(sprite.filename, file);
  });
});

test("save of an opened .aseprite brings durations into range the same way", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    const file = path.join(dir, "again.aseprite");
    await manage(studio, { op: "save_as", path: file });
    sprite.frames[1]!.durationMs = 99999;
    const reply = await manage(studio, { op: "save" });
    assert.deepEqual(reply.adjustedDurations, [{ frame: 2, from: 99999, to: 65535 }]);
  });
});

test("export.run aseprite brings durations into range and answers what it changed", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    sprite.frames[2]!.durationMs = 0;
    const file = path.join(dir, "copy.aseprite");
    const reply = await studio.call<Record<string, any>>("export.run", { op: "aseprite", path: file });
    assert.deepEqual(reply.adjustedDurations, [{ frame: 3, from: 0, to: 1 }]);
    assert.deepEqual(decodeAse(new Uint8Array(readFileSync(file))).frames.map((f) => f.durationMs), [100, 250, 1]);
  });
});

test("save_as .aseprite with a cel outside -32768..32767 is invalid_args and writes nothing", async () => {
  await inTempDir(async (dir) => {
    for (const [x, y] of [[40000, 0], [0, -32769]] as const) {
      const { studio, sprite } = await drawn("rgb");
      const cel = sprite.layers[1]!.cels.get(1)!;
      [cel.x, cel.y] = [x, y];
      const file = path.join(dir, `far${x}.aseprite`);
      await rejectsWith(manage(studio, { op: "save_as", path: file }), "invalid_args");
      assert.equal(existsSync(file), false);
      assert.equal(sprite.filename, null);
    }
  });
});

test("save_as .aseprite writes cels at -32768 and 32767", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    const cel = sprite.layers[1]!.cels.get(1)!;
    [cel.x, cel.y] = [-32768, 32767];
    const cels = (await savedAse(studio, dir)).frames[0]!.cels;
    assert.deepEqual(cels.filter((c) => c.layer === 1).map((c) => [c.x, c.y]), [[-32768, 32767]]);
  });
});

// ── linked cel chains ───────────────────────────────────────────────────

function chainedFile(): AseFile {
  const file = aseFile([aseLayer("img")]);
  const pixels = Uint8Array.from({ length: 16 }, (_, i) => i * 9);
  file.frames[0]!.cels[0]!.image = { width: 2, height: 2, pixels };
  file.frames.push({ durationMs: 50, cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 0 }] });
  file.frames.push({ durationMs: 60, cels: [{ layer: 0, x: 1, y: -1, opacity: 90, zIndex: 0, linkedFrame: 1 }] });
  return file;
}

test("open of a file whose frame 3 links to frame 2, which links to frame 1, gives all three frames the same image", async () => {
  await inTempDir(async (dir) => {
    const studio = createStudio();
    const reply = await manage(studio, { op: "open", path: write(dir, "chain.aseprite", encodeAse(chainedFile())) });
    const cels = [1, 2, 3].map((n) => studio.activeSprite()!.layers[0]!.cels.get(n)!);
    const first = [...cels[0]!.image.pixels];
    assert.equal(first.length, 4);
    assert.deepEqual(cels.map((c) => [...c.image.pixels]), [first, first, first]);
    assert.deepEqual([cels[2]!.x, cels[2]!.y, cels[2]!.opacity], [1, -1, 90]);
    assert.equal(reply.lostOnSave.linkedCels, 2);
    assert.equal(reply.skippedOnOpen, undefined);
  });
});

test("open counts chained links in lostOnSave.linkedCels, and a save writes each as its own image", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await opened(write(dir, "chain.aseprite", encodeAse(chainedFile())));
    const saved = await savedAse(studio, dir);
    assert.deepEqual(saved.frames.map((f) => f.cels[0]!.linkedFrame), [undefined, undefined, undefined]);
  });
});

test("a decoded file whose link chain does not end in an image is io_error on open", () => {
  const decoded = {
    ...chainedFile(),
    pixelRatio: { w: 1, h: 1 },
    features: { slices: 0, tilesets: 0, tilemapCels: 0, zIndexCels: 0, paletteChanges: 0, layerUuids: 0, unknownChunks: 0, droppedCels: 0, unreadFrameBytes: 0 },
  };
  decoded.frames[1]!.cels[0]!.linkedFrame = 2;
  assert.throws(() => spriteFromAse(createStudio(), decoded, "/tmp/broken.aseprite"), (err: unknown) => err instanceof ToolError && err.code === "io_error");
});

// ── header grid ─────────────────────────────────────────────────────────

test("the header grid of an opened file is kept and written back by save_as", async () => {
  await inTempDir(async (dir) => {
    const grid = { x: -4, y: 2, w: 8, h: 6 };
    const { studio } = await opened(write(dir, "grid.aseprite", encodeAse(aseFile([aseLayer("a")], { grid }))));
    assert.deepEqual((await savedAse(studio, dir)).grid, grid);
    assert.deepEqual(decodeAse(new Uint8Array(readFileSync(path.join(dir, "saved.aseprite")))).grid, grid);
  });
});

test("the header grid survives export op aseprite, and a file with no grid saves with none", async () => {
  await inTempDir(async (dir) => {
    const grid = { x: 0, y: 0, w: 16, h: 16 };
    const { studio } = await opened(write(dir, "grid.aseprite", encodeAse(aseFile([aseLayer("a")], { grid }))));
    const copy = path.join(dir, "copy.aseprite");
    await studio.call("export.run", { op: "aseprite", path: copy });
    assert.deepEqual(decodeAse(new Uint8Array(readFileSync(copy))).grid, grid);
    const plain = await opened(write(dir, "plain.aseprite", encodeAse(aseFile([aseLayer("a")]))));
    assert.equal((await savedAse(plain.studio, dir, "plain-saved.aseprite")).grid, undefined);
  });
});

// ── a background's opacity ──────────────────────────────────────────────

test("save_as .aseprite answers adjustedBackgroundOpacity for a Background layer below 255, and writes 255", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    sprite.layers[0]!.background = true;
    sprite.layers[0]!.opacity = 100;
    const file = path.join(dir, "bg.aseprite");
    const reply = await manage(studio, { op: "save_as", path: file });
    assert.deepEqual(reply.adjustedBackgroundOpacity, [{ layer: "Bottom", from: 100, to: 255 }]);
    assert.equal(decodeAse(new Uint8Array(readFileSync(file))).layers[0]!.opacity, 255);
    sprite.layers[0]!.opacity = 40;
    assert.deepEqual((await manage(studio, { op: "save" })).adjustedBackgroundOpacity, [{ layer: "Bottom", from: 40, to: 255 }]);
  });
});

test("export.run aseprite answers adjustedBackgroundOpacity, and nothing is answered when the Background is opaque or absent", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn("rgb");
    const file = path.join(dir, "copy.aseprite");
    assert.equal("adjustedBackgroundOpacity" in (await studio.call<Reply>("export.run", { op: "aseprite", path: file })), false);
    sprite.layers[0]!.background = true;
    sprite.layers[0]!.opacity = 255;
    assert.equal("adjustedBackgroundOpacity" in (await manage(studio, { op: "save_as", path: file })), false);
    sprite.layers[0]!.opacity = 7;
    sprite.layers[1]!.opacity = 7;
    const reply = await studio.call<Reply>("export.run", { op: "aseprite", path: file });
    assert.deepEqual(reply.adjustedBackgroundOpacity, [{ layer: "Bottom", from: 7, to: 255 }]);
  });
});

// ── user data whose text is empty ───────────────────────────────────────

test("user data read with an empty text is written back with it, for the sprite, a layer, a cel and a tag", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("a", { userData: { text: "" } }), aseLayer("b", { userData: { color: [1, 2, 3, 4] } })], {
      userData: { text: "" },
      tags: [{ name: "t", from: 0, to: 0, direction: "forward", repeat: 0, color: [1, 2, 3, 255], userData: { text: "" } }],
    });
    file.frames[0]!.cels[0]!.userData = { text: "" };
    const { studio } = await opened(write(dir, "empty.aseprite", encodeAse(file)));
    const saved = await savedAse(studio, dir);
    assert.equal(saved.userData?.text, "");
    assert.equal(saved.layers[0]!.userData?.text, "");
    assert.equal(saved.layers[1]!.userData?.text, undefined);
    assert.equal(saved.frames[0]!.cels[0]!.userData?.text, "");
    assert.equal(saved.tags[0]!.userData?.text, "");
  });
});

test("an object with no user data in the file is saved with none", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await opened(write(dir, "bare.aseprite", encodeAse(aseFile([aseLayer("a")]))));
    const saved = await savedAse(studio, dir);
    assert.deepEqual([saved.userData, saved.layers[0]!.userData, saved.frames[0]!.cels[0]!.userData], [undefined, undefined, undefined]);
  });
});

// ── Background layers that are not alone at the bottom ──────────────────

test("open answers misplacedBackground with the name of a Background that is not the bottom layer", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("Ink"), aseLayer("Paper", { background: true })]);
    const reply = await manage(createStudio(), { op: "open", path: write(dir, "high.aseprite", encodeAse(file)) });
    assert.deepEqual(reply.misplacedBackground, ["Paper"]);
  });
});

test("open answers misplacedBackground with every Background when there are several, even at the bottom", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("Base", { background: true }), aseLayer("Ink"), aseLayer("Paper", { background: true })]);
    const reply = await manage(createStudio(), { op: "open", path: write(dir, "two.aseprite", encodeAse(file)) });
    assert.deepEqual(reply.misplacedBackground, ["Base", "Paper"]);
  });
});

test("open answers no misplacedBackground for one Background at the bottom, or for none", async () => {
  await inTempDir(async (dir) => {
    for (const layers of [[aseLayer("Paper", { background: true }), aseLayer("Ink")], [aseLayer("Ink")]]) {
      const reply = await manage(createStudio(), { op: "open", path: write(dir, "fine.aseprite", encodeAse(aseFile(layers))) });
      assert.equal("misplacedBackground" in reply, false);
    }
  });
});

test("the sprite_manage tool's reply text names a misplaced Background layer, and says nothing of it otherwise", async () => {
  await inTempDir(async (dir) => {
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const text = (r: { content?: unknown }) => (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    const high = write(dir, "high.aseprite", encodeAse(aseFile([aseLayer("Ink"), aseLayer("Paper", { background: true })])));
    const res = await client.callTool({ name: "sprite_manage", arguments: { op: "open", path: high } });
    assert.ok(!res.isError, text(res));
    assert.deepEqual((res.structuredContent as Reply).misplacedBackground, ["Paper"]);
    assert.match(text(res), /Background layers not alone at the bottom: 'Paper'/);
    const fine = write(dir, "fine.aseprite", encodeAse(aseFile([aseLayer("Paper", { background: true })])));
    assert.doesNotMatch(text(await client.callTool({ name: "sprite_manage", arguments: { op: "open", path: fine } })), /Background layers not alone/);
    await server.close();
  });
});

// ── the reference mark in CRLF text ───────────────────────────────────

test("a CRLF text that already ends its last line is written back as it was, with the mark as that line", async () => {
  await inTempDir(async (dir) => {
    const text = `x\r\n${MARK}\r\n`;
    const { studio } = await opened(write(dir, "tail.aseprite", encodeAse(aseFile([aseLayer("ref", { userData: { text } })]))));
    assert.equal((await savedAse(studio, dir)).layers[0]!.userData?.text, text);
  });
});

test("a mark line ending in CRLF is found, and the rest of the text keeps its CRLF", async () => {
  await inTempDir(async (dir) => {
    const text = `first\r\n${MARK}\r\nsecond\r\nthird`;
    const { sprite } = await opened(write(dir, "crlf.aseprite", encodeAse(aseFile([aseLayer("ref", { userData: { text } })]))));
    assert.equal(sprite.layers[0]!.reference, true);
    assert.equal(sprite.layers[0]!.aseprite?.userData?.text, "first\r\nsecond\r\nthird");
  });
});

test("a mark on the last line, or alone, leaves no stray CR behind", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([
      aseLayer("last", { userData: { text: `one\r\ntwo\r\n${MARK}` } }),
      aseLayer("alone", { userData: { text: `${MARK}\r\n` } }),
      aseLayer("stray", { userData: { text: `one\r\n${MARK}\r` } }),
    ]);
    const { sprite } = await opened(write(dir, "edge.aseprite", encodeAse(file)));
    assert.deepEqual(sprite.layers.map((l) => l.reference), [true, true, true]);
    assert.deepEqual(sprite.layers.map((l) => l.aseprite?.userData?.text), ["one\r\ntwo", "", "one"]);
  });
});

test("saving a reference layer whose text uses CRLF adds the mark line with CRLF, and a text with only LF gets LF", async () => {
  await inTempDir(async (dir) => {
    const file = aseFile([aseLayer("crlf", { userData: { text: "a\r\nb" } }), aseLayer("lf", { userData: { text: "a\nb" } })]);
    const { studio, sprite } = await opened(write(dir, "add.aseprite", encodeAse(file)));
    for (const layer of sprite.layers) layer.reference = true;
    const saved = await savedAse(studio, dir);
    assert.deepEqual(saved.layers.map((l) => l.userData?.text), [`a\r\nb\r\n${MARK}`, `a\nb\n${MARK}`]);
    const back = (await opened(path.join(dir, "saved.aseprite"))).sprite;
    assert.deepEqual(back.layers.map((l) => [l.reference, l.aseprite?.userData?.text]), [[true, "a\r\nb"], [true, "a\nb"]]);
  });
});
