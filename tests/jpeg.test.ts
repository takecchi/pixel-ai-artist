import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeImage } from "../dist/lib/decode.js";
import type { Image } from "../dist/lib/image.js";
import { decodeJpeg } from "../dist/lib/jpeg.js";
import { decodePng } from "../dist/lib/png.js";

const jpg = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/jpeg/${name}.jpg`, import.meta.url)));
const png = (name: string): Image => decodePng(new Uint8Array(readFileSync(new URL(`./fixtures/jpeg/${name}.png`, import.meta.url))));

function maxChannelDiff(a: Image, b: Image): number {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let max = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    for (const shift of [24, 16, 8, 0]) {
      max = Math.max(max, Math.abs(((a.pixels[i]! >>> shift) & 255) - ((b.pixels[i]! >>> shift) & 255)));
    }
  }
  return max;
}

function patched(bytes: Uint8Array, edit: (copy: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice();
  edit(copy);
  return copy;
}

function markerOffset(bytes: Uint8Array, marker: number): number {
  for (let i = 2; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === marker) return i;
  throw new Error(`marker ${marker.toString(16)} not found`);
}

function withSegmentAfterSoi(bytes: Uint8Array, segment: number[]): Uint8Array {
  return Uint8Array.from([...bytes.subarray(0, 2), ...segment, ...bytes.subarray(2)]);
}

// Reference pixels come from libjpeg-turbo (via sharp); the decoder implements
// the same integer IDCT, fancy upsampling and colour conversion, so it must agree exactly.
const FIXTURES: [string, string][] = [
  ["baseline-444", "a baseline 4:4:4 JPEG"],
  ["baseline-420", "a baseline 4:2:0 JPEG with libjpeg's fancy upsampling"],
  ["baseline-422", "a baseline 4:2:2 JPEG with libjpeg's fancy upsampling"],
  ["baseline-440", "a baseline 4:4:0 JPEG with libjpeg's fancy upsampling"],
  ["gray", "a grayscale JPEG"],
  ["progressive-444", "a progressive JPEG with successive approximation"],
  ["progressive-420", "a progressive 4:2:0 JPEG with successive approximation"],
  ["progressive-gray", "a progressive grayscale JPEG with successive approximation"],
  ["restart-444", "a JPEG with restart intervals"],
  ["restart-420", "a 4:2:0 JPEG with restart intervals"],
  ["odd-13x9-444", "a 13x9 4:4:4 JPEG whose size is not a multiple of 8"],
  ["odd-13x9-420", "a 13x9 4:2:0 JPEG whose size is not a multiple of 16"],
  ["adobe-rgb", "an Adobe JPEG marked as RGB without a colour transform"],
];

for (const [name, what] of FIXTURES) {
  test(`decodeJpeg reads ${what}`, () => {
    const got = decodeJpeg(jpg(name));
    const want = png(name);
    assert.equal(maxChannelDiff(got, want), 0);
    assert.equal(got.pixels.length, got.width * got.height);
    assert.ok(got.pixels.every((p) => (p & 255) === 255));
  });
}

test("decodeJpeg returns the image size from the frame header", () => {
  const got = decodeJpeg(jpg("odd-13x9-420"));
  assert.deepEqual([got.width, got.height], [13, 9]);
});

test("decodeJpeg treats an Adobe transform of 0 differently from YCbCr", () => {
  assert.notEqual(maxChannelDiff(decodeJpeg(jpg("adobe-rgb")), decodeJpeg(jpg("baseline-444"))), 0);
});

test("decodeJpeg reads an extended sequential (SOF1) JPEG like baseline", () => {
  const base = jpg("baseline-444");
  const sof = markerOffset(base, 0xc0);
  const got = decodeJpeg(patched(base, (b) => (b[sof + 1] = 0xc1)));
  assert.equal(maxChannelDiff(got, png("baseline-444")), 0);
});

test("decodeJpeg ignores the EXIF orientation", () => {
  const exif = [0xff, 0xe1, 0, 30, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0];
  const got = decodeJpeg(withSegmentAfterSoi(jpg("baseline-444"), exif));
  assert.equal(maxChannelDiff(got, png("baseline-444")), 0);
});

test("decodeJpeg rejects arithmetic-coded JPEGs and names the feature", () => {
  const base = jpg("baseline-444");
  const sof = markerOffset(base, 0xc0);
  assert.throws(() => decodeJpeg(patched(base, (b) => (b[sof + 1] = 0xc9))), /arithmetic/);
  assert.throws(() => decodeJpeg(patched(base, (b) => (b[sof + 1] = 0xca))), /arithmetic/);
});

test("decodeJpeg rejects lossless JPEGs and names the feature", () => {
  const base = jpg("baseline-444");
  const sof = markerOffset(base, 0xc0);
  assert.throws(() => decodeJpeg(patched(base, (b) => (b[sof + 1] = 0xc3))), /lossless/);
});

test("decodeJpeg rejects hierarchical JPEGs and names the feature", () => {
  const base = jpg("baseline-444");
  const sof = markerOffset(base, 0xc0);
  assert.throws(() => decodeJpeg(patched(base, (b) => (b[sof + 1] = 0xc5))), /hierarchical/);
});

test("decodeJpeg rejects 12-bit JPEGs and names the precision", () => {
  const base = jpg("baseline-444");
  const sof = markerOffset(base, 0xc0);
  assert.throws(
    () =>
      decodeJpeg(
        patched(base, (b) => {
          b[sof + 1] = 0xc1;
          b[sof + 4] = 12;
        }),
      ),
    /12-bit/,
  );
});

test("decodeJpeg rejects four-component JPEGs and names CMYK", () => {
  const cmyk = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 20, 8, 0, 8, 0, 8, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0, 0xff, 0xd9,
  ]);
  assert.throws(() => decodeJpeg(cmyk), /CMYK/);
});

test("decodeJpeg throws RangeError for a width or height above 16384", () => {
  const base = jpg("baseline-444");
  const sof = markerOffset(base, 0xc0);
  assert.throws(() => decodeJpeg(patched(base, (b) => ((b[sof + 7] = 0x40), (b[sof + 8] = 0x01)))), RangeError);
  assert.throws(() => decodeJpeg(patched(base, (b) => ((b[sof + 5] = 0x40), (b[sof + 6] = 0x01)))), RangeError);
});

test("decodeJpeg rejects data without an SOI marker", () => {
  assert.throws(() => decodeJpeg(jpg("baseline-444").subarray(2)), /SOI/);
  assert.throws(() => decodeJpeg(new Uint8Array(0)), /SOI/);
});

test("decodeJpeg rejects a baseline JPEG cut off inside the scan", () => {
  const base = jpg("baseline-420");
  assert.throws(() => decodeJpeg(base.subarray(0, base.length >> 1)), Error);
});

test("decodeJpeg rejects a progressive JPEG cut off between scans", () => {
  const base = jpg("progressive-420");
  assert.throws(() => decodeJpeg(base.subarray(0, base.length - 30)), Error);
});

test("decodeJpeg reads a JPEG that ends after its last scan without an EOI marker", () => {
  const base = jpg("baseline-444");
  assert.deepEqual(decodeJpeg(base.subarray(0, base.length - 2)).pixels, decodeJpeg(base).pixels);
});

test("decodeJpeg rejects a JPEG cut off inside a marker segment", () => {
  const base = jpg("baseline-444");
  assert.throws(() => decodeJpeg(base.subarray(0, markerOffset(base, 0xdb) + 10)), /truncated/);
});

test("decodeJpeg rejects a corrupt marker", () => {
  const base = jpg("baseline-444");
  assert.throws(() => decodeJpeg(patched(base, (b) => ((b[2] = 0x12), (b[3] = 0x34)))), /marker/);
});

test("decodeJpeg rejects a restart interval whose RSTn marker is missing", () => {
  const base = jpg("restart-444");
  let rst = -1;
  for (let i = markerOffset(base, 0xda); i + 1 < base.length; i++) {
    if (base[i] === 0xff && base[i + 1]! >= 0xd0 && base[i + 1]! <= 0xd7) {
      rst = i;
      break;
    }
  }
  assert.ok(rst > 0);
  assert.throws(() => decodeJpeg(patched(base, (b) => (b[rst + 1] = 0xd5))), /restart/);
});

test("decodeJpeg rejects a scan before the frame header", () => {
  const base = jpg("baseline-444");
  const sos = markerOffset(base, 0xda);
  assert.throws(() => decodeJpeg(Uint8Array.from([0xff, 0xd8, ...base.subarray(sos)])), /frame header/);
});

test("decodeImage reads a JPEG by its leading bytes", () => {
  const got = decodeImage(jpg("baseline-420"));
  assert.ok(!Array.isArray(got));
  assert.equal(maxChannelDiff(got as Image, png("baseline-420")), 0);
});
