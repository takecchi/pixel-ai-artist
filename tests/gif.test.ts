import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGif, decodeGif } from "../dist/lib/gif.js";
import { deltaE, parseHex, rgbToLab } from "../dist/lib/color.js";
import type { Image } from "../dist/lib/image.js";

function word(c: number[]): number {
  return ((c[0]! << 24) | (c[1]! << 16) | (c[2]! << 8) | (c[3] ?? 255)) >>> 0;
}

function img(width: number, height: number, px: (x: number, y: number) => number[]): Image {
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = word(px(x, y));
  }
  return { width, height, pixels };
}

function hex(c: number[]): string {
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];
const P_RGB = [hex(RED), hex(GREEN), hex(BLUE)];

function px(i: Image, x: number, y: number): number[] {
  const v = i.pixels[y * i.width + x]!;
  return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function parseHeader(b: Uint8Array) {
  const packed = b[10]!;
  const tableLen = 3 * (2 << (packed & 7));
  return { packed, tableLen, table: b.subarray(13, 13 + tableLen) };
}

function one(image: Image, opts?: Parameters<typeof encodeGif>[1]): Uint8Array {
  return encodeGif([{ image, durationMs: 10 }], opts);
}

/** `count` distinct opaque colours, none of them fully transparent-looking. */
function distinctColors(count: number): number[][] {
  return Array.from({ length: count }, (_, i) => [i & 255, i >> 8, 7, 255]);
}

test("encodeGif followed by decodeGif preserves frame count, durations, loop and pixels", () => {
  const a = img(5, 3, (x, y) => ((x + y) % 2 ? RED : GREEN));
  const b = img(5, 3, (x) => (x < 2 ? BLUE : RED));
  const gif = encodeGif(
    [{ image: a, durationMs: 100 }, { image: b, durationMs: 250 }],
    { palette: P_RGB },
  );
  const d = decodeGif(gif);
  assert.equal(d.width, 5);
  assert.equal(d.height, 3);
  assert.equal(d.loop, 0);
  assert.equal(d.frames.length, 2);
  assert.deepEqual(d.frames.map((f) => f.durationMs), [100, 250]);
  assert.deepEqual(d.frames[0]!.image.pixels, a.pixels);
  assert.deepEqual(d.frames[1]!.image.pixels, b.pixels);
});

test("encodeGif rounds durations to centiseconds with a minimum of one", () => {
  const a = img(1, 1, () => RED);
  const d = decodeGif(
    encodeGif(
      [{ image: a, durationMs: 0 }, { image: a, durationMs: 14 }, { image: a, durationMs: 15 }, { image: a, durationMs: 4 }],
      { palette: [hex(RED)] },
    ),
  );
  assert.deepEqual(d.frames.map((f) => f.durationMs), [10, 10, 20, 10]);
});

test("encodeGif without a palette lists the colours the frames use in order of first appearance", () => {
  const f1 = img(3, 1, (x) => [BLUE, RED, BLUE][x]!);
  const f2 = img(3, 1, (x) => [[1, 2, 3, 255], GREEN, RED][x]!);
  const gif = encodeGif([{ image: f1, durationMs: 10 }, { image: f2, durationMs: 10 }]);
  const h = parseHeader(gif);
  assert.equal(h.tableLen, 3 * 4);
  assert.deepEqual(Array.from(h.table), [0, 0, 255, 255, 0, 0, 1, 2, 3, 0, 255, 0]);
  const d = decodeGif(gif);
  assert.deepEqual(d.frames[0]!.image.pixels, f1.pixels);
  assert.deepEqual(d.frames[1]!.image.pixels, f2.pixels);
});

test("encodeGif without a palette keeps the exact colours of the frames", () => {
  const a = img(4, 1, (x) => [[3, 5, 7, 255], [250, 10, 10, 255], [251, 10, 10, 255], [3, 5, 7, 255]][x]!);
  assert.deepEqual(decodeGif(one(a)).frames[0]!.image.pixels, a.pixels);
});

test("encodeGif without a palette leaves colours of transparent pixels out of the table", () => {
  const a = img(2, 1, (x) => (x === 0 ? [9, 9, 9, 127] : RED));
  const h = parseHeader(one(a));
  assert.deepEqual(Array.from(h.table.subarray(0, 3)), [255, 0, 0]);
  assert.equal(h.tableLen, 3 * 2);
});

test("encodeGif without a palette accepts 256 colours", () => {
  const colors = distinctColors(256);
  const a = img(256, 1, (x) => colors[x]!);
  assert.deepEqual(decodeGif(one(a)).frames[0]!.image.pixels, a.pixels);
});

test("encodeGif without a palette throws RangeError for 257 colours", () => {
  const colors = distinctColors(257);
  assert.throws(() => one(img(257, 1, (x) => colors[x]!)), RangeError);
});

test("encodeGif without a palette throws RangeError for 256 colours and a transparent pixel", () => {
  const colors = distinctColors(256);
  assert.throws(() => one(img(257, 1, (x) => (x === 256 ? CLEAR : colors[x]!))), RangeError);
});

test("encodeGif with a palette snaps by perceptual distance, not RGB distance", () => {
  const target = [120, 0, 0, 255];
  const palette = ["#3c3c3c", "#ff6a00"];
  const rgbDist = palette.map((p) => {
    const c = parseHex(p);
    return Math.hypot(c.r - target[0]!, c.g - target[1]!, c.b - target[2]!);
  });
  const lab = palette.map((p) => deltaE(rgbToLab({ r: 120, g: 0, b: 0, a: 255 }), rgbToLab(parseHex(p))));
  assert.ok(rgbDist[0]! < rgbDist[1]!, "RGB prefers the grey");
  assert.ok(lab[1]! < lab[0]!, "ΔE prefers the orange");
  const d = decodeGif(one(img(1, 1, () => target), { palette }));
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), [255, 0x6a, 0, 255]);
});

test("encodeGif maps each pixel to the nearest colour of the palette", () => {
  const a = img(3, 1, (x) => [[250, 10, 10, 255], [10, 200, 30, 255], [20, 20, 90, 255]][x]!);
  const d = decodeGif(one(a, { palette: P_RGB }));
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), RED);
  assert.deepEqual(px(d.frames[0]!.image, 1, 0), GREEN);
  assert.deepEqual(px(d.frames[0]!.image, 2, 0), BLUE);
});

test("encodeGif picks the lower palette index when two colours are equally near", () => {
  // Identical entries cannot be told apart in the decoded image, so the table
  // is recoloured after encoding to show which index the pixel carries.
  const gif = one(img(1, 1, () => [16, 32, 48, 255]), { palette: ["#102030", "#102030"] });
  const patched = gif.slice();
  patched.set([255, 0, 0, 0, 0, 255], 13);
  assert.deepEqual(px(decodeGif(patched).frames[0]!.image, 0, 0), RED);
});

test("encodeGif never maps pixels to palette colours that are not fully opaque", () => {
  const a = img(1, 1, () => [100, 100, 100, 255]);
  const d = decodeGif(one(a, { palette: ["#646464c8", "#000000"] }));
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), [0, 0, 0, 255]);
});

test("encodeGif throws RangeError for a palette without a fully opaque colour", () => {
  const a = img(1, 1, () => RED);
  assert.throws(() => one(a, { palette: [] }), RangeError);
  assert.throws(() => one(a, { palette: ["#ff000080", "#00ff0000"] }), RangeError);
});

test("encodeGif throws RangeError for a palette with 257 opaque colours", () => {
  const palette = distinctColors(257).map(hex);
  assert.throws(() => one(img(1, 1, () => RED), { palette }), RangeError);
});

test("encodeGif counts only opaque palette entries against the 256 limit", () => {
  const palette = [...distinctColors(256).map(hex), "#ffffff00"];
  const d = decodeGif(one(img(1, 1, () => [5, 0, 7, 255]), { palette }));
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), [5, 0, 7, 255]);
});

test("encodeGif treats alpha below 128 as transparent and appends a table slot after the colours", () => {
  const a = img(2, 2, (x, y) => (x === y ? [9, 9, 9, 127] : [255, 0, 0, 128]));
  const gif = one(a, { palette: P_RGB });
  const h = parseHeader(gif);
  assert.equal(h.tableLen, 3 * 4);
  assert.deepEqual(Array.from(h.table), [255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
  const d = decodeGif(gif);
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), CLEAR);
  assert.deepEqual(px(d.frames[0]!.image, 1, 0), RED);
  assert.deepEqual(px(d.frames[0]!.image, 1, 1), CLEAR);
});

test("encodeGif sets disposal 2 and the transparency flag only when a pixel is transparent", () => {
  const solid = one(img(1, 1, () => RED), { palette: [hex(RED)] });
  const holed = one(img(1, 1, () => CLEAR), { palette: [hex(RED)] });
  const gceFlags = (b: Uint8Array): number => {
    for (let i = 0; i < b.length - 3; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 4) return b[i + 3]!;
    throw new Error("no GCE");
  };
  assert.equal(gceFlags(solid), (1 << 2) | 0);
  assert.equal(gceFlags(holed), (2 << 2) | 1);
});

test("encodeGif reuses a colour index no pixel uses as transparent when the palette has 256 colours", () => {
  const colors = Array.from({ length: 256 }, (_, i) => [i, 0, 0, 255]);
  const a = img(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const gif = one(a, { palette: colors.map(hex) });
  assert.equal(parseHeader(gif).tableLen, 256 * 3);
  const d = decodeGif(gif);
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(d.frames[0]!.image, 1, 0), CLEAR);
});

test("encodeGif gives up the last colour as transparent and remaps its pixels when all 256 colours are used", () => {
  const colors = Array.from({ length: 256 }, (_, i) => [i, 0, 0, 255]);
  const a = img(257, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [x % 256, 0, 0, 255]));
  const d = decodeGif(one(a, { palette: colors.map(hex) }));
  const f = d.frames[0]!.image;
  assert.deepEqual(px(f, 0, 0), CLEAR);
  assert.deepEqual(px(f, 256, 0), [0, 0, 0, 255]);
  assert.deepEqual(px(f, 254, 0), [254, 0, 0, 255]);
  assert.deepEqual(px(f, 255, 0), [254, 0, 0, 255]);
});

test("encodeGif writes an infinite NETSCAPE2.0 loop by default and omits the extension for loop false", () => {
  const f = [{ image: img(1, 1, () => RED), durationMs: 10 }];
  const text = (b: Uint8Array): string => Buffer.from(b).toString("latin1");
  const withLoop = encodeGif(f, { palette: [hex(RED)] });
  const without = encodeGif(f, { palette: [hex(RED)], loop: false });
  assert.ok(text(withLoop).includes("NETSCAPE2.0"));
  assert.ok(!text(without).includes("NETSCAPE2.0"));
  assert.equal(decodeGif(withLoop).loop, 0);
  assert.equal(decodeGif(without).loop, null);
});

test("encodeGif writes a finite loop count that decodeGif reads back", () => {
  const f = [{ image: img(1, 1, () => RED), durationMs: 10 }];
  assert.equal(decodeGif(encodeGif(f, { palette: [hex(RED)], loop: 3 })).loop, 3);
  assert.equal(decodeGif(encodeGif(f, { palette: [hex(RED)], loop: 300 })).loop, 300);
});

test("encodeGif rejects an empty frame list and mismatched frame sizes with RangeError", () => {
  const palette = [hex(RED)];
  assert.throws(() => encodeGif([], { palette }), RangeError);
  assert.throws(
    () => encodeGif([{ image: img(1, 1, () => RED), durationMs: 10 }, { image: img(2, 1, () => RED), durationMs: 10 }], { palette }),
    RangeError,
  );
});

test("encodeGif and decodeGif round-trip 128x128 noise whose LZW stream overflows the 4096-entry table", () => {
  let s = 12345;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s >>> 16;
  };
  const colors = Array.from({ length: 200 }, (_, i) => [(i * 37) & 255, (i * 91) & 255, (i * 13) & 255, 255]);
  const noise = img(128, 128, () => colors[rnd() % colors.length]!);
  const d = decodeGif(one(noise, { palette: colors.map(hex) }));
  assert.deepEqual(d.frames[0]!.image.pixels, noise.pixels);
});

test("encodeGif and decodeGif round-trip a long run of identical pixels", () => {
  const flat = img(300, 300, () => BLUE);
  const d = decodeGif(one(flat, { palette: [hex(RED), hex(BLUE)] }));
  assert.deepEqual(d.frames[0]!.image.pixels, flat.pixels);
});

// Hand-assembled GIFs. Pixels are written as literal LZW codes with a clear code every two pixels.
function handGif(parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}
function u16(v: number): number[] {
  return [v & 255, v >> 8];
}
function lzwLiteral(pixels: number[]): number[] {
  const bits: number[] = [];
  const put = (code: number): void => {
    for (let i = 0; i < 3; i++) bits.push((code >> i) & 1);
  };
  for (let i = 0; i < pixels.length; i += 2) {
    put(4);
    put(pixels[i]!);
    if (i + 1 < pixels.length) put(pixels[i + 1]!);
  }
  put(5);
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8 && i + j < bits.length; j++) v |= bits[i + j]! << j;
    bytes.push(v);
  }
  return [2, bytes.length, ...bytes, 0];
}
function gce(disposal: number, delay: number, transparent: number): number[] {
  return [0x21, 0xf9, 4, (disposal << 2) | (transparent >= 0 ? 1 : 0), ...u16(delay), Math.max(transparent, 0), 0];
}
function frame(x: number, y: number, w: number, h: number, pixels: number[], flags = 0): number[] {
  return [0x2c, ...u16(x), ...u16(y), ...u16(w), ...u16(h), flags, ...lzwLiteral(pixels)];
}
const HAND_HEADER = [
  ...Array.from("GIF89a", (c) => c.charCodeAt(0)),
  ...u16(4), ...u16(4), 0x81, 0, 0,
  0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
];

test("decodeGif composites partial and clipped frame rectangles, restoring the previous state for disposal 3", () => {
  const gif = handGif([
    HAND_HEADER,
    gce(1, 5, -1), frame(0, 0, 4, 4, new Array(16).fill(1)),
    gce(3, 6, -1), frame(1, 1, 2, 2, [2, 2, 2, 2]),
    gce(1, 7, 0), frame(2, 3, 2, 1, [3, 0]),
    gce(1, 8, -1), frame(3, 3, 2, 2, [2, 2, 2, 2]),
    [0x3b],
  ]);
  const d = decodeGif(gif);
  assert.equal(d.loop, null);
  assert.deepEqual(d.frames.map((f) => f.durationMs), [50, 60, 70, 80]);
  const f = d.frames.map((x) => x.image);
  assert.deepEqual(px(f[0]!, 2, 2), RED);
  assert.deepEqual(px(f[1]!, 1, 1), GREEN);
  assert.deepEqual(px(f[1]!, 2, 2), GREEN);
  assert.deepEqual(px(f[1]!, 0, 0), RED);
  assert.deepEqual(px(f[1]!, 3, 3), RED);
  assert.deepEqual(px(f[2]!, 1, 1), RED);
  assert.deepEqual(px(f[2]!, 2, 3), BLUE);
  assert.deepEqual(px(f[2]!, 3, 3), RED);
  assert.deepEqual(px(f[3]!, 3, 3), GREEN);
  assert.deepEqual(px(f[3]!, 2, 3), BLUE);
});

test("decodeGif clears the frame rectangle to transparent for disposal 2", () => {
  const gif = handGif([
    HAND_HEADER,
    gce(2, 1, -1), frame(0, 0, 2, 2, [1, 1, 1, 1]),
    gce(1, 1, 0), frame(2, 2, 1, 1, [2]),
    [0x3b],
  ]);
  const d = decodeGif(gif);
  assert.deepEqual(px(d.frames[0]!.image, 0, 0), RED);
  assert.deepEqual(px(d.frames[1]!.image, 0, 0), CLEAR);
  assert.deepEqual(px(d.frames[1]!.image, 2, 2), GREEN);
});

test("decodeGif reads interlaced frames in pass order", () => {
  const rows = [0, 1, 2, 3, 0, 1, 2, 3];
  const order = [0, 4, 2, 6, 1, 3, 5, 7];
  const hdr = [...HAND_HEADER];
  hdr[6] = 1;
  hdr[8] = 8;
  const pixels: number[] = [];
  for (const r of order) pixels.push(rows[r]! % 4);
  const gif = handGif([hdr, gce(1, 1, -1), frame(0, 0, 1, 8, pixels, 0x40), [0x3b]]);
  const d = decodeGif(gif);
  for (let y = 0; y < 8; y++) {
    const c = px(d.frames[0]!.image, 0, y);
    const want = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]][rows[y]! % 4]!;
    assert.deepEqual(c.slice(0, 3), want);
  }
});

test("decodeGif skips comment and unknown extensions and reads an ANIMEXTS1.0 loop", () => {
  const ext = (label: number, ...blocks: number[][]): number[] => [0x21, label, ...blocks.flatMap((b) => [b.length, ...b]), 0];
  const name = Array.from("ANIMEXTS1.0", (c) => c.charCodeAt(0));
  const gif = handGif([
    HAND_HEADER,
    ext(0xfe, Array.from("hello", (c) => c.charCodeAt(0))),
    ext(0xff, name, [1, 7, 0]),
    ext(0x77, [1, 2, 3]),
    gce(1, 1, -1), frame(0, 0, 4, 4, new Array(16).fill(2)),
    [0x3b],
  ]);
  const d = decodeGif(gif);
  assert.equal(d.loop, 7);
  assert.equal(d.frames.length, 1);
});

test("decodeGif returns the frames that were fully read from a file cut off before the trailer", () => {
  const f = [
    { image: img(8, 8, (x) => (x % 2 ? RED : GREEN)), durationMs: 30 },
    { image: img(8, 8, (_, y) => (y % 2 ? RED : BLUE)), durationMs: 40 },
    { image: img(8, 8, () => BLUE), durationMs: 50 },
  ];
  const gif = encodeGif(f, { palette: P_RGB });
  assert.equal(decodeGif(gif.subarray(0, gif.length - 1)).frames.length, 3);
  const cut = decodeGif(gif.subarray(0, gif.length - 12));
  assert.equal(cut.frames.length, 2);
  assert.deepEqual(cut.frames.map((x) => x.durationMs), [30, 40]);
});

test("decodeGif throws when the file is cut off before any frame is complete", () => {
  const gif = one(img(8, 8, () => RED), { palette: [hex(RED)] });
  assert.throws(() => decodeGif(gif.subarray(0, gif.length - 5)), Error);
  assert.throws(() => decodeGif(gif.subarray(0, 20)), Error);
});

test("decodeGif rejects data whose signature is not GIF87a or GIF89a", () => {
  const gif = one(img(1, 1, () => RED), { palette: [hex(RED)] });
  const bad = gif.slice();
  bad[3] = "X".charCodeAt(0);
  assert.throws(() => decodeGif(bad), /signature/);
  assert.throws(() => decodeGif(new Uint8Array(0)), Error);
  const ok = gif.slice();
  ok.set(Array.from("GIF87a", (c) => c.charCodeAt(0)));
  assert.equal(decodeGif(ok).frames.length, 1);
});

const COLOR_TABLE = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
const LOCAL_FLAGS = 0x81;

function frameWithLocalTable(pixels: number[], table: number[]): number[] {
  return [0x2c, ...u16(0), ...u16(0), ...u16(2), ...u16(2), LOCAL_FLAGS, ...table, ...lzwLiteral(pixels)];
}

function screen(packed: number, background: number, table: number[]): number[] {
  return [...Array.from("GIF89a", (c) => c.charCodeAt(0)), ...u16(2), ...u16(2), packed, background, 0, ...table];
}

test("decodeGif returns the global colour table as opaque 0xRRGGBBAA words", () => {
  const d = decodeGif(handGif([HAND_HEADER, gce(1, 1, -1), frame(0, 0, 4, 4, new Array(16).fill(1)), [0x3b]]));
  assert.deepEqual(d.globalPalette, [0x000000ff, 0xff0000ff, 0x00ff00ff, 0x0000ffff]);
});

test("decodeGif returns a null global palette when the screen has no global colour table", () => {
  const gif = handGif([screen(0, 0, []), gce(1, 1, -1), frameWithLocalTable([0, 1, 2, 3], COLOR_TABLE), [0x3b]]);
  assert.equal(decodeGif(gif).globalPalette, null);
});

test("decodeGif returns the logical screen's background colour index", () => {
  const gif = handGif([screen(0x81, 2, COLOR_TABLE), gce(1, 1, -1), frame(0, 0, 2, 2, [0, 1, 2, 3]), [0x3b]]);
  assert.equal(decodeGif(gif).backgroundIndex, 2);
  assert.equal(decodeGif(handGif([HAND_HEADER, frame(0, 0, 4, 4, new Array(16).fill(1)), [0x3b]])).backgroundIndex, 0);
});

test("decodeGif returns the first frame's transparent colour index, or -1 without one", () => {
  const body = (g: number[]): Uint8Array => handGif([screen(0x81, 0, COLOR_TABLE), g, frame(0, 0, 2, 2, [0, 1, 2, 3]), [0x3b]]);
  assert.equal(decodeGif(body(gce(1, 1, 2))).transparentIndex, 2);
  assert.equal(decodeGif(body(gce(1, 1, -1))).transparentIndex, -1);
  assert.equal(decodeGif(body([])).transparentIndex, -1);
});

test("decodeGif ignores the transparent colour index of frames after the first", () => {
  const gif = handGif([
    screen(0x81, 0, COLOR_TABLE),
    gce(1, 1, -1), frame(0, 0, 2, 2, [0, 1, 2, 3]),
    gce(1, 1, 3), frame(0, 0, 2, 2, [0, 1, 2, 3]),
    [0x3b],
  ]);
  assert.equal(decodeGif(gif).transparentIndex, -1);
});

test("decodeGif reports whether any frame carries its own colour table", () => {
  const plain = handGif([HAND_HEADER, gce(1, 1, -1), frame(0, 0, 2, 2, [0, 1, 2, 3]), [0x3b]]);
  assert.equal(decodeGif(plain).localColorTables, false);
  const second = handGif([
    HAND_HEADER,
    gce(1, 1, -1), frame(0, 0, 2, 2, [0, 1, 2, 3]),
    gce(1, 1, -1), frameWithLocalTable([0, 1, 2, 3], COLOR_TABLE),
    [0x3b],
  ]);
  assert.equal(decodeGif(second).localColorTables, true);
});

test("decodeGif gives a frame with no graphic control extension a duration of 10 ms", () => {
  const gif = handGif([
    HAND_HEADER,
    frame(0, 0, 2, 2, [0, 1, 2, 3]),
    gce(1, 0, -1), frame(0, 0, 2, 2, [0, 1, 2, 3]),
    gce(1, 4, -1), frame(0, 0, 2, 2, [0, 1, 2, 3]),
    frame(0, 0, 2, 2, [0, 1, 2, 3]),
    [0x3b],
  ]);
  assert.deepEqual(decodeGif(gif).frames.map((f) => f.durationMs), [10, 0, 40, 10]);
});

test("decodeGif rejects screens wider or taller than 16384 with RangeError", () => {
  const mk = (w: number, h: number): Uint8Array =>
    handGif([Array.from("GIF89a", (c) => c.charCodeAt(0)), u16(w), u16(h), [0, 0, 0], [0x3b]]);
  assert.throws(() => decodeGif(mk(16385, 1)), RangeError);
  assert.throws(() => decodeGif(mk(1, 16385)), RangeError);
});
