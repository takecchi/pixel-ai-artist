import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Image, ToolError, rgba } from "../dist/doc/index.js";
import { decodeAse } from "../dist/lib/ase.js";
import { encodeGif } from "../dist/lib/gif.js";
import { readImageDocument } from "../dist/lib/image-document.js";
import { decodePaletteFile } from "../dist/lib/palette-file.js";
import { encodePng } from "../dist/lib/png.js";

const text = (s: string) => new TextEncoder().encode(s);
const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);

// ── .gpl ────────────────────────────────────────────────────────────────

test("gpl reads named RGB rows after the header, ignoring comments, Name and Columns", () => {
  const gpl = "GIMP Palette\nName: Test\nColumns: 4\n# a comment\n255   0   0\tRed\n  0 255 0 Green\n\n0 0 255 Blue\n";
  assert.deepEqual(decodePaletteFile(text(gpl), ".gpl"), [RED, GREEN, BLUE]);
});

test("gpl skips a row that has no name, as Aseprite does", () => {
  assert.deepEqual(decodePaletteFile(text("GIMP Palette\n255 0 0\n0 255 0 Green\n"), ".gpl"), [GREEN]);
});

test("gpl reads an alpha column after Channels: RGBA", () => {
  const gpl = "GIMP Palette\nChannels: RGBA\n#\n255 0 0 128 Half\n0 0 255 255 Solid\n";
  assert.deepEqual(decodePaletteFile(text(gpl), ".gpl"), [rgba(255, 0, 0, 128), BLUE]);
});

test("gpl without Channels: RGBA reads a fourth number as the name, so the colour stays opaque", () => {
  assert.deepEqual(decodePaletteFile(text("GIMP Palette\n255 0 0 128 Half\n"), ".gpl"), [RED]);
});

test("gpl with a wrong header holds no palette", () => {
  assert.deepEqual(decodePaletteFile(text("GIMP Palettes\n255 0 0 Red\n"), ".gpl"), []);
  assert.deepEqual(decodePaletteFile(text(""), ".gpl"), []);
});

test("gpl component values wrap modulo 256 like Aseprite's uint8 arguments", () => {
  assert.deepEqual(decodePaletteFile(text("GIMP Palette\n256 511 0 Wrap\n"), ".gpl"), [rgba(0, 255, 0)]);
});

// ── .hex ────────────────────────────────────────────────────────────────

test("hex reads the first six hex digits of each line, with or without #", () => {
  const hex = "ff0000\n#00ff00\r\n  0000FF  \nnot a colour\n\n";
  assert.deepEqual(decodePaletteFile(text(hex), ".hex"), [RED, GREEN, BLUE]);
});

test("hex ignores the digits after the sixth, so an eight-digit colour loses its alpha", () => {
  assert.deepEqual(decodePaletteFile(text("ff000080\n"), ".hex"), [RED]);
});

test("hex of a file with no colours holds no palette", () => {
  assert.deepEqual(decodePaletteFile(text("hello\nworld\n"), ".hex"), []);
});

// ── .pal ────────────────────────────────────────────────────────────────

test("pal reads a JASC-PAL file's rows and ignores the declared count", () => {
  const pal = "JASC-PAL\n0100\n99\n255 0 0\n0 255 0\n0 0 255\n";
  assert.deepEqual(decodePaletteFile(text(pal), ".pal"), [RED, GREEN, BLUE]);
});

test("pal reads an optional fourth number as alpha", () => {
  assert.deepEqual(decodePaletteFile(text("JASC-PAL\r\n0100\r\n2\r\n255 0 0 64\r\n0 0 255\r\n"), ".pal"), [rgba(255, 0, 0, 64), BLUE]);
});

test("pal with a wrong magic, wrong version or no count line holds no palette", () => {
  assert.deepEqual(decodePaletteFile(text("JASC-PAL\n0200\n1\n1 2 3\n"), ".pal"), []);
  assert.deepEqual(decodePaletteFile(text("RIFF....PAL data"), ".pal"), []);
  assert.deepEqual(decodePaletteFile(text("JASC-PAL\n0100\n"), ".pal"), []);
});

// ── .act ────────────────────────────────────────────────────────────────

function act(colors: number[][], trailer?: number[]): Uint8Array {
  const out = new Uint8Array(768 + (trailer?.length ?? 0));
  colors.forEach((c, i) => out.set(c, i * 3));
  if (trailer) out.set(trailer, 768);
  return out;
}

test("act of exactly 768 bytes is 256 colours", () => {
  const colors = decodePaletteFile(act([[255, 0, 0], [0, 255, 0]]), ".act");
  assert.equal(colors.length, 256);
  assert.deepEqual(colors.slice(0, 3), [RED, GREEN, rgba(0, 0, 0)]);
});

test("act with a trailer keeps only the colour count it names, big-endian, and ignores the transparent index", () => {
  const colors = decodePaletteFile(act([[255, 0, 0], [0, 255, 0], [0, 0, 255]], [0, 2, 0, 1]), ".act");
  assert.deepEqual(colors, [RED, GREEN]);
});

test("act caps the colour count at 256 and a count of zero holds no palette", () => {
  assert.equal(decodePaletteFile(act([], [0x01, 0x00, 0xff, 0xff]), ".act").length, 256);
  assert.deepEqual(decodePaletteFile(act([], [0, 0, 0xff, 0xff]), ".act"), []);
});

test("act shorter than 768 bytes still gives 256 colours, the missing ones black", () => {
  const colors = decodePaletteFile(new Uint8Array([255, 0, 0, 0, 255]), ".act");
  assert.equal(colors.length, 256);
  assert.deepEqual(colors.slice(0, 2), [RED, rgba(0, 255, 0)]);
  assert.equal(colors[255], rgba(0, 0, 0));
});

// ── .col ────────────────────────────────────────────────────────────────

test("col of 768 bytes is an Animator palette of 6-bit components scaled to 8 bits", () => {
  const bytes = new Uint8Array(768);
  bytes.set([63, 0, 32, 100, 1, 0]);
  const colors = decodePaletteFile(bytes, ".col");
  assert.equal(colors.length, 256);
  assert.deepEqual(colors.slice(0, 2), [rgba(255, 0, 130), rgba(255, 4, 0)]);
});

function colPro(colors: number[][], magic = 0xb123, version = 0): Uint8Array {
  const out = new Uint8Array(8 + colors.length * 3);
  new DataView(out.buffer).setUint32(0, out.length, true);
  new DataView(out.buffer).setUint16(4, magic, true);
  new DataView(out.buffer).setUint16(6, version, true);
  colors.forEach((c, i) => out.set(c, 8 + i * 3));
  return out;
}

test("col of any other size is an Animator Pro palette of full 8-bit components", () => {
  assert.deepEqual(decodePaletteFile(colPro([[255, 0, 0], [0, 0, 255]]), ".col"), [RED, BLUE]);
});

test("col with the wrong magic or version, a ragged size, or no bytes holds no palette", () => {
  assert.deepEqual(decodePaletteFile(colPro([[1, 2, 3]], 0x1234), ".col"), []);
  assert.deepEqual(decodePaletteFile(colPro([[1, 2, 3]], 0xb123, 1), ".col"), []);
  assert.deepEqual(decodePaletteFile(new Uint8Array(10), ".col"), []);
  assert.deepEqual(decodePaletteFile(new Uint8Array(0), ".col"), []);
});

// ── images ──────────────────────────────────────────────────────────────

const img = (width: number, height: number, pixels: number[]) => Image.from(width, height, new Uint32Array(pixels));

test("an RGB png gives its distinct non-transparent colours in order of first appearance, made opaque", () => {
  const half = rgba(9, 8, 7, 128);
  const png = encodePng(img(3, 2, [BLUE, 0, RED, BLUE, half, RED]));
  assert.deepEqual(decodePaletteFile(png, ".png"), [BLUE, RED, rgba(9, 8, 7)]);
});

test("an image is recognised by its bytes, whatever its extension", () => {
  assert.deepEqual(decodePaletteFile(encodePng(img(1, 1, [RED])), ".gpl"), [RED]);
});

test("an RGB png with more than 256 colours holds no palette", () => {
  const many = Array.from({ length: 257 }, (_, i) => rgba(i & 255, i >> 8, 0));
  assert.deepEqual(decodePaletteFile(encodePng(img(257, 1, many)), ".png"), []);
});

test("an indexed png gives its PLTE in order, with tRNS alphas, even for entries the pixels do not use", () => {
  const bytes = indexedPng([[1, 2, 3], [4, 5, 6], [7, 8, 9]], [0, 128], [0, 0, 1, 1]);
  assert.deepEqual(decodePaletteFile(bytes, ".png"), [rgba(1, 2, 3, 0), rgba(4, 5, 6, 128), rgba(7, 8, 9)]);
});

test("a grayscale png gives 256 black entries, as Aseprite's sequence loader replaces the gray ramp", () => {
  const colors = decodePaletteFile(grayPng(), ".png");
  assert.equal(colors.length, 256);
  assert.ok(colors.every((c) => c === rgba(0, 0, 0)));
});

test("an image's palette is the palette of the document readImageDocument builds", () => {
  const rgbPng = encodePng(img(2, 1, [RED, BLUE]));
  const indexed = indexedPng([[1, 2, 3], [4, 5, 6]], [0], [0, 1, 1, 0]);
  const frame = img(2, 1, [RED, BLUE]);
  const gifGlobal = encodeGif([{ image: frame, durationMs: 100 }], { palette: ["#ff0000", "#00ff00", "#0000ff"] });
  for (const bytes of [rgbPng, indexed, grayPng(), gifGlobal, gifLocal(), jpg("gray"), jpg("baseline-444")]) {
    const want = readImageDocument(bytes).palette ?? [];
    assert.deepEqual(decodePaletteFile(bytes, ".png"), want);
  }
});

test("a gif with only a global colour table gives that table", () => {
  const frame = img(2, 1, [RED, BLUE]);
  const bytes = encodeGif([{ image: frame, durationMs: 100 }], { palette: ["#ff0000", "#00ff00", "#0000ff"] });
  assert.deepEqual(decodePaletteFile(bytes, ".gif"), [RED, GREEN, BLUE, rgba(0, 0, 0)]);
});

test("a gif with a local colour table gives the colours its frames use", () => {
  assert.deepEqual(decodePaletteFile(gifLocal(), ".gif"), [RED, GREEN, BLUE]);
});

test("a grayscale jpeg gives the 256-step gray ramp and a colour jpeg its distinct colours", () => {
  const gray = decodePaletteFile(jpg("gray"), ".jpg");
  assert.deepEqual([gray.length, gray[0], gray[128], gray[255]], [256, rgba(0, 0, 0), rgba(128, 128, 128), rgba(255, 255, 255)]);
  const color = decodePaletteFile(jpg("baseline-444"), ".jpeg");
  assert.deepEqual(color, readImageDocument(jpg("baseline-444")).palette ?? []);
});

test("a png that is cut short holds no palette", () => {
  assert.deepEqual(decodePaletteFile(encodePng(img(2, 2, [RED, RED, RED, RED])).subarray(0, 40), ".png"), []);
});

// ── unsupported ─────────────────────────────────────────────────────────

function unsupported(bytes: Uint8Array, ext: string) {
  assert.throws(
    () => decodePaletteFile(bytes, ext),
    (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, "unsupported_command");
      assert.ok(Array.isArray(err.details.supported));
      return true;
    },
  );
}

test("an unreadable ase or aseprite file holds no palette", () => {
  assert.deepEqual(decodePaletteFile(new Uint8Array(4), ".ase"), []);
  assert.deepEqual(decodePaletteFile(new Uint8Array(4), ".aseprite"), []);
});

test("an .aseprite file is recognised by its magic number even under another extension", () => {
  const header = new Uint8Array(128);
  header[4] = 0xe0;
  header[5] = 0xa5;
  assert.deepEqual(decodePaletteFile(header, ".gpl"), []);
});

test("an .aseprite file gives the palette of its first frame", () => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/libresprite-1.3.ase", import.meta.url))));
  const flat = decodeAse(bytes).palette;
  const want = Array.from({ length: flat.length / 4 }, (_, i) => rgba(flat[i * 4]!, flat[i * 4 + 1]!, flat[i * 4 + 2]!, flat[i * 4 + 3]!));
  assert.ok(want.length > 0);
  assert.deepEqual(decodePaletteFile(bytes, ".aseprite"), want);
  assert.deepEqual(decodePaletteFile(bytes, ".gpl"), want);
});

test("an unknown or missing extension is unsupported_command and lists the readable ones", () => {
  unsupported(text("x"), ".txt");
  unsupported(text("x"), "");
  assert.throws(
    () => decodePaletteFile(text("x"), ".txt"),
    (err: unknown) => (err as ToolError).details.supported instanceof Array && (err as ToolError).details.supported.includes(".gpl"),
  );
});

test("extensions are matched in any case", () => {
  assert.deepEqual(decodePaletteFile(text("ff0000\n"), ".HEX"), [RED]);
});

// ── fixtures ────────────────────────────────────────────────────────────

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function png(colorType: number, width: number, height: number, rows: number[][], extra: Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = Uint8Array.from(rows.flatMap((r) => [0, ...r]));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

function indexedPng(plte: number[][], trns: number[], pixels: number[]): Uint8Array {
  return png(
    3,
    2,
    2,
    [pixels.slice(0, 2), pixels.slice(2)],
    [chunk("PLTE", Uint8Array.from(plte.flat())), chunk("tRNS", Uint8Array.from(trns))],
  );
}

const jpg = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/jpeg/${name}.jpg`, import.meta.url))));

/** A 2x2 GIF with no global colour table and one local table of red, green, blue, blue. */
function gifLocal(): Uint8Array {
  const bits: number[] = [];
  const put = (v: number) => {
    for (let i = 0; i < 3; i++) bits.push((v >> i) & 1);
  };
  for (const p of [[0, 1], [2, 3]]) {
    put(4);
    put(p[0]!);
    put(p[1]!);
  }
  put(5);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b, j) => v | (b << j), 0));
  return Uint8Array.from([
    ...Array.from("GIF89a", (c) => c.charCodeAt(0)), 2, 0, 2, 0, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x81, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255,
    2, data.length, ...data, 0, 0x3b,
  ]);
}

function grayPng(): Uint8Array {
  return png(0, 2, 1, [[10, 200]], []);
}
