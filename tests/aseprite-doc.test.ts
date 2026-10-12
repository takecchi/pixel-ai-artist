import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
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

function mkFile(frames: number[][]): Uint8Array {
  const body = frames.flat();
  const head = new B().u32(128 + body.length).u16(0xa5e0).u16(frames.length).u16(2).u16(2).u16(32).u32(3).u16(100).zeros(128 - 20);
  return Uint8Array.from([...head.bytes, ...body]);
}

const mkLayer = (name: string, type = 0) =>
  mkChunk(0x2004, new B().u16(3).u16(type).u16(0).u16(0).u16(0).u16(0).u8(255).zeros(3).str(name).raw(type === 2 ? [0, 0, 0, 0] : []));
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
    assert.deepEqual(reply, { sprite: "all.aseprite", id: sprite.id, path: file });
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
    assert.deepEqual(layers.map((l) => [l.reference, l.text]), [[false, undefined], [false, "pixel-ai-artist:reference"], [false, undefined]]);
    const back = await opened(file);
    assert.deepEqual(back.sprite.layers.map((l) => l.reference === true), [false, true, false]);
  });
});

test("open marks a layer whose user data contains the mark among other notes, and saving keeps the notes", async () => {
  await inTempDir(async (dir) => {
    const noted = "traced from photo\npixel-ai-artist:reference\nkeep at 50%";
    const file = write(dir, "noted.aseprite", encodeAse(aseFile([aseLayer("art"), aseLayer("ref", { text: noted })])));
    const { studio, sprite } = await opened(file);
    assert.deepEqual(sprite.layers.map((l) => l.reference === true), [false, true]);
    const again = path.join(dir, "again.aseprite");
    await manage(studio, { op: "save_as", path: again });
    assert.equal(decodeAse(new Uint8Array(readFileSync(again))).layers[1]!.text, noted);
  });
});

test("saving a reference layer that already has a note appends the mark and keeps the note", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "note.aseprite", encodeAse(aseFile([aseLayer("art", { text: "my note" })])));
    const { studio, sprite } = await opened(file);
    assert.equal(sprite.layers[0]!.reference, undefined);
    sprite.layers[0]!.reference = true;
    const again = path.join(dir, "again.aseprite");
    await manage(studio, { op: "save_as", path: again });
    assert.equal(decodeAse(new Uint8Array(readFileSync(again))).layers[0]!.text, "my note\npixel-ai-artist:reference");
  });
});

test("an Aseprite reference layer opens as a marked ordinary layer and is written back without the flag", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "aseref.aseprite", encodeAse(aseFile([aseLayer("art"), aseLayer("ref", { reference: true })])));
    const { studio, sprite } = await opened(file);
    assert.deepEqual(sprite.layers.map((l) => l.reference === true), [false, true]);
    const again = path.join(dir, "again.aseprite");
    await manage(studio, { op: "save_as", path: again });
    const ref = decodeAse(new Uint8Array(readFileSync(again))).layers[1]!;
    assert.deepEqual([ref.reference, ref.text], [false, "pixel-ai-artist:reference"]);
  });
});

test("an unmarked layer's user data text survives a save", async () => {
  await inTempDir(async (dir) => {
    const file = write(dir, "plain.aseprite", encodeAse(aseFile([aseLayer("art", { text: "just a note" })])));
    const { studio } = await opened(file);
    const again = path.join(dir, "again.aseprite");
    await manage(studio, { op: "save_as", path: again });
    assert.equal(decodeAse(new Uint8Array(readFileSync(again))).layers[0]!.text, "just a note");
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
