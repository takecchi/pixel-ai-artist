import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { decodeAse, encodeAse } from "../dist/lib/ase.js";
import type { AseFile, AseLayer } from "../dist/lib/ase.js";

function layer(name: string, extra: Partial<AseLayer> = {}): AseLayer {
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

function rgbaPalette(colors: number[][]): Uint8Array {
  return Uint8Array.from(colors.flat());
}

function sample(mode: "rgba" | "grayscale" | "indexed"): AseFile {
  const bpp = mode === "rgba" ? 4 : mode === "grayscale" ? 2 : 1;
  const px = (w: number, h: number, seed: number) =>
    Uint8Array.from({ length: w * h * bpp }, (_, i) => (i * 37 + seed) & 0xff);
  return {
    width: 5,
    height: 4,
    colorMode: mode,
    transparentIndex: mode === "indexed" ? 1 : 0,
    palette: rgbaPalette([
      [0, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]),
    layers: [
      layer("bottom", { background: true, editable: false }),
      layer("group", { type: "group", opacity: 128 }),
      layer("child", { childLevel: 1, visible: false, blendMode: 1, opacity: 77 }),
    ],
    frames: [
      {
        durationMs: 100,
        cels: [
          { layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, image: { width: 5, height: 4, pixels: px(5, 4, 1) } },
          { layer: 2, x: -3, y: 2, opacity: 200, zIndex: -1, image: { width: 2, height: 3, pixels: px(2, 3, 9) } },
        ],
      },
      {
        durationMs: 250,
        cels: [
          { layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 0 },
          { layer: 2, x: 1, y: 1, opacity: 255, zIndex: 3, image: { width: 1, height: 1, pixels: px(1, 1, 5) } },
        ],
      },
    ],
    tags: [],
  };
}

const NO_FEATURES = { slices: 0, tilesets: 0, tilemapCels: 0, zIndexCels: 0, paletteChanges: 0 };

/** The decoded file without what decoding adds: features, and the 1:1 pixel ratio every sample has. */
function stripFeatures(f: ReturnType<typeof decodeAse>): AseFile {
  const { features: _f, pixelRatio, ...rest } = f;
  assert.deepEqual(pixelRatio, { w: 1, h: 1 });
  return rest;
}

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

function mkChunk(type: number, body: B | number[]): number[] {
  const b = Array.isArray(body) ? body : body.bytes;
  return new B().u32(b.length + 6).u16(type).raw(b).bytes;
}

function mkFrame(chunks: number[][], duration: number, oldCount?: number, newCount?: number): number[] {
  const body = chunks.flat();
  return new B()
    .u32(16 + body.length)
    .u16(0xf1fa)
    .u16(oldCount ?? chunks.length)
    .u16(duration)
    .zeros(2)
    .u32(newCount ?? chunks.length)
    .raw(body).bytes;
}

function mkFile(
  frames: number[][],
  opts: { depth?: number; flags?: number; speed?: number; w?: number; h?: number; magic?: number } = {},
): Uint8Array {
  const body = frames.flat();
  const head = new B()
    .u32(128 + body.length)
    .u16(opts.magic ?? 0xa5e0)
    .u16(frames.length)
    .u16(opts.w ?? 2)
    .u16(opts.h ?? 2)
    .u16(opts.depth ?? 32)
    .u32(opts.flags ?? 1)
    .u16(opts.speed ?? 100)
    .zeros(128 - 20);
  return Uint8Array.from([...head.bytes, ...body]);
}

function mkLayerChunk(name: string, type = 0, withTileset = false, withUuid = false): number[] {
  const b = new B().u16(3).u16(type).u16(0).u16(0).u16(0).u16(0).u8(255).zeros(3).str(name);
  if (withTileset) b.u32(7);
  if (withUuid) b.zeros(16);
  return mkChunk(0x2004, b);
}

function chunkTypes(bytes: Uint8Array): number[] {
  const types: number[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(128 + 12, true);
  let pos = 128 + 16;
  for (let i = 0; i < count; i++) {
    types.push(dv.getUint16(pos + 4, true));
    pos += dv.getUint32(pos, true);
  }
  return types;
}

for (const mode of ["rgba", "grayscale", "indexed"] as const) {
  test(`round trips a ${mode} sprite with layers, cels and linked cels unchanged`, () => {
    const file = sample(mode);
    const decoded = decodeAse(encodeAse(file));
    assert.deepEqual(stripFeatures(decoded), file);
    assert.deepEqual(decoded.features, { ...NO_FEATURES, zIndexCels: 2 });
  });
}

test("writes the header with real file length, magic, depth, flags, speed and color count", () => {
  const file = sample("grayscale");
  const bytes = encodeAse(file);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0, true), bytes.length);
  assert.equal(dv.getUint16(4, true), 0xa5e0);
  assert.equal(dv.getUint16(6, true), 2);
  assert.equal(dv.getUint16(8, true), 5);
  assert.equal(dv.getUint16(10, true), 4);
  assert.equal(dv.getUint16(12, true), 16);
  assert.equal(dv.getUint32(14, true), 3);
  assert.equal(dv.getUint16(18, true), 100);
  assert.equal(dv.getUint16(32, true), 4);
  assert.equal(bytes[34], 1);
  assert.equal(bytes[35], 1);
  assert.equal(dv.getUint16(40, true), 0);
  assert.equal(dv.getUint16(42, true), 0);
});

test("a 256 color palette is announced as 256 in the header and round trips", () => {
  const file = sample("rgba");
  file.palette = Uint8Array.from({ length: 1024 }, (_, i) => (i % 4 === 3 ? 255 : i >> 2));
  const bytes = encodeAse(file);
  assert.equal(new DataView(bytes.buffer).getUint16(32, true), 256);
  assert.deepEqual(decodeAse(bytes).palette, file.palette);
});

test("writes frame headers with the real chunk count in both count fields", () => {
  const file = sample("rgba");
  const bytes = encodeAse(file);
  const dv = new DataView(bytes.buffer);
  const first = 128;
  const firstSize = dv.getUint32(first, true);
  assert.equal(dv.getUint16(first + 4, true), 0xf1fa);
  assert.equal(dv.getUint16(first + 6, true), chunkTypes(bytes).length);
  assert.equal(dv.getUint32(first + 12, true), chunkTypes(bytes).length);
  assert.equal(dv.getUint16(first + 8, true), 100);
  const second = first + firstSize;
  assert.equal(dv.getUint16(second + 6, true), 2);
  assert.equal(dv.getUint32(second + 12, true), 2);
  assert.equal(dv.getUint16(second + 8, true), 250);
});

test("writes chunks of the first frame in palette, layer, tag, cel order", () => {
  const file = sample("rgba");
  file.tags = [{ name: "t", from: 0, to: 1, direction: "forward", repeat: 0, color: [1, 2, 3, 4] }];
  const types = chunkTypes(encodeAse(file));
  assert.deepEqual(types, [0x0004, 0x2019, 0x2004, 0x2004, 0x2004, 0x2018, 0x2020, 0x2005, 0x2005]);
});

test("round trips tags with direction, repeat, name and color", () => {
  const file = sample("rgba");
  file.tags = [
    { name: "walk", from: 0, to: 1, direction: "forward", repeat: 0, color: [10, 20, 30, 255] },
    { name: "日本語", from: 1, to: 1, direction: "pingpong_reverse", repeat: 3, color: [255, 0, 128, 40] },
    { name: "back", from: 0, to: 0, direction: "reverse", repeat: 1, color: [0, 0, 0, 0] },
    { name: "pp", from: 0, to: 1, direction: "pingpong", repeat: 65535, color: [1, 2, 3, 4] },
  ];
  assert.deepEqual(decodeAse(encodeAse(file)).tags, file.tags);
});

test("writes the tag color into the deprecated RGB bytes of the tags chunk too", () => {
  const file = sample("rgba");
  file.tags = [{ name: "x", from: 0, to: 0, direction: "forward", repeat: 0, color: [9, 8, 7, 6] }];
  const bytes = encodeAse(file);
  const dv = new DataView(bytes.buffer);
  let pos = 128 + 16;
  for (;;) {
    if (dv.getUint16(pos + 4, true) === 0x2018) break;
    pos += dv.getUint32(pos, true);
  }
  const entry = pos + 6 + 10;
  assert.deepEqual([...bytes.subarray(entry + 13, entry + 17)], [9, 8, 7, 0]);
  const ud = pos + dv.getUint32(pos, true);
  assert.equal(dv.getUint16(ud + 4, true), 0x2020);
  assert.equal(dv.getUint32(ud + 6, true), 2);
  assert.deepEqual([...bytes.subarray(ud + 10, ud + 14)], [9, 8, 7, 6]);
});

test("decoder takes the tag color from the old RGB bytes when no user data follows", () => {
  const tags = new B().u16(1).zeros(8).u16(0).u16(0).u8(0).u16(0).zeros(6).u8(11).u8(22).u8(33).u8(0).str("a").bytes;
  const file = mkFile([mkFrame([mkLayerChunk("L"), mkChunk(0x2018, tags)], 10)]);
  assert.deepEqual(decodeAse(file).tags[0]!.color, [11, 22, 33, 255]);
});

test("decoder assigns user data colors to tags in order and ignores text and properties", () => {
  const tag = (name: string) => new B().u16(0).u16(0).u8(0).u16(0).zeros(6).zeros(3).u8(0).str(name).bytes;
  const tags = new B().u16(2).zeros(8).raw(tag("a")).raw(tag("b")).bytes;
  const ud1 = new B().u32(1 | 2 | 4).str("note").u8(1).u8(2).u8(3).u8(4).u32(12).u32(1).u32(0).u32(0).bytes;
  const ud2 = new B().u32(2).u8(5).u8(6).u8(7).u8(8).bytes;
  const file = mkFile([
    mkFrame([mkLayerChunk("L"), mkChunk(0x2018, tags), mkChunk(0x2020, ud1), mkChunk(0x2020, ud2)], 10),
  ]);
  const d = decodeAse(file);
  assert.deepEqual(d.tags.map((t) => t.color), [[1, 2, 3, 4], [5, 6, 7, 8]]);
});

test("a user data chunk that does not follow the tags chunk does not change tag colors", () => {
  const tags = new B().u16(1).zeros(8).u16(0).u16(0).u8(0).u16(0).zeros(6).u8(1).u8(1).u8(1).u8(0).str("a").bytes;
  const ud = new B().u32(2).u8(9).u8(9).u8(9).u8(9).bytes;
  const file = mkFile([
    mkFrame([mkChunk(0x2018, tags), mkLayerChunk("L"), mkChunk(0x2020, ud)], 10),
  ]);
  assert.deepEqual(decodeAse(file).tags[0]!.color, [1, 1, 1, 255]);
});

test("round trips the user data text of a layer, written right after its layer chunk", () => {
  const file = sample("rgba");
  file.layers[0]!.text = "pixel-ai-artist:reference";
  const bytes = encodeAse(file);
  const types = chunkTypes(bytes);
  assert.equal(types[types.indexOf(0x2004) + 1], 0x2020);
  const d = decodeAse(bytes);
  assert.equal(d.layers[0]!.text, "pixel-ai-artist:reference");
  assert.equal(d.layers[1]!.text, undefined);
});

test("decoder takes a layer's text only from a user data chunk right after it, and one with just a colour gives none", () => {
  const withText = new B().u32(1 | 2).str("note").u8(1).u8(2).u8(3).u8(4).bytes;
  const colourOnly = new B().u32(2).u8(9).u8(9).u8(9).u8(9).bytes;
  const file = mkFile([
    mkFrame([mkLayerChunk("A"), mkChunk(0x2020, withText), mkLayerChunk("B"), mkChunk(0x2020, colourOnly), mkLayerChunk("C")], 10),
  ]);
  assert.deepEqual(decodeAse(file).layers.map((l) => l.text), ["note", undefined, undefined]);
});

test("a layer's user data does not take a tag's colour, and tag user data still goes to the tags", () => {
  const tags = new B().u16(1).zeros(8).u16(0).u16(0).u8(0).u16(0).zeros(6).u8(1).u8(1).u8(1).u8(0).str("a").bytes;
  const layerText = new B().u32(1).str("mine").bytes;
  const tagColour = new B().u32(2).u8(5).u8(6).u8(7).u8(8).bytes;
  const file = mkFile([
    mkFrame([mkLayerChunk("L"), mkChunk(0x2020, layerText), mkChunk(0x2018, tags), mkChunk(0x2020, tagColour)], 10),
  ]);
  const d = decodeAse(file);
  assert.equal(d.layers[0]!.text, "mine");
  assert.deepEqual(d.tags[0]!.color, [5, 6, 7, 8]);
});

test("writes the old palette chunk only for opaque palettes of at most 256 colors", () => {
  const opaque = sample("rgba");
  assert.deepEqual(chunkTypes(encodeAse(opaque)).slice(0, 2), [0x0004, 0x2019]);

  const withAlpha = sample("rgba");
  withAlpha.palette = rgbaPalette([[1, 2, 3, 255], [4, 5, 6, 254]]);
  assert.deepEqual(chunkTypes(encodeAse(withAlpha)).slice(0, 2), [0x2019, 0x2004]);
  assert.deepEqual(decodeAse(encodeAse(withAlpha)).palette, withAlpha.palette);

  const many = sample("rgba");
  many.palette = Uint8Array.from({ length: 257 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i >> 2) & 0xff));
  assert.deepEqual(chunkTypes(encodeAse(many)).slice(0, 2), [0x2019, 0x2004]);
  assert.deepEqual(decodeAse(encodeAse(many)).palette, many.palette);
});

test("an empty palette round trips as an empty palette", () => {
  const file = sample("rgba");
  file.palette = new Uint8Array(0);
  assert.equal(decodeAse(encodeAse(file)).palette.length, 0);
});

test("decoder reads the old 0x0004 palette and skips entries across packets", () => {
  const pal = new B().u16(2).u8(0).u8(2).raw([1, 2, 3, 4, 5, 6]).u8(1).u8(1).raw([7, 8, 9]).bytes;
  const d = decodeAse(mkFile([mkFrame([mkChunk(0x0004, pal)], 10)]));
  assert.deepEqual([...d.palette], [1, 2, 3, 255, 4, 5, 6, 255, 0, 0, 0, 255, 7, 8, 9, 255]);
});

test("decoder expands 6 bit 0x0011 palette values to 8 bits", () => {
  const pal = new B().u16(1).u8(0).u8(3).raw([0, 63, 32, 1, 2, 62, 16, 8, 4]).bytes;
  const d = decodeAse(mkFile([mkFrame([mkChunk(0x0011, pal)], 10)]));
  assert.deepEqual([...d.palette], [0, 255, 130, 255, 4, 8, 251, 255, 65, 32, 16, 255]);
});

test("decoder treats a packet color count of 0 as 256 colors", () => {
  const pal = new B().u16(1).u8(0).u8(0).raw(new Array(768).fill(5)).bytes;
  const d = decodeAse(mkFile([mkFrame([mkChunk(0x0004, pal)], 10)]));
  assert.equal(d.palette.length, 1024);
});

test("decoder ignores old palettes when a new palette chunk exists, in either order", () => {
  const old = mkChunk(0x0004, new B().u16(1).u8(0).u8(1).raw([1, 1, 1]));
  const fresh = mkChunk(0x2019, new B().u32(1).u32(0).u32(0).zeros(8).u16(0).raw([9, 8, 7, 6]));
  for (const chunks of [[old, fresh], [fresh, old]]) {
    const d = decodeAse(mkFile([mkFrame(chunks, 10)]));
    assert.deepEqual([...d.palette], [9, 8, 7, 6]);
  }
});

test("decoder skips palette entry names in the new palette chunk", () => {
  const body = new B().u32(2).u32(0).u32(1).zeros(8).u16(1).raw([1, 2, 3, 4]).str("named").u16(0).raw([5, 6, 7, 8]);
  const d = decodeAse(mkFile([mkFrame([mkChunk(0x2019, body)], 10)]));
  assert.deepEqual([...d.palette], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("decoder skips the tileset index of tilemap layers and the UUID when the header says layers have one", () => {
  const frame = mkFrame(
    [mkLayerChunk("tiles", 2, true, true), mkLayerChunk("after", 0, false, true)],
    10,
  );
  const d = decodeAse(mkFile([frame], { flags: 1 | 4 }));
  assert.deepEqual(d.layers.map((l) => [l.name, l.type]), [["tiles", "tilemap"], ["after", "image"]]);
});

test("decoder does not skip a UUID when the header flag for it is not set", () => {
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("a"), mkLayerChunk("b", 1)], 10)], { flags: 1 }));
  assert.deepEqual(d.layers.map((l) => [l.name, l.type]), [["a", "image"], ["b", "group"]]);
});

test("layer opacity is 255 when the header does not mark it as valid", () => {
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("a")], 10)], { flags: 0 }));
  assert.equal(d.layers[0]!.opacity, 255);
});

test("decoder reads raw (type 0) cels and rejects a raw cel with too little data", () => {
  const cel = (data: number[]) =>
    mkChunk(0x2005, new B().u16(0).u16(1).u16(2).u8(255).u16(0).u16(0).zeros(5).u16(1).u16(2).raw(data));
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("a"), cel([1, 2, 3, 4, 5, 6, 7, 8])], 10)]));
  const c = d.frames[0]!.cels[0]!;
  assert.deepEqual([c.x, c.y, c.opacity, c.zIndex], [1, 2, 255, 0]);
  assert.deepEqual([...c.image!.pixels], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => decodeAse(mkFile([mkFrame([mkLayerChunk("a"), cel([1, 2, 3])], 10)])), Error);
});

test("decoder rejects a compressed cel whose data has the wrong size", () => {
  const z = deflateSync(Uint8Array.from([1, 2, 3]));
  const cel = mkChunk(0x2005, new B().u16(0).u16(0).u16(0).u8(255).u16(2).u16(0).zeros(5).u16(1).u16(1).raw(z));
  assert.throws(() => decodeAse(mkFile([mkFrame([mkLayerChunk("a"), cel], 10)])), Error);
});

test("tilemap cels are kept without an image or link and counted in features", () => {
  const tm = () =>
    mkChunk(
      0x2005,
      new B().u16(0).u16(0).u16(0).u8(255).u16(3).u16(0).zeros(5).u16(1).u16(1).u16(32).u32(0x1fffffff).u32(0x80000000).u32(0x40000000).u32(0x20000000).zeros(10).raw(deflateSync(new Uint8Array(4))),
    );
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("t", 2, true), tm()], 10), mkFrame([tm()], 10)]));
  assert.equal(d.frames[0]!.cels.length, 1);
  assert.equal(d.frames[0]!.cels[0]!.image, undefined);
  assert.equal(d.frames[0]!.cels[0]!.linkedFrame, undefined);
  assert.equal(d.frames[0]!.cels[0]!.tilemap, true);
  assert.equal(d.frames[1]!.cels.length, 1);
  assert.deepEqual(d.features, { ...NO_FEATURES, tilemapCels: 2 });
  assert.equal(d.layers[0]!.type, "tilemap");
});

test("every slice chunk and tileset chunk is counted in features", () => {
  const slice = () => mkChunk(0x2022, new B().u32(0).u32(0).u32(0).str("s"));
  const tileset = () => mkChunk(0x2023, new B().u32(0).u32(0).u32(0).u16(8).u16(8).u16(1).zeros(14).str("ts"));
  const d = decodeAse(mkFile([mkFrame([slice(), tileset(), slice(), tileset(), slice()], 10)]));
  assert.deepEqual(d.features, { ...NO_FEATURES, slices: 3, tilesets: 2 });
});

test("a slice with 9-patch and pivot keys does not disturb the chunks after it", () => {
  const slice = mkChunk(
    0x2022,
    new B().u32(2).u32(3).u32(0).str("s")
      .u32(0).u32(1).u32(2).u32(3).u32(4).u32(5).u32(6).u32(7).u32(8).u32(9).u32(10)
      .u32(1).u32(1).u32(2).u32(3).u32(4).u32(5).u32(6).u32(7).u32(8).u32(9).u32(10),
  );
  const d = decodeAse(mkFile([mkFrame([slice, mkLayerChunk("after")], 10)]));
  assert.equal(d.features.slices, 1);
  assert.equal(d.layers[0]!.name, "after");
});

test("a file without slices, tilesets, tilemap cels or z-index has all features at zero", () => {
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("a")], 10)]));
  assert.deepEqual(d.features, NO_FEATURES);
});

test("cels with a nonzero z-index are counted and keep their z-index", () => {
  const cel = (z: number) =>
    mkChunk(0x2005, new B().u16(0).u16(0).u16(0).u8(255).u16(1).u16(z).zeros(5).u16(0));
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("a"), cel(0)], 10), mkFrame([cel(-2)], 10), mkFrame([cel(5)], 10)]));
  assert.equal(d.features.zIndexCels, 2);
  assert.deepEqual(d.frames.map((f) => f.cels[0]!.zIndex), [0, -2, 5]);
});

test("palette chunks after the first frame are counted as palette changes", () => {
  const pal = () => mkChunk(0x2019, new B().u32(1).u32(0).u32(0).zeros(8).u16(0).raw([1, 2, 3, 4]));
  const old = () => mkChunk(0x0004, new B().u16(1).u8(0).u8(1).raw([1, 2, 3]));
  const d = decodeAse(mkFile([mkFrame([pal()], 10), mkFrame([pal(), old()], 10)]));
  assert.equal(d.features.paletteChanges, 2);
  assert.equal(decodeAse(mkFile([mkFrame([pal()], 10)])).features.paletteChanges, 0);
});

test("layer blend mode and type are returned as stored", () => {
  const lay = (name: string, type: number, blend: number) =>
    mkChunk(0x2004, new B().u16(3).u16(type).u16(0).u16(0).u16(0).u16(blend).u8(255).zeros(3).str(name));
  const d = decodeAse(mkFile([mkFrame([lay("m", 0, 1), lay("g", 1, 18)], 10)], { flags: 3 }));
  assert.deepEqual(d.layers.map((l) => [l.type, l.blendMode]), [["image", 1], ["group", 18]]);
});

test("a group layer's blend mode and opacity are ignored unless header flag 2 is set", () => {
  const lay = (type: number) =>
    mkChunk(0x2004, new B().u16(3).u16(type).u16(0).u16(0).u16(0).u16(4).u8(90).zeros(3).str("l"));
  const frame = mkFrame([lay(0), lay(1)], 10);
  const without = decodeAse(mkFile([frame], { flags: 1 }));
  assert.deepEqual(without.layers.map((l) => [l.blendMode, l.opacity]), [[4, 90], [0, 255]]);
  const withFlag = decodeAse(mkFile([frame], { flags: 3 }));
  assert.deepEqual(withFlag.layers.map((l) => [l.blendMode, l.opacity]), [[4, 90], [4, 90]]);
});

test("decoder reads every layer flag", () => {
  const flags = (f: number) =>
    mkChunk(0x2004, new B().u16(f).u16(0).u16(0).u16(0).u16(0).u16(0).u8(255).zeros(3).str("l"));
  const l = decodeAse(mkFile([mkFrame([flags(1 | 2 | 4 | 8 | 16 | 32 | 64), flags(0)], 10)])).layers;
  assert.deepEqual(
    l.map((x) => [x.visible, x.editable, x.lockMovement, x.background, x.preferLinkedCels, x.collapsed, x.reference]),
    [new Array(7).fill(true), new Array(7).fill(false)],
  );
});

test("layer flags round trip one by one", () => {
  for (const key of ["visible", "editable", "lockMovement", "background", "preferLinkedCels", "collapsed", "reference"] as const) {
    const file = sample("rgba");
    file.layers = [layer("a", { visible: false, editable: false, [key]: true })];
    file.frames = [{ durationMs: 10, cels: [] }];
    const l = decodeAse(encodeAse(file)).layers[0]!;
    assert.deepEqual(l, file.layers[0], key);
  }
});

test("layer flag 64 is the reference flag in the written bytes", () => {
  const file = sample("rgba");
  file.layers = [layer("a", { reference: true, visible: false, editable: false })];
  file.frames = [{ durationMs: 10, cels: [] }];
  const types = chunkTypes(encodeAse(file));
  assert.deepEqual(types, [0x0004, 0x2019, 0x2004]);
  const bytes = encodeAse(file);
  const dv = new DataView(bytes.buffer);
  let pos = 128 + 16;
  while (dv.getUint16(pos + 4, true) !== 0x2004) pos += dv.getUint32(pos, true);
  assert.equal(dv.getUint16(pos + 6, true), 64);
});

test("a group layer's blend mode and opacity survive a round trip", () => {
  const file = sample("rgba");
  file.layers = [layer("g", { type: "group", blendMode: 15, opacity: 33 })];
  file.frames = [{ durationMs: 10, cels: [] }];
  assert.deepEqual(decodeAse(encodeAse(file)).layers, file.layers);
});

test("blend modes 0 to 18 round trip", () => {
  const file = sample("rgba");
  file.layers = Array.from({ length: 19 }, (_, i) => layer(`b${i}`, { blendMode: i }));
  file.frames = [{ durationMs: 10, cels: [] }];
  assert.deepEqual(decodeAse(encodeAse(file)).layers.map((l) => l.blendMode), file.layers.map((l) => l.blendMode));
});

test("the encoder refuses tilemap layers and tilemap cels", () => {
  const file = sample("rgba");
  file.layers.push(layer("t", { type: "tilemap" }));
  assert.throws(() => encodeAse(file), RangeError);
  const cels = sample("rgba");
  cels.frames[0]!.cels[0]!.tilemap = true;
  assert.throws(() => encodeAse(cels), RangeError);
});

test("the encoder rejects a frame duration of 0, which would read back as the header speed", () => {
  const file = sample("rgba");
  file.frames[1]!.durationMs = 0;
  assert.throws(() => encodeAse(file), RangeError);
});

test("grayscale pixels are read as value then alpha, indexed pixels as one index", () => {
  const raw = (data: number[]) =>
    mkChunk(0x2005, new B().u16(0).u16(0).u16(0).u8(255).u16(0).u16(0).zeros(5).u16(2).u16(1).raw(data));
  const gray = decodeAse(mkFile([mkFrame([mkLayerChunk("a"), raw([200, 7, 9, 255])], 10)], { depth: 16 }));
  assert.equal(gray.colorMode, "grayscale");
  assert.deepEqual([...gray.frames[0]!.cels[0]!.image!.pixels], [200, 7, 9, 255]);
  const indexed = decodeAse(mkFile([mkFrame([mkLayerChunk("a"), raw([3, 0])], 10)], { depth: 8 }));
  assert.deepEqual([...indexed.frames[0]!.cels[0]!.image!.pixels], [3, 0]);
});

test("the header transparent index is returned for indexed sprites without changing pixels", () => {
  const file = sample("indexed");
  file.transparentIndex = 2;
  const d = decodeAse(encodeAse(file));
  assert.equal(d.transparentIndex, 2);
  assert.deepEqual(d.frames[0]!.cels[0]!.image, file.frames[0]!.cels[0]!.image);
});

test("decoder reads the transparent index from header byte 28", () => {
  const bytes = mkFile([mkFrame([], 10)], { depth: 8 });
  bytes[28] = 9;
  assert.equal(decodeAse(bytes).transparentIndex, 9);
});

test("a tag with an unknown direction is rejected", () => {
  const tags = new B().u16(1).zeros(8).u16(0).u16(0).u8(4).u16(0).zeros(6).zeros(4).str("a").bytes;
  assert.throws(() => decodeAse(mkFile([mkFrame([mkChunk(0x2018, tags)], 10)])), /direction/);
});

test("known but unsupported chunks and unknown chunks are skipped", () => {
  const types = [0x2006, 0x2007, 0x2008, 0x2016, 0x2017, 0x7777];
  const d = decodeAse(mkFile([mkFrame([mkLayerChunk("a"), ...types.map((t) => mkChunk(t, [1, 2, 3]))], 10)]));
  assert.deepEqual(d.features, NO_FEATURES);
  assert.equal(d.layers.length, 1);
});

test("a color profile chunk, including an embedded ICC profile, does not disturb the chunks after it", () => {
  const icc = mkChunk(0x2007, new B().u16(2).u16(0).u32(0).zeros(8).u32(3).raw([1, 2, 3]));
  const srgb = mkChunk(0x2007, new B().u16(1).u16(1).u32(0x10000).zeros(8));
  const d = decodeAse(mkFile([mkFrame([icc, srgb, mkLayerChunk("after")], 10)]));
  assert.equal(d.layers[0]!.name, "after");
});

test("frame duration of 0 falls back to the header speed", () => {
  const d = decodeAse(mkFile([mkFrame([], 0), mkFrame([], 40)], { speed: 77 }));
  assert.deepEqual(d.frames.map((f) => f.durationMs), [77, 40]);
});

test("chunk count uses the old field only when the new field is 0", () => {
  const frame = mkFrame([mkLayerChunk("a"), mkLayerChunk("b")], 10, 2, 0);
  assert.equal(decodeAse(mkFile([frame])).layers.length, 2);
  const preferNew = mkFrame([mkLayerChunk("a"), mkLayerChunk("b")], 10, 2, 1);
  assert.equal(decodeAse(mkFile([preferNew])).layers.length, 1);
});

test("decoder throws on a bad file magic", () => {
  assert.throws(() => decodeAse(mkFile([mkFrame([], 10)], { magic: 0x1234 })), /magic/);
});

test("decoder throws on a bad frame magic", () => {
  const bytes = mkFile([mkFrame([], 10)]);
  bytes[128 + 4] = 0;
  assert.throws(() => decodeAse(bytes), /magic/);
});

test("decoder throws on a truncated file or header", () => {
  const good = encodeAse(sample("rgba"));
  assert.throws(() => decodeAse(good.subarray(0, 100)), Error);
  assert.throws(() => decodeAse(good.subarray(0, good.length - 5)), Error);
});

test("decoder throws when a chunk length leaves its frame or is below 6", () => {
  const frame = mkFrame([mkLayerChunk("a")], 10);
  const tooLong = [...frame];
  tooLong[16] = 0xff;
  assert.throws(() => decodeAse(mkFile([tooLong])), Error);
  const tooShort = [...frame];
  tooShort[16] = 5;
  assert.throws(() => decodeAse(mkFile([tooShort])), Error);
});

test("decoder throws when a frame size leaves the file", () => {
  const frame = mkFrame([mkLayerChunk("a")], 10);
  frame[0] = 0xff;
  frame[1] = 0xff;
  assert.throws(() => decodeAse(mkFile([frame])), Error);
});

test("decoder throws when a chunk body is shorter than its fields", () => {
  const frame = mkFrame([mkChunk(0x2004, [1, 0, 0, 0])], 10);
  assert.throws(() => decodeAse(mkFile([frame])), Error);
});

test("decoder rejects sizes above 16384, a size of 0 and unknown color depths", () => {
  assert.throws(() => decodeAse(mkFile([mkFrame([], 10)], { w: 16385 })), Error);
  assert.throws(() => decodeAse(mkFile([mkFrame([], 10)], { h: 16385 })), Error);
  assert.throws(() => decodeAse(mkFile([mkFrame([], 10)], { w: 0 })), Error);
  assert.throws(() => decodeAse(mkFile([mkFrame([], 10)], { depth: 24 })), Error);
  assert.equal(decodeAse(mkFile([mkFrame([], 10)], { w: 16384, h: 16384 })).width, 16384);
});

test("linked cels keep the frame they point to", () => {
  const file = sample("rgba");
  file.frames.push({ durationMs: 10, cels: [{ layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 1 }] });
  const d = decodeAse(encodeAse(file));
  assert.equal(d.frames[1]!.cels[0]!.linkedFrame, 0);
  assert.equal(d.frames[2]!.cels[0]!.linkedFrame, 1);
  assert.equal(d.frames[1]!.cels[0]!.image, undefined);
});

test("encoder rejects dimensions outside 1..65535", () => {
  for (const [w, h] of [[0, 1], [1, 0], [65536, 1], [1, 65536], [1.5, 1]] as const) {
    assert.throws(() => encodeAse({ ...sample("rgba"), width: w, height: h }), RangeError);
  }
});

test("encoder accepts the largest sprite size without a cel", () => {
  const file: AseFile = {
    width: 65535,
    height: 65535,
    colorMode: "rgba",
    transparentIndex: 0,
    palette: new Uint8Array(0),
    layers: [],
    frames: [{ durationMs: 1, cels: [] }],
    tags: [],
  };
  const bytes = encodeAse(file);
  assert.equal(new DataView(bytes.buffer).getUint16(8, true), 65535);
});

test("encoder rejects a cel on a layer that does not exist", () => {
  const file = sample("rgba");
  file.frames[0]!.cels[0]!.layer = 3;
  assert.throws(() => encodeAse(file), RangeError);
  file.frames[0]!.cels[0]!.layer = -1;
  assert.throws(() => encodeAse(file), RangeError);
});

test("encoder rejects image pixels whose length does not match size and color mode", () => {
  for (const mode of ["rgba", "grayscale", "indexed"] as const) {
    const file = sample(mode);
    const img = file.frames[0]!.cels[0]!.image!;
    img.pixels = img.pixels.subarray(0, img.pixels.length - 1);
    assert.throws(() => encodeAse(file), RangeError);
  }
  const file = sample("indexed");
  file.frames[0]!.cels[0]!.image!.pixels = new Uint8Array(5 * 4 * 4);
  assert.throws(() => encodeAse(file), RangeError);
});

test("encoder rejects a linked cel that does not point to an earlier frame", () => {
  const file = sample("rgba");
  file.frames[1]!.cels[0]!.linkedFrame = 1;
  assert.throws(() => encodeAse(file), RangeError);
  file.frames[1]!.cels[0]!.linkedFrame = 5;
  assert.throws(() => encodeAse(file), RangeError);
  file.frames[1]!.cels[0]!.linkedFrame = -1;
  assert.throws(() => encodeAse(file), RangeError);
  const first = sample("rgba");
  first.frames[0]!.cels[0] = { layer: 0, x: 0, y: 0, opacity: 255, zIndex: 0, linkedFrame: 0 };
  assert.throws(() => encodeAse(first), RangeError);
});

test("encoder rejects tags outside the frame range or with from after to", () => {
  const tag = { name: "t", from: 0, to: 1, direction: "forward", repeat: 0, color: [0, 0, 0, 255] } as const;
  for (const bad of [{ from: 0, to: 2 }, { from: 2, to: 2 }, { from: 1, to: 0 }, { from: -1, to: 0 }]) {
    const file = sample("rgba");
    file.tags = [{ ...tag, color: [0, 0, 0, 255], ...bad }];
    assert.throws(() => encodeAse(file), RangeError);
  }
});

test("encoder rejects an indexed transparentIndex outside the palette but not other modes", () => {
  const file = sample("indexed");
  file.transparentIndex = 4;
  assert.throws(() => encodeAse(file), RangeError);
  file.transparentIndex = 3;
  assert.equal(decodeAse(encodeAse(file)).transparentIndex, 3);
  const rgba = sample("rgba");
  rgba.transparentIndex = 4;
  assert.doesNotThrow(() => encodeAse(rgba));
});

test("encoder rejects two cels on the same layer in one frame", () => {
  const file = sample("rgba");
  file.frames[0]!.cels.push({ ...file.frames[0]!.cels[0]! });
  assert.throws(() => encodeAse(file), RangeError);
});

test("encoder rejects a cel that has both or neither of image and linkedFrame", () => {
  const both = sample("rgba");
  both.frames[1]!.cels[1]!.linkedFrame = 0;
  assert.throws(() => encodeAse(both), RangeError);
  const neither = sample("rgba");
  delete neither.frames[0]!.cels[0]!.image;
  assert.throws(() => encodeAse(neither), RangeError);
});

test("encoder rejects a palette whose length is not a multiple of 4", () => {
  const file = sample("rgba");
  file.palette = new Uint8Array(7);
  assert.throws(() => encodeAse(file), RangeError);
});

test("encoder rejects a file without frames", () => {
  assert.throws(() => encodeAse({ ...sample("rgba"), frames: [] }), RangeError);
});

const fixturePath = fileURLToPath(new URL("./fixtures/libresprite-1.3.ase", import.meta.url));
test("decodes a file saved by LibreSprite 1.3", () => {
  const d = decodeAse(new Uint8Array(readFileSync(fixturePath)));
  assert.deepEqual([d.width, d.height, d.colorMode], [8, 6, "indexed"]);
  assert.deepEqual(d.features, NO_FEATURES);
  assert.equal(d.layers.length, 1);
  assert.equal(d.layers[0]!.name, "Background");
  assert.equal(d.layers[0]!.background, true);
  assert.deepEqual([...d.palette], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  assert.equal(d.frames.length, 1);
  assert.equal(d.frames[0]!.durationMs, 100);
  const cel = d.frames[0]!.cels[0]!;
  assert.deepEqual([cel.layer, cel.x, cel.y, cel.image!.width, cel.image!.height], [0, 0, 0, 8, 6]);
  assert.deepEqual([...cel.image!.pixels], Array.from({ length: 48 }, (_, i) => i % 3));
});

test("round trips a pixel ratio through the header, and reads a zero field as 1:1", () => {
  const file = { ...sample("rgba"), pixelRatio: { w: 2, h: 1 } };
  const bytes = encodeAse(file);
  assert.deepEqual([bytes[34], bytes[35]], [2, 1]);
  assert.deepEqual(decodeAse(bytes).pixelRatio, { w: 2, h: 1 });
  bytes[35] = 0;
  assert.deepEqual(decodeAse(bytes).pixelRatio, { w: 1, h: 1 });
});

test("encoder rejects a pixel ratio outside 1..255", () => {
  assert.throws(() => encodeAse({ ...sample("rgba"), pixelRatio: { w: 0, h: 1 } }), RangeError);
  assert.throws(() => encodeAse({ ...sample("rgba"), pixelRatio: { w: 1, h: 256 } }), RangeError);
});
