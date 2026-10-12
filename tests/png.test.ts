import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { decodePng, encodePng } from "../dist/lib/png.js";
import { fromRgbaBytes, toRgbaBytes } from "../dist/lib/image.js";

function chunk(type: string, body: number[] | Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function ihdr(w: number, h: number, depth: number, colorType: number, interlace = 0): Uint8Array {
  const b = new Uint8Array(13);
  const v = new DataView(b.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  b[8] = depth;
  b[9] = colorType;
  b[12] = interlace;
  return chunk("IHDR", b);
}

const SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** rows: samples per row (already one number per channel sample), packed to `depth` bits, filter 0. */
function packRows(rows: number[][], depth: number): number[] {
  const out: number[] = [];
  for (const row of rows) {
    out.push(0);
    if (depth >= 8) {
      for (const s of row) {
        if (depth === 16) out.push(s >> 8, s & 255);
        else out.push(s);
      }
    } else {
      for (let i = 0; i < row.length; i += 8 / depth) {
        let byte = 0;
        for (let k = 0; k < 8 / depth; k++) byte |= (row[i + k] ?? 0) << (8 - depth * (k + 1));
        out.push(byte);
      }
    }
  }
  return out;
}

function buildPng(
  w: number,
  h: number,
  depth: number,
  colorType: number,
  raw: number[],
  extra: Uint8Array[] = [],
  interlace = 0,
  splitIdat = 0,
): Uint8Array {
  const z = deflateSync(Uint8Array.from(raw));
  const idats = splitIdat > 0 ? [z.subarray(0, splitIdat), z.subarray(splitIdat)] : [z];
  return join([SIG, ihdr(w, h, depth, colorType, interlace), ...extra, ...idats.map((d) => chunk("IDAT", d)), chunk("IEND", [])]);
}

function blank(w: number, h: number, value = 0): { width: number; height: number; pixels: Uint32Array } {
  return { width: w, height: h, pixels: new Uint32Array(w * h).fill(value) };
}

/** Decoded pixels as flat r,g,b,a bytes, so expectations read as byte lists. */
function rgba(png: Uint8Array): number[] {
  return [...toRgbaBytes(decodePng(png))];
}

test("encodePng then decodePng round-trips straight RGBA pixels exactly", () => {
  const w = 7;
  const h = 5;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3) * 11) & 255;
  const img = fromRgbaBytes(w, h, data);
  const out = decodePng(encodePng(img));
  assert.equal(out.width, w);
  assert.equal(out.height, h);
  assert.deepEqual(out.pixels, img.pixels);
});

test("encodePng keeps the 0xRRGGBBAA word order of a pixel", () => {
  const out = decodePng(encodePng({ width: 1, height: 1, pixels: Uint32Array.of(0x11223344) }));
  assert.equal(out.pixels[0], 0x11223344);
  assert.deepEqual([...toRgbaBytes(out)], [0x11, 0x22, 0x33, 0x44]);
});

test("encodePng writes a color type 6, 8-bit, non-interlaced header", () => {
  const png = encodePng(blank(2, 1));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...png.subarray(24, 29)], [8, 6, 0, 0, 0]);
});

for (const depth of [1, 2, 4, 8, 16]) {
  test(`decodePng scales a ${depth}-bit grayscale image to 8-bit RGBA`, () => {
    const max = (1 << depth) - 1;
    const values = [0, max, 1, Math.floor(max / 2)];
    const png = buildPng(4, 1, depth, 0, packRows([values], depth));
    const expect = values.flatMap((v) => {
      const g = depth === 16 ? v >> 8 : Math.round((v * 255) / max);
      return [g, g, g, 255];
    });
    assert.deepEqual(rgba(png), expect);
  });
}

test("decodePng returns straight RGBA for a 2-bit grayscale image with tRNS", () => {
  const trns = chunk("tRNS", [0, 1]);
  const png = buildPng(4, 1, 2, 0, packRows([[0, 1, 2, 3]], 2), [trns]);
  assert.deepEqual(rgba(png), [0, 0, 0, 255, 85, 85, 85, 0, 170, 170, 170, 255, 255, 255, 255, 255]);
});

test("decodePng applies an RGB color key to matching pixels only", () => {
  const trns = chunk("tRNS", [0, 10, 0, 20, 0, 30]);
  const rows = [[10, 20, 30, 10, 20, 31]];
  assert.deepEqual(rgba(buildPng(2, 1, 8, 2, packRows(rows, 8), [trns])), [10, 20, 30, 0, 10, 20, 31, 255]);
});

test("decodePng compares a 16-bit RGB color key against the full 16-bit sample", () => {
  const trns = chunk("tRNS", [0x12, 0x34, 0, 0, 0, 0]);
  const rows = [[0x1234, 0, 0, 0x1235, 0, 0]];
  assert.deepEqual(rgba(buildPng(2, 1, 16, 2, packRows(rows, 16), [trns])), [0x12, 0, 0, 0, 0x12, 0, 0, 255]);
});

test("decodePng reads gray+alpha at 8 and 16 bits", () => {
  assert.deepEqual(rgba(buildPng(2, 1, 8, 4, packRows([[10, 20, 30, 40]], 8))), [10, 10, 10, 20, 30, 30, 30, 40]);
  assert.deepEqual(rgba(buildPng(1, 1, 16, 4, packRows([[0xabcd, 0x1234]], 16))), [0xab, 0xab, 0xab, 0x12]);
});

test("decodePng reads 16-bit RGBA by taking the high byte", () => {
  const png = buildPng(1, 1, 16, 6, packRows([[0x1122, 0x3344, 0x5566, 0x7788]], 16));
  assert.deepEqual(rgba(png), [0x11, 0x33, 0x55, 0x77]);
});

for (const depth of [1, 2, 4, 8]) {
  test(`decodePng reads a ${depth}-bit palette image as RGBA with tRNS alpha`, () => {
    const colors = Math.min(1 << depth, 4);
    const plte: number[] = [];
    for (let i = 0; i < colors; i++) plte.push(i * 40, i * 20, 200 - i);
    const idx = [0, 1, 2, 3, 3, 2, 1, 0, 1, 1].map((v) => v % colors);
    const png = buildPng(5, 2, depth, 3, packRows([idx.slice(0, 5), idx.slice(5)], depth), [
      chunk("PLTE", plte),
      chunk("tRNS", [7, 9]),
    ]);
    const alphas = [7, 9, 255, 255];
    const expect = idx.flatMap((i) => [i * 40, i * 20, 200 - i, alphas[i]!]);
    assert.deepEqual(rgba(png), expect);
  });
}

test("decodePng reads a palette image whose PLTE has fewer colors than the bit depth allows", () => {
  const png = buildPng(1, 1, 8, 3, packRows([[1]], 8), [chunk("PLTE", [1, 2, 3, 4, 5, 6])]);
  assert.deepEqual(rgba(png), [4, 5, 6, 255]);
});

test("decodePng throws Error for a palette index beyond PLTE", () => {
  const png = buildPng(1, 1, 8, 3, packRows([[5]], 8), [chunk("PLTE", [1, 2, 3])]);
  assert.throws(() => decodePng(png), /palette index 5/);
});

test("decodePng reads an Adam7 interlaced image and places every pixel correctly", () => {
  const w = 5;
  const h = 6;
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  const raw: number[] = [];
  for (const [x0, y0, dx, dy] of passes as [number, number, number, number][]) {
    for (let y = y0; y < h; y += dy) {
      const row: number[] = [];
      for (let x = x0; x < w; x += dx) row.push(y * 10 + x);
      if (row.length) raw.push(...packRows([row], 8));
    }
  }
  const out = rgba(buildPng(w, h, 8, 0, raw, [], 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) assert.equal(out[(y * w + x) * 4], y * 10 + x, `pixel ${x},${y}`);
  }
});

test("decodePng reads a 1-bit Adam7 image with sub-byte rows", () => {
  const w = 3;
  const h = 3;
  const grid = [
    [1, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
  ];
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  const raw: number[] = [];
  for (const [x0, y0, dx, dy] of passes as [number, number, number, number][]) {
    for (let y = y0; y < h; y += dy) {
      const row: number[] = [];
      for (let x = x0; x < w; x += dx) row.push(grid[y]![x]!);
      if (row.length) raw.push(...packRows([row], 1));
    }
  }
  const out = rgba(buildPng(w, h, 1, 0, raw, [], 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) assert.equal(out[(y * w + x) * 4], grid[y]![x]! * 255);
  }
});

test("decodePng concatenates image data split across several IDAT chunks", () => {
  const raw = [0, 1, 2, 3, 4, 0, 5, 6, 7, 8, 0, 9, 10, 11, 12];
  assert.deepEqual(rgba(buildPng(1, 3, 8, 6, raw, [], 0, 4)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("decodePng undoes all five scanline filters", () => {
  // Rows are 2 RGB pixels; every filter type is applied once.
  const row0 = [10, 20, 30, 40, 50, 60];
  const sub = [10, 20, 30, 30, 30, 30];
  const up = [1, 1, 1, 1, 1, 1];
  const avg = [5, 5, 5, 5, 5, 5];
  const paeth = [2, 2, 2, 2, 2, 2];
  const raw = [0, ...row0, 1, ...sub, 2, ...up, 3, ...avg, 4, ...paeth];
  const out = rgba(buildPng(2, 5, 8, 2, raw));
  const px = (y: number) => out.slice(y * 8, y * 8 + 8).filter((_, i) => i % 4 !== 3);
  assert.deepEqual(px(0), row0);
  assert.deepEqual(px(1), [10, 20, 30, 40, 50, 60]);
  assert.deepEqual(px(2), [11, 21, 31, 41, 51, 61]);
  const r2 = px(2);
  const r3 = [5 + (r2[0]! >> 1), 5 + (r2[1]! >> 1), 5 + (r2[2]! >> 1)];
  r3.push(5 + ((r3[0]! + r2[3]!) >> 1), 5 + ((r3[1]! + r2[4]!) >> 1), 5 + ((r3[2]! + r2[5]!) >> 1));
  assert.deepEqual(px(3), r3);
  assert.equal(px(4).length, 6);
});

test("decodePng skips ancillary chunks such as gAMA and tEXt", () => {
  const extra = [chunk("gAMA", [0, 1, 134, 160]), chunk("tEXt", [97, 0, 98]), chunk("sRGB", [0])];
  assert.deepEqual(rgba(buildPng(1, 1, 8, 0, [0, 77], extra)), [77, 77, 77, 255]);
});

test("decodePng throws Error for an unknown critical chunk", () => {
  const png = buildPng(1, 1, 8, 0, [0, 77], [chunk("ABCD", [])]);
  assert.throws(() => decodePng(png), /unknown critical chunk ABCD/);
});

test("decodePng throws Error when the signature is wrong", () => {
  const png = encodePng(blank(1, 1));
  png[1] = 0;
  assert.throws(() => decodePng(png), /signature/);
  assert.throws(() => decodePng(new Uint8Array(3)), /signature/);
});

test("decodePng throws Error when a chunk CRC is corrupted", () => {
  const png = encodePng(blank(2, 2, 0x09090909));
  const bad = png.slice();
  bad[bad.length - 20] ^= 0xff;
  assert.throws(() => decodePng(bad), /CRC/);
  const badHeader = png.slice();
  badHeader[20] ^= 1;
  assert.throws(() => decodePng(badHeader), /CRC mismatch in IHDR/);
});

test("decodePng throws Error for a truncated file", () => {
  const png = encodePng(blank(2, 2));
  assert.throws(() => decodePng(png.subarray(0, png.length - 5)), /truncated/);
});

test("decodePng throws Error for invalid IHDR values", () => {
  const mk = (w: number, h: number, depth: number, ct: number, il = 0) =>
    join([SIG, ihdr(w, h, depth, ct, il), chunk("IDAT", deflateSync(new Uint8Array(4))), chunk("IEND", [])]);
  assert.throws(() => decodePng(mk(0, 1, 8, 0)), /size/);
  assert.throws(() => decodePng(mk(1, 1, 3, 0)), /bit depth/);
  assert.throws(() => decodePng(mk(1, 1, 4, 2)), /bit depth 4 is not allowed for color type 2/);
  assert.throws(() => decodePng(mk(1, 1, 16, 3)), /bit depth/);
  assert.throws(() => decodePng(mk(1, 1, 8, 5)), /color type/);
  assert.throws(() => decodePng(mk(1, 1, 8, 0, 2)), /interlace/);
});

test("decodePng throws RangeError when width or height exceeds 16384", () => {
  const mk = (w: number, h: number) => join([SIG, ihdr(w, h, 8, 0), chunk("IEND", [])]);
  assert.throws(() => decodePng(mk(16385, 1)), RangeError);
  assert.throws(() => decodePng(mk(1, 16385)), RangeError);
});

test("decodePng throws Error when the image data length does not match the size", () => {
  assert.throws(() => decodePng(buildPng(2, 2, 8, 0, [0, 1, 2])), /expected 6/);
});

test("decodePng throws Error for a palette image without PLTE", () => {
  assert.throws(() => decodePng(buildPng(1, 1, 8, 3, [0, 0])), /PLTE/);
});

test("decodePng throws Error for an invalid filter type", () => {
  assert.throws(() => decodePng(buildPng(1, 1, 8, 0, [9, 0])), /filter type 9/);
});
