import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { rgba } from "../dist/doc/index.js";
import { decodeJpeg } from "../dist/lib/jpeg.js";
import { distinctColors } from "../dist/lib/image.js";
import { encodeGif } from "../dist/lib/gif.js";
import { encodePng } from "../dist/lib/png.js";
import { readImageDocument } from "../dist/lib/image-document.js";

const jpg = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/jpeg/${name}.jpg`, import.meta.url))));

// ── PNG fixtures ────────────────────────────────────────────────────────

function chunk(type: string, body: number[] | Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** `rows` are already packed bytes; each gets filter type 0. */
function png(width: number, height: number, depth: number, colorType: number, rows: number[][], extra: Uint8Array[] = []): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const raw = Uint8Array.from(rows.flatMap((r) => [0, ...r]));
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", []),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

const PLTE = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]];
const plte = (n = PLTE.length) => chunk("PLTE", PLTE.slice(0, n).flat());
const BLACK = rgba(0, 0, 0);

// ── PNG, colour type 3 ──────────────────────────────────────────────────

test("a palette png opens as indexed with the PLTE as its palette and the palette numbers as pixels", () => {
  const doc = readImageDocument(png(4, 1, 8, 3, [[3, 0, 2, 1]], [plte()]));
  assert.equal(doc.colorMode, "indexed");
  assert.deepEqual(doc.palette, PLTE.map(([r, g, b]) => rgba(r!, g!, b!)));
  assert.deepEqual([...doc.frames[0]!.image.pixels], [3, 0, 2, 1]);
  assert.equal(doc.frames.length, 1);
});

test("a palette png keeps palette entries that no pixel uses", () => {
  const doc = readImageDocument(png(2, 1, 8, 3, [[0, 0]], [plte()]));
  assert.equal(doc.palette!.length, 4);
});

test("a palette png applies tRNS alphas to the palette", () => {
  const doc = readImageDocument(png(1, 1, 8, 3, [[0]], [plte(), chunk("tRNS", [200, 100])]));
  assert.deepEqual(doc.palette!.slice(0, 3), [rgba(255, 0, 0, 200), rgba(0, 255, 0, 100), rgba(0, 0, 255)]);
});

test("a palette png's transparent index is the first entry with alpha 0", () => {
  const doc = readImageDocument(png(1, 1, 8, 3, [[0]], [plte(), chunk("tRNS", [255, 0, 0])]));
  assert.equal(doc.transparentIndex, 1);
});

test("a palette png without a fully transparent entry has transparent index 0", () => {
  assert.equal(readImageDocument(png(1, 1, 8, 3, [[2]], [plte()])).transparentIndex, 0);
  assert.equal(readImageDocument(png(1, 1, 8, 3, [[2]], [plte(), chunk("tRNS", [255, 128, 1])])).transparentIndex, 0);
});

test("a palette png has a Background layer only when no palette entry has an alpha below 255", () => {
  assert.equal(readImageDocument(png(1, 1, 8, 3, [[0]], [plte()])).background, true);
  assert.equal(readImageDocument(png(1, 1, 8, 3, [[0]], [plte(), chunk("tRNS", [255, 255, 255, 255])])).background, true);
  assert.equal(readImageDocument(png(1, 1, 8, 3, [[0]], [plte(), chunk("tRNS", [255, 254])])).background, false);
  assert.equal(readImageDocument(png(1, 1, 8, 3, [[0]], [plte(), chunk("tRNS", [0])])).background, false);
});

// ── PNG, grayscale ──────────────────────────────────────────────────────

test("a grayscale png opens as grayscale with a palette of 256 black entries", () => {
  const doc = readImageDocument(png(2, 1, 8, 0, [[10, 200]]));
  assert.equal(doc.colorMode, "grayscale");
  assert.equal(doc.palette!.length, 256);
  assert.ok(doc.palette!.every((c) => c === BLACK));
  assert.equal(doc.transparentIndex, 0);
});

test("a grayscale+alpha png opens as grayscale with a palette of 256 black entries", () => {
  const doc = readImageDocument(png(1, 1, 8, 4, [[10, 255]]));
  assert.equal(doc.colorMode, "grayscale");
  assert.equal(doc.palette!.length, 256);
  assert.ok(doc.palette!.every((c) => c === BLACK));
});

test("a grayscale png has a Background layer unless a pixel matches its tRNS key", () => {
  assert.equal(readImageDocument(png(2, 1, 8, 0, [[10, 200]])).background, true);
  assert.equal(readImageDocument(png(2, 1, 8, 0, [[10, 200]], [chunk("tRNS", [0, 77])])).background, true);
  assert.equal(readImageDocument(png(2, 1, 8, 0, [[10, 200]], [chunk("tRNS", [0, 10])])).background, false);
});

test("a grayscale+alpha png never has a Background layer", () => {
  assert.equal(readImageDocument(png(1, 1, 8, 4, [[10, 255]])).background, false);
});

// ── PNG, RGB ────────────────────────────────────────────────────────────

test("an rgb png opens as rgb with its distinct opaque colours as the palette, in order of first appearance", () => {
  const doc = readImageDocument(png(3, 1, 8, 2, [[1, 2, 3, 9, 8, 7, 1, 2, 3]]));
  assert.equal(doc.colorMode, "rgb");
  assert.deepEqual(doc.palette, [rgba(1, 2, 3), rgba(9, 8, 7)]);
  assert.equal(doc.transparentIndex, 0);
  assert.deepEqual([...doc.frames[0]!.image.pixels], [rgba(1, 2, 3), rgba(9, 8, 7), rgba(1, 2, 3)]);
});

test("an rgba png's palette leaves out transparent pixels and makes translucent colours opaque", () => {
  const doc = readImageDocument(png(3, 1, 8, 6, [[1, 2, 3, 255, 5, 5, 5, 0, 9, 8, 7, 128]]));
  assert.equal(doc.colorMode, "rgb");
  assert.deepEqual(doc.palette, [rgba(1, 2, 3), rgba(9, 8, 7)]);
});

test("an rgb png with 256 colours has a palette and with 257 colours has none", () => {
  const colors = (n: number) => Array.from({ length: n }, (_, i) => rgba(i & 255, i >> 8, 0));
  const image = (n: number) => ({ width: n, height: 1, pixels: Uint32Array.from(colors(n)) });
  assert.equal(readImageDocument(encodePng(image(256))).palette!.length, 256);
  assert.equal(readImageDocument(encodePng(image(257))).palette, null);
});

test("an rgb png has a Background layer unless a pixel matches its tRNS key", () => {
  const rows = [[1, 2, 3, 4, 5, 6]];
  assert.equal(readImageDocument(png(2, 1, 8, 2, rows)).background, true);
  assert.equal(readImageDocument(png(2, 1, 8, 2, rows, [chunk("tRNS", [0, 9, 0, 9, 0, 9])])).background, true);
  assert.equal(readImageDocument(png(2, 1, 8, 2, rows, [chunk("tRNS", [0, 4, 0, 5, 0, 6])])).background, false);
});

test("an rgba png never has a Background layer, even when every pixel is opaque", () => {
  assert.equal(readImageDocument(png(1, 1, 8, 6, [[1, 2, 3, 255]])).background, false);
});

// ── GIF ─────────────────────────────────────────────────────────────────

const u16 = (v: number): number[] => [v & 255, v >> 8];

/** Pixels are literal 3-bit LZW codes with a clear code before every pair, so only indices 0..3 are expressible. */
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

const flat = (c: number[][]): number[] => c.flat();
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const BLACKRGB = [0, 0, 0];

interface HandFrame {
  pixels: number[];
  delay?: number;
  transparent?: number;
  local?: number[][];
}

/** A 2x2 GIF; `global` null leaves out the global colour table. */
function gif(global: number[][] | null, background: number, frames: HandFrame[]): Uint8Array {
  const out: number[] = [...Array.from("GIF89a", (c) => c.charCodeAt(0)), ...u16(2), ...u16(2)];
  out.push(global ? 0x80 | (Math.log2(global.length) - 1) : 0, background, 0);
  if (global) out.push(...flat(global));
  for (const f of frames) {
    if (f.delay !== undefined || f.transparent !== undefined) {
      const t = f.transparent ?? -1;
      out.push(0x21, 0xf9, 4, (1 << 2) | (t >= 0 ? 1 : 0), ...u16(f.delay ?? 0), Math.max(t, 0), 0);
    }
    out.push(0x2c, ...u16(0), ...u16(0), ...u16(2), ...u16(2));
    if (f.local) out.push(0x80 | (Math.log2(f.local.length) - 1), ...flat(f.local));
    else out.push(0);
    out.push(...lzwLiteral(f.pixels));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

const TABLE = [BLACKRGB, RED, GREEN, BLUE];
const word = (c: number[], a = 255): number => rgba(c[0]!, c[1]!, c[2]!, a);

test("a gif with only a global colour table opens as indexed with that table as its palette", () => {
  const doc = readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5 }]));
  assert.equal(doc.colorMode, "indexed");
  assert.deepEqual(doc.palette, TABLE.map((c) => word(c)));
});

test("an indexed gif's pixels are colour table numbers", () => {
  const doc = readImageDocument(gif(TABLE, 0, [{ pixels: [3, 2, 1, 0], delay: 5 }, { pixels: [1, 1, 2, 2], delay: 5 }]));
  assert.deepEqual([...doc.frames[0]!.image.pixels], [3, 2, 1, 0]);
  assert.deepEqual([...doc.frames[1]!.image.pixels], [1, 1, 2, 2]);
});

test("an indexed gif's transparent index is the first frame's transparent colour number", () => {
  const doc = readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5, transparent: 2 }]));
  assert.equal(doc.transparentIndex, 2);
  assert.deepEqual([...doc.frames[0]!.image.pixels], [0, 1, 2, 3]);
});

test("an indexed gif without a transparent colour uses the background colour number as its transparent index", () => {
  const doc = readImageDocument(gif(TABLE, 3, [{ pixels: [0, 1, 2, 3], delay: 5 }]));
  assert.equal(doc.transparentIndex, 3);
});

test("an indexed gif keeps transparent pixels as the transparent index", () => {
  const doc = readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5, transparent: 1 }]));
  assert.equal(doc.frames[0]!.image.pixels[1], 1);
});

test("an indexed gif extends the palette with black when the transparent number lies outside the colour table", () => {
  const doc = readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5, transparent: 6 }]));
  assert.equal(doc.palette!.length, 7);
  assert.deepEqual(doc.palette!.slice(4), [BLACK, BLACK, BLACK]);
  assert.equal(doc.transparentIndex, 6);
});

test("an indexed gif extends the palette with black when the background number lies outside the colour table", () => {
  const doc = readImageDocument(gif(TABLE, 5, [{ pixels: [0, 1, 2, 3], delay: 5 }]));
  assert.equal(doc.palette!.length, 6);
  assert.deepEqual(doc.palette!.slice(4), [BLACK, BLACK]);
  assert.equal(doc.transparentIndex, 5);
});

test("an indexed gif maps a colour that appears twice in the table to the first number that is not the transparent one", () => {
  const dup = [RED, GREEN, RED, BLUE];
  const doc = readImageDocument(gif(dup, 0, [{ pixels: [0, 1, 2, 3], delay: 5 }]));
  assert.equal(doc.transparentIndex, 0);
  assert.deepEqual([...doc.frames[0]!.image.pixels], [2, 1, 2, 3]);
});

test("an indexed gif maps a duplicated colour to its first number when that number is not transparent", () => {
  const dup = [RED, GREEN, RED, BLUE];
  const doc = readImageDocument(gif(dup, 1, [{ pixels: [0, 1, 2, 3], delay: 5 }]));
  assert.deepEqual([...doc.frames[0]!.image.pixels], [0, 1, 0, 3]);
});

test("a gif with local colour tables opens as rgb with the colours the frames use", () => {
  const doc = readImageDocument(
    gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5 }, { pixels: [0, 1, 2, 3], delay: 5, local: [BLUE, BLUE, BLACKRGB, RED] }]),
  );
  assert.equal(doc.colorMode, "rgb");
  assert.deepEqual(doc.palette, [BLACKRGB, RED, GREEN, BLUE].map((c) => word(c)));
  assert.deepEqual([...doc.frames[1]!.image.pixels], [BLUE, BLUE, BLACKRGB, RED].map((c) => word(c)));
});

test("a gif with only local colour tables opens as rgb", () => {
  const doc = readImageDocument(gif(null, 0, [{ pixels: [0, 1, 2, 3], delay: 5, local: TABLE }]));
  assert.equal(doc.colorMode, "rgb");
  assert.deepEqual(doc.palette, TABLE.map((c) => word(c)));
});

test("a gif frame's duration is at least 1 ms", () => {
  const doc = readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 0 }, { pixels: [0, 1, 2, 3], delay: 7 }, { pixels: [0, 1, 2, 3] }]));
  assert.deepEqual(doc.frames.map((f) => f.durationMs), [1, 70, 10]);
});

test("a gif has a Background layer only when its first frame has no transparent colour", () => {
  assert.equal(readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5 }])).background, true);
  assert.equal(readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5, transparent: 0 }])).background, false);
  assert.equal(readImageDocument(gif(TABLE, 0, [{ pixels: [0, 1, 2, 3], delay: 5 }, { pixels: [0, 1, 2, 3], delay: 5, transparent: 0 }])).background, true);
  assert.equal(
    readImageDocument(gif(null, 0, [{ pixels: [0, 1, 2, 3], delay: 5, local: TABLE, transparent: 1 }])).background,
    false,
  );
});

test("a gif written by encodeGif opens as indexed with its table", () => {
  const frame = { width: 2, height: 1, pixels: Uint32Array.of(rgba(255, 0, 0), rgba(0, 0, 255)) };
  const doc = readImageDocument(encodeGif([{ image: frame, durationMs: 100 }], { palette: ["#ff0000", "#00ff00", "#0000ff"] }));
  assert.equal(doc.colorMode, "indexed");
  assert.deepEqual([...doc.frames[0]!.image.pixels], [0, 2]);
  assert.deepEqual(doc.palette!.slice(0, 3), [rgba(255, 0, 0), rgba(0, 255, 0), rgba(0, 0, 255)]);
});

// ── JPEG ────────────────────────────────────────────────────────────────

for (const name of ["gray", "progressive-gray"]) {
  test(`the ${name} jpeg opens as grayscale with a 256-step gray palette and a Background layer`, () => {
    const doc = readImageDocument(jpg(name));
    assert.equal(doc.colorMode, "grayscale");
    assert.deepEqual(doc.palette, Array.from({ length: 256 }, (_, c) => rgba(c, c, c)));
    assert.equal(doc.background, true);
    assert.equal(doc.frames.length, 1);
  });
}

for (const name of ["baseline-444", "baseline-420", "adobe-rgb", "odd-13x9-420"]) {
  test(`the colour jpeg ${name} opens as rgb with a Background layer`, () => {
    const doc = readImageDocument(jpg(name));
    assert.equal(doc.colorMode, "rgb");
    assert.equal(doc.background, true);
    assert.deepEqual(doc.palette, distinctColors([decodeJpeg(jpg(name))]));
    assert.deepEqual(doc.frames[0]!.image.pixels, decodeJpeg(jpg(name)).pixels);
  });
}

// ── anything else ───────────────────────────────────────────────────────

test("bytes that are not a png, gif or jpeg throw", () => {
  assert.throws(() => readImageDocument(new Uint8Array(0)), /unsupported image format/);
  assert.throws(() => readImageDocument(new TextEncoder().encode("hello, world")), /unsupported image format/);
  assert.throws(() => readImageDocument(Uint8Array.of(0x42, 0x4d, 0, 0, 0, 0)), /unsupported image format/);
});
