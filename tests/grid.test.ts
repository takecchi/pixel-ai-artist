import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileGrid, type GridOp } from "../dist/lib/grid.js";
import { renderAscii } from "../dist/lib/render.js";

const CANVAS = { width: 64, height: 64 };

/**
 * Plays the compiled ops onto a canvas the way draw.batch does — clears, then
 * pixels — starting from `under`, so a test can assert what the sprite ends up
 * holding rather than which ops were emitted.
 */
function apply(op: GridOp, width: number, height: number, under: string | null = null): (string | null)[][] {
  const canvas: (string | null)[][] = Array.from({ length: height }, () => new Array(width).fill(under));
  for (const wire of compileGrid(op, { width, height }).ops) {
    if (wire.kind === "clear") {
      const r = wire.region as { x: number; y: number; width: number; height: number };
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          assert.equal(canvas[y]![x], under, `cell (${x},${y}) cleared twice or after painting`);
          canvas[y]![x] = null;
        }
      }
    } else {
      assert.equal(wire.kind, "pixels");
      for (const p of wire.points as { x: number; y: number }[]) canvas[p.y]![p.x] = wire.color as string;
    }
  }
  return canvas;
}

const legend = { O: "#1a1220", S: "#d08a5c" };

test("a grid lands at its x/y with every cell the colour its glyph names", () => {
  const op: GridOp = { x: 2, y: 1, legend, transparent: "erase", rows: [".OO.", "OSSO"] };
  const canvas = apply(op, 6, 3, "#ffffff");
  assert.deepEqual(canvas, [
    ["#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff"],
    ["#ffffff", "#ffffff", null, "#1a1220", "#1a1220", null],
    ["#ffffff", "#ffffff", "#1a1220", "#d08a5c", "#d08a5c", "#1a1220"],
  ]);
});

test("skip leaves the pixels under transparent cells alone", () => {
  const op: GridOp = { x: 0, y: 0, legend, transparent: "skip", rows: [".O", "S."] };
  assert.deepEqual(apply(op, 2, 2, "#ffffff"), [
    ["#ffffff", "#1a1220"],
    ["#d08a5c", "#ffffff"],
  ]);
});

test("transparent margins merge into a few clears instead of one per cell", () => {
  const rows = Array.from({ length: 16 }, (_, y) => (y === 8 ? ".......OO......." : "................"));
  const { ops, erased, painted } = compileGrid({ x: 0, y: 0, legend, transparent: "erase", rows }, CANVAS);
  assert.equal(painted, 2);
  assert.equal(erased, 254);
  // above, left of the dot, right of it, below
  assert.equal(ops.filter((o) => o.kind === "clear").length, 4);
});

test("'.' can be redefined as a colour", () => {
  const op: GridOp = { x: 0, y: 0, legend: { ".": "#000000", _: null }, transparent: "erase", rows: ["._"] };
  assert.deepEqual(apply(op, 2, 1, "#ffffff"), [["#000000", null]]);
});

test("a ragged row is refused with its index, not padded", () => {
  assert.throws(
    () => compileGrid({ x: 0, y: 5, legend, transparent: "erase", rows: ["OOOO", "OOO", "OOOO"] }, CANVAS),
    (err: Error & { details?: Record<string, unknown> }) =>
      /row 1 \(y=6\) has 3 cell\(s\) but row 0 has 4/.test(err.message) && err.details?.row === 1,
  );
});

test("an unknown glyph is refused with its location", () => {
  assert.throws(
    () => compileGrid({ x: 10, y: 0, legend, transparent: "erase", rows: ["OO", "OX"] }, CANVAS),
    /row 1, column 1 \(x=11, y=1\) uses 'X'/,
  );
});

test("legend keys must be single characters; astral glyphs count as one", () => {
  assert.throws(() => compileGrid({ x: 0, y: 0, legend: { OO: "#000000" }, transparent: "erase", rows: ["O"] }, CANVAS), /single character/);
  const op: GridOp = { x: 0, y: 0, legend: { "🟥": "#ff0000" }, transparent: "erase", rows: ["🟥."] };
  assert.deepEqual(apply(op, 2, 1), [["#ff0000", null]]);
});

test("look ascii rows compile back to the pixels they were read from", () => {
  const colors = ["#00000000", "#1a1220", "#d08a5c", "#6b4028"];
  const grid = [0, 1, 1, 0, 1, 2, 2, 1, 3, 3, 3, 3];
  const view = renderAscii({ x: 4, y: 7, width: 4, height: 3, colors, grid }, { showRulers: false });
  assert.deepEqual(view.text.split("\n"), view.rows, "rulers=false prints exactly the rows");

  const canvas = apply({ x: view.originX, y: view.originY, legend: view.legend, rows: view.rows, transparent: "erase" }, 8, 10, "#ffffff");
  for (let i = 0; i < grid.length; i++) {
    const x = 4 + (i % 4);
    const y = 7 + Math.floor(i / 4);
    assert.equal(canvas[y]![x], grid[i] === 0 ? null : colors[grid[i]!], `pixel (${x},${y})`);
  }
});

test("a grid may span the whole canvas but not one cell more", () => {
  const canvas = { width: 300, height: 2 };
  const full = ["O".repeat(300), "O".repeat(300)];
  assert.equal(compileGrid({ x: 0, y: 0, legend, transparent: "erase", rows: full }, canvas).painted, 600);
  assert.throws(
    () => compileGrid({ x: 0, y: 0, legend, transparent: "erase", rows: ["O".repeat(301), "O".repeat(301)] }, canvas),
    /Grid is 301×2 but the canvas is 300×2/,
  );
  assert.throws(
    () => compileGrid({ x: 0, y: 0, legend, transparent: "erase", rows: [...full, "O".repeat(300)] }, canvas),
    /Grid is 300×3/,
  );
});

test("rows read from one region draw back correctly into another region of the same sprite", () => {
  // The legend comes from one read and the rows from another: with per-read
  // glyphs, 'A' was a different colour in each and the paste recoloured art.
  const palette = ["#000000", "#1a1220", "#d08a5c"];
  const left = renderAscii({ x: 0, y: 0, width: 2, height: 1, colors: ["#00000000", "#d08a5c", "#1a1220"], grid: [1, 2] }, { palette });
  const right = renderAscii({ x: 2, y: 0, width: 2, height: 1, colors: ["#00000000", "#1a1220", "#d08a5c"], grid: [1, 2] }, { palette });
  const canvas = apply({ x: 2, y: 0, legend: left.legend, rows: right.rows, transparent: "erase" }, 4, 1);
  assert.deepEqual(canvas[0], [null, null, "#1a1220", "#d08a5c"]);
});
