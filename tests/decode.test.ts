import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeImage } from "../dist/lib/decode.js";
import { encodePng } from "../dist/lib/png.js";
import { encodeGif } from "../dist/lib/gif.js";
import { Image } from "../dist/doc/model.js";

const image = Image.from(2, 1, Uint32Array.of(0xff0000ff, 0x00ff0080));

test("decodeImage returns an Image for PNG bytes", () => {
  const out = decodeImage(encodePng(image));
  assert.ok(!Array.isArray(out));
  assert.deepEqual(out, image);
});

test("decodeImage returns an array of frames for a GIF, even one with a single frame", () => {
  const solid = Image.from(2, 1, Uint32Array.of(0xff0000ff, 0x00ff00ff));
  const out = decodeImage(encodeGif([{ image: solid, durationMs: 120 }]));
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.durationMs, 120);
  assert.deepEqual(out[0]!.image, solid);
});

test("decodeImage returns every frame of an animated GIF", () => {
  const a = Image.from(1, 1, Uint32Array.of(0xff0000ff));
  const b = Image.from(1, 1, Uint32Array.of(0x0000ffff));
  const out = decodeImage(encodeGif([{ image: a, durationMs: 50 }, { image: b, durationMs: 70 }]));
  assert.ok(Array.isArray(out));
  assert.deepEqual(out.map((f) => f.durationMs), [50, 70]);
});

test("decodeImage throws Error for bytes that are not a supported image", () => {
  assert.throws(() => decodeImage(Uint8Array.from([1, 2, 3, 4])), Error);
  assert.throws(() => decodeImage(new Uint8Array(0)), Error);
  assert.throws(() => decodeImage(Buffer.from("BM")), /unsupported image format/);
});

test("decodeImage chooses the decoder by leading bytes, so a corrupt PNG is reported as a PNG error", () => {
  const png = encodePng(image);
  png[20] ^= 1;
  assert.throws(() => decodeImage(png), /CRC mismatch in IHDR/);
});
