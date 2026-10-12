import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Font } from "../dist/lib/text.js";
import { layoutText, loadFont } from "../dist/lib/text.js";

/** Tiny 1-wide, 4-row synthetic font: rows 0-2 above baseline, row 3 descender. */
const TINY_FONT: Font = {
  name: "tiny",
  license: "CC0-1.0",
  cellWidth: 1,
  cellHeight: 4,
  baseline: 3,
  spaceWidth: 1,
  glyphs: {
    A: ["#", "#", "#", "."],
    B: ["#", "#", "#", "."],
  },
};

function bboxOf(pixels: { x: number; y: number }[]): { x: number; y: number; width: number; height: number } {
  const xs = pixels.map((p) => p.x);
  const ys = pixels.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX + 1, height: Math.max(...ys) - minY + 1 };
}

test("inkBounds equals the tight bounding box of the returned pixels", () => {
  const font = loadFont("pixel5x7");
  const layout = layoutText({ text: "A", x: 10, y: 10, color: "#ffffff", font });
  assert.ok(layout.pixels.length > 0);
  assert.deepEqual(layout.inkBounds, bboxOf(layout.pixels));
});

test("inkBounds equals the pixel bbox for multi-character, multi-line text too", () => {
  const font = loadFont("pixel5x7");
  const layout = layoutText({ text: "Hi\nYo", x: 3, y: 4, color: "#ff00ff", font });
  assert.deepEqual(layout.inkBounds, bboxOf(layout.pixels));
});

test("baseline_left anchor puts the font's baseline row exactly at y", () => {
  const layout = layoutText({
    text: "A",
    x: 5,
    y: 10,
    color: "#ffffff",
    font: TINY_FONT,
    anchor: "baseline_left",
  });
  // TINY_FONT's baseline is row index 2 (baseline: 3, 1-based-inclusive count).
  // "A" has ink on rows 0-2, so the baseline row's pixel must land at y=10 and
  // no ink pixel may fall below it (row 3 is blank for this glyph anyway).
  const baselinePixel = layout.pixels.find((p) => p.y === 10);
  assert.ok(baselinePixel, "expected a pixel on the baseline row");
  assert.equal(baselinePixel!.x, 5);
  assert.ok(layout.pixels.every((p) => p.y <= 10), "no ink should sit below the baseline for this glyph");
  // Top of the glyph (row 0) is two rows above the baseline.
  assert.ok(layout.pixels.some((p) => p.y === 8));
});

test("baseline anchor is independent of ink bounds, even across lines", () => {
  // Two-line text: baseline anchor must resolve against the FIRST line's
  // baseline, not the ink bounds of the whole block.
  const layout = layoutText({
    text: "A\nA",
    x: 0,
    y: 100,
    color: "#ffffff",
    font: TINY_FONT,
    anchor: "baseline_left",
    lineSpacing: 0,
  });
  assert.ok(layout.pixels.some((p) => p.y === 100), "first line's baseline must sit at y=100");
});

test("letterSpacing shifts each subsequent glyph by exactly that many pixels", () => {
  const base = layoutText({ text: "AB", x: 0, y: 0, color: "#ffffff", font: TINY_FONT, letterSpacing: 0 });
  const spaced = layoutText({ text: "AB", x: 0, y: 0, color: "#ffffff", font: TINY_FONT, letterSpacing: 3 });

  // TINY_FONT glyphs are 1px wide, so with letterSpacing 0, "B" sits at x=1
  // (immediately after "A"'s single column); with letterSpacing 3 it must
  // shift to x=1+3=4, and "A" itself (the first glyph) must not move.
  const aX = (l: typeof base) => Math.min(...l.pixels.map((p) => p.x));
  const bX = (l: typeof base) => Math.max(...l.pixels.map((p) => p.x));

  assert.equal(aX(base), 0);
  assert.equal(aX(spaced), 0);
  assert.equal(bX(base), 1);
  assert.equal(bX(spaced), 4);
});

test("bundled pixel5x7 font covers ASCII 32-126 with consistent per-glyph geometry", () => {
  const font = loadFont("pixel5x7");
  assert.equal(font.cellHeight, 7);

  for (let code = 32; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    const rows = font.glyphs[ch];
    assert.ok(rows, `missing glyph for ${JSON.stringify(ch)} (code ${code})`);
    assert.equal(rows!.length, font.cellHeight, `glyph ${JSON.stringify(ch)} must have ${font.cellHeight} rows`);
    const width = rows![0]!.length;
    for (const row of rows!) {
      assert.equal(row.length, width, `glyph ${JSON.stringify(ch)} has rows of inconsistent width`);
      assert.ok(/^[#.]+$/.test(row), `glyph ${JSON.stringify(ch)} row has a character other than '#'/'.'`);
    }
  }
});

test("loadFont refuses an unknown font name instead of guessing", () => {
  assert.throws(() => loadFont("does-not-exist"), /Unknown font/);
});

test("bold=1 grows ink one grid cell rightward per pass, without moving the leftmost column", () => {
  const plain = layoutText({ text: "A", x: 0, y: 0, color: "#ffffff", font: TINY_FONT, bold: 0 });
  const bold = layoutText({ text: "A", x: 0, y: 0, color: "#ffffff", font: TINY_FONT, bold: 1 });

  // TINY_FONT's "A" is 1 column wide, ink on rows 0-2 (row 3 is the blank
  // descender row). bold=0 must have exactly those 3 pixels at x=0; bold=1
  // must add one pixel per row strictly to the right, doubling the count and
  // widening inkBounds by exactly 1, while the left edge stays put.
  assert.equal(plain.pixels.length, 3);
  assert.ok(plain.pixels.every((p) => p.x === 0));
  assert.equal(plain.inkBounds?.width, 1);

  assert.equal(bold.pixels.length, 6);
  assert.equal(bold.inkBounds?.x, 0, "bold must not shift the ink's left edge");
  assert.equal(bold.inkBounds?.width, 2, "bold=1 must widen ink by exactly one column");
  const xs = new Set(bold.pixels.map((p) => p.x));
  assert.deepEqual([...xs].sort(), [0, 1]);
});

test("outlineDiagonals true includes corner neighbours, false excludes them; outline never moves the ink", () => {
  const font = loadFont("pixel5x7");
  const withDiag = layoutText({
    text: "H", x: 1, y: 1, color: "#ffffff", font, outlineColor: "#000000", outlineDiagonals: true,
  });
  const withoutDiag = layoutText({
    text: "H", x: 1, y: 1, color: "#ffffff", font, outlineColor: "#000000", outlineDiagonals: false,
  });

  // "H"'s top-left ink pixel is at (1, 1); its diagonal corner neighbour
  // (0, 0) is only an outline cell when diagonals are on.
  const has = (layout: typeof withDiag, x: number, y: number, color: string) =>
    layout.pixels.some((p) => p.x === x && p.y === y && p.color === color);

  assert.ok(has(withDiag, 0, 0, "#000000"), "diagonal corner must be outlined when outlineDiagonals is true");
  assert.ok(!has(withoutDiag, 0, 0, "#000000"), "diagonal corner must NOT be outlined when outlineDiagonals is false");

  // An orthogonal outline neighbour must be present either way.
  assert.ok(has(withDiag, 0, 1, "#000000"));
  assert.ok(has(withoutDiag, 0, 1, "#000000"));

  // Every outline pixel actually carries the outline colour, on both sides.
  for (const layout of [withDiag, withoutDiag]) {
    const outlinePixels = layout.pixels.filter((p) => !(p.x === 1 && has(layout, p.x, p.y, "#ffffff")));
    assert.ok(outlinePixels.some((p) => p.color === "#000000"));
  }

  // The glyph's own ink (inkBounds, and every white pixel) is identical
  // regardless of outlineDiagonals -- the outline decorates, it never moves it.
  assert.deepEqual(withDiag.inkBounds, withoutDiag.inkBounds);
  const whites = (l: typeof withDiag) =>
    l.pixels.filter((p) => p.color === "#ffffff").map((p) => `${p.x},${p.y}`).sort();
  assert.deepEqual(whites(withDiag), whites(withoutDiag));
});

test("shadowColor+shadowOffset places shadow pixels at ink+offset, except where overpainted, without moving the glyph", () => {
  const plain = layoutText({ text: "A", x: 0, y: 0, color: "#ffffff", font: TINY_FONT });
  const shadowed = layoutText({
    text: "A", x: 0, y: 0, color: "#ffffff", font: TINY_FONT,
    shadowColor: "#111111", shadowOffset: { x: 5, y: 5 },
  });

  // The glyph itself must not move: same inkBounds, same white pixels.
  assert.deepEqual(shadowed.inkBounds, plain.inkBounds);
  const whites = shadowed.pixels.filter((p) => p.color === "#ffffff");
  assert.deepEqual(
    whites.map((p) => `${p.x},${p.y}`).sort(),
    plain.pixels.map((p) => `${p.x},${p.y}`).sort(),
  );

  // Every ink pixel has a shadow pixel at +offset, since the offset (5,5)
  // lands nowhere the 1-wide, 3-tall glyph itself occupies -- nothing here
  // gets overpainted.
  const shadowKeys = new Set(
    shadowed.pixels.filter((p) => p.color === "#111111").map((p) => `${p.x},${p.y}`),
  );
  for (const p of plain.pixels) {
    assert.ok(shadowKeys.has(`${p.x + 5},${p.y + 5}`), `expected shadow at ${p.x + 5},${p.y + 5}`);
  }
  assert.equal(shadowKeys.size, plain.pixels.length);

  // Where the shadow offset lands ON ink (offset 0,0 is the degenerate
  // case), ink must win -- shadow is emitted before outline before ink.
  const overlap = layoutText({
    text: "A", x: 0, y: 0, color: "#ffffff", font: TINY_FONT,
    shadowColor: "#111111", shadowOffset: { x: 0, y: 0 },
  });
  for (const p of plain.pixels) {
    const hit = overlap.pixels.find((q) => q.x === p.x && q.y === p.y);
    assert.equal(hit?.color, "#ffffff", "ink must overpaint a coincident shadow pixel");
  }
});

test("scale=2 doubles inkBounds in each dimension and quadruples the pixel count", () => {
  const font = loadFont("pixel5x7");
  const base = layoutText({ text: "A", x: 10, y: 10, color: "#ffffff", font, scale: 1 });
  const doubled = layoutText({ text: "A", x: 10, y: 10, color: "#ffffff", font, scale: 2 });

  assert.ok(base.inkBounds && doubled.inkBounds);
  assert.equal(doubled.inkBounds!.width, base.inkBounds!.width * 2);
  assert.equal(doubled.inkBounds!.height, base.inkBounds!.height * 2);
  assert.equal(doubled.pixels.length, base.pixels.length * 4);
});

test("horizontal/vertical anchors resolve against known glyph math", () => {
  // "AB" in TINY_FONT (1px-wide glyphs, letterSpacing 1): ink occupies grid
  // columns 0 (A) and 2 (B), rows 0-2. inkGridBounds is x:[0,2], y:[0,2].
  const right = layoutText({ text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "right" });
  const topLeft = layoutText({ text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "top_left" });
  const top = layoutText({ text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "top" });
  const bottom = layoutText({ text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "bottom" });
  const center = layoutText({ text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "center" });
  const baselineRight = layoutText({
    text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "baseline_right",
  });
  const bottomRight = layoutText({
    text: "AB", x: 100, y: 100, color: "#ffffff", font: TINY_FONT, anchor: "bottom_right",
  });

  // "right": rightmost ink column (grid col 2) must land exactly at x=100.
  assert.equal(Math.max(...right.pixels.map((p) => p.x)), 100);
  // "left" (default top_left/bottom_left/baseline_left all share horizontal
  // left): leftmost ink column (grid col 0) lands at x.
  assert.equal(Math.min(...topLeft.pixels.map((p) => p.x)), 100);
  // "center": ink spans grid cols 0-2 (3 wide, odd); the centre column (1)
  // has no ink of its own, so the ink must straddle x symmetrically: min and
  // max are equidistant from 100.
  const centerXs = center.pixels.map((p) => p.x);
  assert.equal(100 - Math.min(...centerXs), Math.max(...centerXs) - 100);

  // "top": topmost ink row (grid row 0) lands at y=100.
  assert.equal(Math.min(...top.pixels.map((p) => p.y)), 100);
  // "bottom": bottommost ink row (grid row 2) lands at y=100.
  assert.equal(Math.max(...bottom.pixels.map((p) => p.y)), 100);
  // "center" (vertical middle, 3 rows, odd): the middle ink row (row 1)
  // lands at y=100.
  assert.ok(center.pixels.map((p) => p.y).includes(100));
  // "baseline_right" -- baseline row is font.baseline-1 = 2, which is also
  // the bottom ink row for this font, so it must coincide with "bottom_right".
  assert.deepEqual(
    [...new Set(baselineRight.pixels.map((p) => p.y))].sort((a, b) => a - b),
    [...new Set(bottomRight.pixels.map((p) => p.y))].sort((a, b) => a - b),
  );
});

test("multiline lineSpacing shifts every line after the first by exactly that many pixels, without moving the first line", () => {
  const tight = layoutText({ text: "A\nA", x: 0, y: 0, color: "#ffffff", font: TINY_FONT, lineSpacing: 0 });
  const spaced = layoutText({ text: "A\nA", x: 0, y: 0, color: "#ffffff", font: TINY_FONT, lineSpacing: 3 });

  // First line's ink (grid rows 0-2, y < 4) must be identical either way.
  const firstLine = (l: typeof tight) => l.pixels.filter((p) => p.y < 4).map((p) => `${p.x},${p.y}`).sort();
  assert.deepEqual(firstLine(tight), firstLine(spaced));

  // Second line's top row: cellHeight(4) + lineSpacing.
  const secondLineMinY = (l: typeof tight) => Math.min(...l.pixels.filter((p) => p.y >= 4).map((p) => p.y));
  assert.equal(secondLineMinY(tight), 4);
  assert.equal(secondLineMinY(spaced), 7);
});
