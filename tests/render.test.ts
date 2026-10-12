import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PixelRegion } from "../dist/lib/render.js";
import {
  filmstripLayout,
  GLYPH_COUNT,
  previewScale,
  renderAscii,
  renderDiff,
} from "../dist/lib/render.js";

function region(width: number, height: number, grid: number[], colors: string[]): PixelRegion {
  return { x: 0, y: 0, width, height, colors: ["#00000000", ...colors], grid };
}

test("renderAscii lays out one glyph per pixel with rulers", () => {
  const view = renderAscii(region(3, 2, [0, 1, 1, 1, 0, 2], ["#ff0000", "#00ff00"]));
  const lines = view.text.split("\n");
  // two ruler rows, then two pixel rows
  assert.equal(lines.length, 4);
  assert.ok(lines[2]!.endsWith(".AA"));
  assert.ok(lines[3]!.endsWith("A.B"));
  assert.deepEqual(view.legend, { A: "#ff0000", B: "#00ff00" });
});

test("renderAscii keeps absolute coordinates in the row labels", () => {
  const r = region(2, 2, [1, 1, 1, 1], ["#ffffff"]);
  r.x = 10;
  r.y = 7;
  const view = renderAscii(r);
  const lines = view.text.split("\n");
  assert.ok(lines[2]!.startsWith("7 "), `expected row label 7, got '${lines[2]}'`);
  assert.equal(view.originX, 10);
});

test("renderDiff marks unchanged, erased and repainted pixels distinctly", () => {
  const before = region(3, 1, [1, 1, 2], ["#ff0000", "#00ff00"]);
  const after = region(3, 1, [1, 0, 1], ["#ff0000"]);
  const diff = renderDiff(before, after);
  assert.equal(diff.text, ".-A");
  assert.equal(diff.changed, 2);
  assert.equal(diff.total, 3);
  assert.deepEqual(diff.legend, { A: "#ff0000" });
  assert.deepEqual(diff.changedBounds, { x: 1, y: 0, width: 2, height: 1 });
  assert.equal(diff.percentChanged, Math.round((2 / 3) * 10000) / 100);
});

test("renderDiff reports a null changedBounds and 0% when nothing changed", () => {
  const same = region(2, 2, [1, 1, 1, 1], ["#ff0000"]);
  const diff = renderDiff(same, same);
  assert.equal(diff.changed, 0);
  assert.equal(diff.changedBounds, null);
  assert.equal(diff.percentChanged, 0);
});

test("renderDiff's changedBounds is absolute, tracking the region's origin", () => {
  const before = region(3, 3, new Array(9).fill(0), []);
  const after = region(3, 3, new Array(9).fill(0), []);
  before.x = 10;
  before.y = 20;
  after.x = 10;
  after.y = 20;
  after.colors = ["#00000000", "#ff0000"];
  after.grid = [0, 0, 0, 0, 1, 0, 0, 0, 0]; // only the centre pixel changes
  const diff = renderDiff(before, after);
  assert.deepEqual(diff.changedBounds, { x: 11, y: 21, width: 1, height: 1 });
});

test("renderDiff refuses mismatched sizes instead of silently truncating", () => {
  assert.throws(
    () => renderDiff(region(2, 1, [0, 0], []), region(3, 1, [0, 0, 0], [])),
    /different sizes/,
  );
});

test("previewScale actually reaches the target for small sprites", () => {
  // A factor cap of 16 rendered a 16px sprite at 256px and an 8px one at 128px
  // — exactly the sizes where a vision model is otherwise guessing. The bound
  // belongs on the output size, not the factor.
  assert.equal(previewScale(8, 8, 1024) * 8, 1024);
  assert.equal(previewScale(16, 16, 1024) * 16, 1024);
  assert.equal(previewScale(32, 32, 1024) * 32, 1024);
  assert.equal(previewScale(128, 128, 1024), 8);
  assert.equal(previewScale(2048, 2048, 1024), 1); // never downscales below 1
  // and never explodes: the output edge stays bounded
  assert.ok(previewScale(1, 1, 1024) * 1 <= 2048);
});

test("renderAscii refuses colours past the alphabet instead of sharing a glyph", () => {
  // Past the alphabet every extra colour used to collapse onto "?" and
  // overwrite the same legend entry, so the grid quietly misreported which
  // colour was where — in the exact tool an agent uses to verify its own edits.
  const many = GLYPH_COUNT + 1;
  const colors = ["#00000000"];
  const grid: number[] = [];
  for (let i = 0; i < many; i++) {
    colors.push(`#${i.toString(16).padStart(4, "0")}00`);
    grid.push(i + 1);
  }
  assert.throws(() => renderAscii({ x: 0, y: 0, width: many, height: 1, colors, grid }), /has no glyph/);
  colors.pop();
  grid.pop();
  const fits = renderAscii({ x: 0, y: 0, width: many - 1, height: 1, colors, grid });
  assert.equal(new Set(fits.rows[0]).size, many - 1, "every colour gets its own glyph");
});

test("glyphs follow palette indices, whatever order a region meets the colours in", () => {
  const palette = ["#000000", "#ff0000", "#00ff00", "#0000ff"];
  const a = renderAscii(region(2, 1, [1, 2], ["#0000ff", "#ff0000"]), { palette });
  const b = renderAscii(region(2, 1, [1, 2], ["#ff0000", "#00ff00"]), { palette });
  assert.deepEqual(a.legend, { D: "#0000ff", B: "#ff0000" });
  assert.deepEqual(b.legend, { B: "#ff0000", C: "#00ff00" });
  assert.deepEqual(a.offPalette, []);
});

test("off-palette colours take glyphs after the palette and are reported as unstable", () => {
  const view = renderAscii(region(2, 1, [1, 2], ["#123456", "#ff0000"]), { palette: ["#000000", "#ff0000"] });
  assert.deepEqual(view.legend, { C: "#123456", B: "#ff0000" });
  assert.deepEqual(view.offPalette, ["C"]);
});

test("an indexed sprite's opaque pixel matches a palette entry that carries alpha", () => {
  const view = renderAscii(region(1, 1, [1], ["#ff0000"]), { palette: ["#000000", "#ff000080"] });
  assert.deepEqual(view.legend, { B: "#ff0000" });
  assert.deepEqual(view.offPalette, []);
});

test("renderDiff uses the same palette glyphs as renderAscii", () => {
  const palette = ["#000000", "#ff0000", "#00ff00"];
  const diff = renderDiff(region(1, 1, [1], ["#ff0000"]), region(1, 1, [1], ["#00ff00"]), palette);
  assert.equal(diff.text, "C");
  assert.deepEqual(diff.legend, { C: "#00ff00" });
});

test("filmstripLayout stays as square as whole cells allow", () => {
  assert.deepEqual(filmstripLayout(4), { cols: 2, rows: 2 });
  assert.deepEqual(filmstripLayout(5), { cols: 3, rows: 2 });
  assert.deepEqual(filmstripLayout(0), { cols: 0, rows: 0 });
});
