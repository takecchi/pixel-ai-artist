import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolError, createStudio, rgba, rgbaToHex, type Sprite, type Studio } from "../dist/doc/index.js";
import { createServer } from "../dist/server.js";

type Res = Record<string, any>;

const R = "#ff0000";
const G = "#00ff00";
const B = "#0000ff";
const W = "#ffffff";
const CHARS: Record<string, string> = { [R]: "R", [G]: "G", [B]: "B", [W]: "W" };

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

/** The visible canvas at `frame`, one string per row: R G B W for the four test colours, '.' for no paint. */
function picture(studio: Studio, sprite: Sprite, frame = 1): string[] {
  const flat = studio.composite(sprite, frame);
  const out: string[] = [];
  for (let y = 0; y < flat.height; y++) {
    let row = "";
    for (let x = 0; x < flat.width; x++) {
      const c = flat.get(x, y);
      row += (c & 255) === 0 ? "." : (CHARS[rgbaToHex(c, false)] ?? "?");
    }
    out.push(row);
  }
  return out;
}

function setup(width = 5, height = 5, opts: Parameters<Studio["addSprite"]>[0] extends infer O ? Partial<O> : never = {}) {
  const studio = createStudio();
  const sprite = studio.addSprite({ width, height, ...opts });
  const draw = (ops: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    studio.call<Res>("draw.batch", { ops, paletteLock: false, ...extra });
  return { studio, sprite, draw };
}

const select = (studio: Studio, args: Record<string, unknown>) => studio.call<Res>("select.apply", args);

// ── draw.batch: results ─────────────────────────────────────────────────────

test("a batch answers with the sprite, layer, frame, op count, changed pixels, snapped colours and touched bounds", async () => {
  const { sprite, draw } = setup();
  const res = await draw([{ kind: "pixels", color: R, points: [{ x: 1, y: 1 }, { x: 3, y: 2 }] }]);
  assert.deepEqual(res, {
    sprite: "Sprite",
    layer: "Layer 1",
    frame: 1,
    opsApplied: 1,
    pixelsChanged: 2,
    colorsSnapped: [],
    bounds: { x: 1, y: 1, width: 3, height: 2 },
  });
  assert.equal(sprite.modified, true);
});

test("pixels take their own colour over the op's, and a pixel with neither is invalid_args", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }, { x: 1, y: 0, color: B }] }]);
  assert.deepEqual(picture(studio, sprite), ["RB."]);
  await rejectsWith(
    draw([{ kind: "pixels", points: [{ x: 2, y: 0 }] }]),
    "invalid_args",
    /A pixel has no colour and the op has no default `color`\./,
  );
});

test("an empty ops list changes nothing and reports no bounds", async () => {
  const { draw } = setup();
  const res = await draw([]);
  assert.equal(res.opsApplied, 0);
  assert.equal(res.pixelsChanged, 0);
  assert.equal(res.bounds, undefined);
});

test("missing ops is invalid_args naming the argument; an unknown kind is unsupported_command", async () => {
  const { studio, draw } = setup();
  await rejectsWith(studio.call("draw.batch", {}), "invalid_args", /Missing required argument 'ops'\./);
  await rejectsWith(draw([{ kind: "spline" }]), "unsupported_command", /Unknown draw op 'spline'\./);
});

// ── draw.batch: targets and cels ────────────────────────────────────────────

test("a batch draws on the named layer and frame without changing the active layer or frame", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  sprite.frames.push({ durationMs: 100 });
  const base = sprite.layers[0]!;
  const top = studio.addLayer(sprite, "ink");
  sprite.activeLayerId = base.id;
  const res = await draw([{ kind: "pixels", color: G, points: [{ x: 1, y: 0 }] }], { layer: "ink", frame: 2 });
  assert.equal(res.layer, "ink");
  assert.equal(res.frame, 2);
  assert.equal(sprite.activeLayerId, base.id);
  assert.equal(sprite.activeFrame, 1);
  assert.equal(top.cels.has(2), true);
  assert.equal(top.cels.has(1), false);
  assert.deepEqual(picture(studio, sprite, 2), [".G."]);
  assert.deepEqual(picture(studio, sprite, 1), ["..."]);
});

test("without a layer the batch draws on the active layer; an unknown layer or a frame past the end is invalid_args", async () => {
  const { studio, sprite, draw } = setup(2, 1);
  const upper = studio.addLayer(sprite, "upper");
  await draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }]);
  assert.equal(upper.cels.size, 1);
  await rejectsWith(draw([{ kind: "clear" }], { layer: "nope" }), "invalid_args", /No layer named 'nope'\./);
  await rejectsWith(draw([{ kind: "clear" }], { frame: 3 }), "invalid_args", /Frame 3 is out of range \(1\.\.1\)\./);
});

test("with no sprite open the batch answers no_active_sprite", async () => {
  await rejectsWith(createStudio().call("draw.batch", { ops: [] }), "no_active_sprite");
});

test("createCel false refuses a layer with no cel and leaves it without one", async () => {
  const { sprite, draw } = setup();
  await rejectsWith(
    draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }], { createCel: false }),
    "invalid_args",
    /No cel on 'Layer 1' frame 1 and createCel is false\./,
  );
  assert.equal(sprite.layers[0]!.cels.size, 0);
  assert.equal(sprite.modified, false);
});

test("createCel false still draws on a layer that has a cel", async () => {
  const { studio, sprite, draw } = setup(2, 1);
  await draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }]);
  await draw([{ kind: "pixels", color: B, points: [{ x: 1, y: 0 }] }], { createCel: false });
  assert.deepEqual(picture(studio, sprite), ["RB"]);
});

test("a batch that fails partway leaves the cel as it was, and creates none that did not exist", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await assert.rejects(draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }, { kind: "bogus" }]));
  assert.equal(sprite.layers[0]!.cels.size, 0);

  await draw([{ kind: "pixels", color: G, points: [{ x: 2, y: 0 }] }]);
  await assert.rejects(draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }, { kind: "bogus" }]));
  assert.deepEqual(picture(studio, sprite), ["..G"]);
});

test("a cel smaller than the canvas grows to take a pixel outside it, keeping what it held where it was", async () => {
  const { studio, sprite, draw } = setup(8, 8);
  const layer = sprite.layers[0]!;
  const cel = studio.ensureCel(sprite, layer, 1);
  cel.x = 3;
  cel.y = 3;
  cel.image = studio.newImage(sprite, 2, 2);
  cel.image.set(0, 0, rgba(255, 0, 0));
  await draw([{ kind: "pixels", color: B, points: [{ x: 0, y: 1 }] }]);
  assert.deepEqual([cel.x, cel.y, cel.image.width, cel.image.height], [0, 1, 5, 4]);
  assert.equal(picture(studio, sprite)[1]![0], "B");
  assert.equal(picture(studio, sprite)[3]![3], "R");
});

test("pixels off the canvas are dropped but still count in the reported bounds", async () => {
  const { studio, sprite, draw } = setup(3, 3);
  const res = await draw([{ kind: "pixels", color: R, points: [{ x: -2, y: 0 }, { x: 1, y: 1 }, { x: 9, y: 9 }] }]);
  assert.equal(res.pixelsChanged, 1);
  assert.deepEqual(res.bounds, { x: -2, y: 0, width: 12, height: 10 });
  assert.deepEqual(picture(studio, sprite), ["...", ".R.", "..."]);
});

// ── draw.batch: primitives ──────────────────────────────────────────────────

test("a line is drawn by Bresenham from one end to the other", async () => {
  const { studio, sprite, draw } = setup(5, 3);
  const res = await draw([{ kind: "line", color: R, from: { x: 0, y: 0 }, to: { x: 4, y: 2 } }]);
  assert.deepEqual(picture(studio, sprite), ["R....", ".RR..", "...RR"]);
  assert.equal(res.pixelsChanged, 5);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 5, height: 3 });
});

test("a thick line stamps a square of 2·floor(t/2)+1 pixels, and its bounds grow by the stamp's reach", async () => {
  const { studio, sprite, draw } = setup(5, 5);
  const res = await draw([{ kind: "line", color: R, from: { x: 2, y: 2 }, to: { x: 2, y: 2 }, thickness: 2 }]);
  assert.deepEqual(picture(studio, sprite), [".....", ".RRR.", ".RRR.", ".RRR.", "....."]);
  assert.equal(res.pixelsChanged, 9);
  assert.deepEqual(res.bounds, { x: 1, y: 1, width: 3, height: 3 });
});

test("a rect fills its box and outlines it on top, counting pixels written rather than pixels changed", async () => {
  const { studio, sprite, draw } = setup(6, 5);
  const res = await draw([{ kind: "rect", color: B, fill: G, rect: { x: 1, y: 1, width: 4, height: 3 } }]);
  assert.deepEqual(picture(studio, sprite), ["......", ".BBBB.", ".BGGB.", ".BBBB.", "......"]);
  assert.equal(res.pixelsChanged, 12 + 4 + 4 + 3 + 3);
});

test("a rect with only a fill paints no outline, and one with only a colour paints no fill", async () => {
  const filled = setup(4, 4);
  await filled.draw([{ kind: "rect", fill: G, rect: { x: 0, y: 0, width: 3, height: 3 } }]);
  assert.deepEqual(picture(filled.studio, filled.sprite), ["GGG.", "GGG.", "GGG.", "...."]);
  const outlined = setup(4, 4);
  await outlined.draw([{ kind: "rect", color: R, rect: { x: 0, y: 0, width: 3, height: 3 } }]);
  assert.deepEqual(picture(outlined.studio, outlined.sprite), ["RRR.", "R.R.", "RRR.", "...."]);
});

test("a filled ellipse covers exactly the pixels inside it, symmetric on both axes", async () => {
  const { studio, sprite, draw } = setup(4, 4);
  const res = await draw([{ kind: "ellipse", color: R, fill: R, rect: { x: 0, y: 0, width: 4, height: 4 } }]);
  assert.deepEqual(picture(studio, sprite), [".RR.", "RRRR", "RRRR", ".RR."]);
  assert.equal(res.pixelsChanged, 12);
});

test("an ellipse's outline is the inside pixels that touch the outside, and the fill is what is left", async () => {
  const { studio, sprite, draw } = setup(4, 4);
  await draw([{ kind: "ellipse", color: B, fill: G, rect: { x: 0, y: 0, width: 4, height: 4 } }]);
  assert.deepEqual(picture(studio, sprite), [".BB.", "BGGB", "BGGB", ".BB."]);
});

test("an odd-width ellipse is symmetric about its centre column", async () => {
  const { studio, sprite, draw } = setup(5, 5);
  await draw([{ kind: "ellipse", color: R, fill: R, rect: { x: 0, y: 0, width: 5, height: 5 } }]);
  // centre 2.5, radius 2.5: (0,0) is at 1.28 of the radius squared, outside; (1,0) at 0.8, inside
  assert.deepEqual(picture(studio, sprite), [".RRR.", "RRRRR", "RRRRR", "RRRRR", ".RRR."]);
});

test("an ellipse in a box one pixel wide is drawn as a rect", async () => {
  const { studio, sprite, draw } = setup(3, 4);
  await draw([{ kind: "ellipse", color: R, fill: R, rect: { x: 1, y: 0, width: 1, height: 3 } }]);
  assert.deepEqual(picture(studio, sprite), [".R.", ".R.", ".R.", "..."]);
});

test("a closed polyline's fill is the pixels whose centres are inside the polygon", async () => {
  const { studio, sprite, draw } = setup(5, 5);
  const res = await draw([
    { kind: "polyline", closed: true, fill: G, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }] },
  ]);
  assert.deepEqual(picture(studio, sprite), ["GGGG.", "GGG..", "GG...", "G....", "....."]);
  assert.equal(res.pixelsChanged, 10);
});

test("a closed polyline draws the side that closes the shape and an open one does not", async () => {
  const points = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }];
  const closed = setup(5, 5);
  await closed.draw([{ kind: "polyline", closed: true, color: R, points }]);
  assert.deepEqual(picture(closed.studio, closed.sprite), ["RRRRR", "R..R.", "R.R..", "RR...", "R...."]);
  const open = setup(5, 5);
  await open.draw([{ kind: "polyline", closed: false, color: R, points }]);
  assert.deepEqual(picture(open.studio, open.sprite), ["RRRRR", "...R.", "..R..", ".R...", "R...."]);
});

test("a closed polyline with a fill and a colour outlines over the fill", async () => {
  const { studio, sprite, draw } = setup(5, 5);
  await draw([
    { kind: "polyline", closed: true, color: B, fill: G, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }] },
  ]);
  assert.deepEqual(picture(studio, sprite), ["BBBBB", "BGGB.", "BGB..", "BB...", "B...."]);
});

// ── fill and replace ────────────────────────────────────────────────────────

test("a contiguous fill stops at a wall; a non-contiguous one takes every matching pixel", async () => {
  const wall = { kind: "line", color: B, from: { x: 2, y: 0 }, to: { x: 2, y: 4 } };
  const a = setup();
  await a.draw([wall]);
  const res = await a.draw([{ kind: "fill", color: R, at: { x: 0, y: 0 } }]);
  assert.deepEqual(picture(a.studio, a.sprite), ["RRB..", "RRB..", "RRB..", "RRB..", "RRB.."]);
  assert.equal(res.pixelsChanged, 10);

  const b = setup();
  await b.draw([wall]);
  const all = await b.draw([{ kind: "fill", color: R, at: { x: 0, y: 0 }, contiguous: false }]);
  assert.deepEqual(picture(b.studio, b.sprite), ["RRBRR", "RRBRR", "RRBRR", "RRBRR", "RRBRR"]);
  assert.equal(all.pixelsChanged, 20);
});

test("a fill that would paint the colour already there changes nothing, and one that starts off the canvas too", async () => {
  const { draw } = setup(3, 3);
  assert.equal((await draw([{ kind: "fill", color: "#00000000", at: { x: 0, y: 0 } }])).pixelsChanged, 0);
  assert.equal((await draw([{ kind: "fill", color: R, at: { x: 9, y: 9 } }])).pixelsChanged, 0);
});

test("fill tolerance is the largest per-channel difference still counted as the clicked colour", async () => {
  const mk = async (tolerance: number) => {
    const t = setup(3, 1);
    await t.draw([
      { kind: "pixels", points: [{ x: 0, y: 0, color: "#640000" }, { x: 1, y: 0, color: "#680000" }, { x: 2, y: 0, color: "#6e0000" }] },
    ]);
    await t.draw([{ kind: "fill", color: G, at: { x: 0, y: 0 }, tolerance }]);
    return picture(t.studio, t.sprite);
  };
  assert.deepEqual(await mk(0), ["G??"]);
  assert.deepEqual(await mk(3), ["G??"]);
  assert.deepEqual(await mk(4), ["GG?"]);
  assert.deepEqual(await mk(10), ["GGG"]);
});

test("fill tolerance does not apply to indexed sprites, whose pixels stay exact", async () => {
  const palette = [rgba(0, 0, 0, 0), rgba(100, 0, 0), rgba(104, 0, 0), rgba(0, 255, 0)];
  const { sprite, draw } = setup(3, 1, { colorMode: "indexed", palette });
  await draw([{ kind: "clear" }]);
  const cel = sprite.layers[0]!.cels.get(1)!;
  cel.image.pixels.set([1, 2, 1]);
  await draw([{ kind: "fill", color: "#00ff00", at: { x: 0, y: 0 }, tolerance: 255 }]);
  assert.deepEqual([...cel.image.pixels], [3, 2, 1]);
});

test("replace swaps one colour for another across the cel, or only inside a region", async () => {
  const seed = [{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] }];
  const whole = setup(4, 1);
  await whole.draw(seed);
  const res = await whole.draw([{ kind: "replace", from: R, to: B }]);
  assert.deepEqual(picture(whole.studio, whole.sprite), ["BBBB"]);
  assert.equal(res.pixelsChanged, 4);

  const part = setup(4, 1);
  await part.draw(seed);
  await part.draw([{ kind: "replace", from: R, to: B, region: { x: 1, y: 0, width: 2, height: 1 } }]);
  assert.deepEqual(picture(part.studio, part.sprite), ["RBBR"]);
});

test("replace leaves other colours alone", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await draw([{ kind: "pixels", points: [{ x: 0, y: 0, color: R }, { x: 1, y: 0, color: G }, { x: 2, y: 0, color: R }] }]);
  await draw([{ kind: "replace", from: R, to: W }]);
  assert.deepEqual(picture(studio, sprite), ["WGW"]);
});

test("replace with a region wholly off the canvas is invalid_args naming the canvas", async () => {
  const { draw } = setup(4, 4);
  await rejectsWith(
    draw([{ kind: "replace", from: R, to: B, region: { x: 9, y: 9, width: 2, height: 2 } }]),
    "invalid_args",
    /Region is empty after clamping to the 4x4 canvas\./,
  );
});

// ── dither and gradient ─────────────────────────────────────────────────────

test("bayer4 at ratio 0.5 lays a checkerboard with colorB where the matrix is below half", async () => {
  const { studio, sprite, draw } = setup(4, 4);
  const res = await draw([{ kind: "dither", rect: { x: 0, y: 0, width: 4, height: 4 }, colorA: R, colorB: B, pattern: "bayer4", ratio: 0.5 }]);
  assert.deepEqual(picture(studio, sprite), ["BRBR", "RBRB", "BRBR", "RBRB"]);
  assert.equal(res.pixelsChanged, 16);
});

test("checker and bayer2 give the same two-by-two pattern, and bayer4 is the default", async () => {
  for (const pattern of ["checker", "bayer2"]) {
    const { studio, sprite, draw } = setup(2, 2);
    await draw([{ kind: "dither", rect: { x: 0, y: 0, width: 2, height: 2 }, colorA: R, colorB: B, pattern, ratio: 0.5 }]);
    assert.deepEqual(picture(studio, sprite), ["BR", "RB"], pattern);
  }
  const { studio, sprite, draw } = setup(4, 4);
  await draw([{ kind: "dither", rect: { x: 0, y: 0, width: 4, height: 4 }, colorA: R, colorB: B }]);
  assert.deepEqual(picture(studio, sprite), ["BRBR", "RBRB", "BRBR", "RBRB"]);
});

test("a dither ratio of 0 is all colorA and 1 is all colorB, for every pattern", async () => {
  for (const pattern of ["checker", "bayer2", "bayer4", "bayer8", "noise"]) {
    for (const [ratio, want] of [[0, "RRRR"], [1, "BBBB"]] as const) {
      const { studio, sprite, draw } = setup(4, 1);
      await draw([{ kind: "dither", rect: { x: 0, y: 0, width: 4, height: 1 }, colorA: R, colorB: B, pattern, ratio }]);
      assert.deepEqual(picture(studio, sprite), [want], `${pattern} at ${ratio}`);
    }
  }
});

test("bayer8 takes colorB at exactly the cells whose matrix value is under the ratio", async () => {
  const { studio, sprite, draw } = setup(8, 8);
  await draw([{ kind: "dither", rect: { x: 0, y: 0, width: 8, height: 8 }, colorA: R, colorB: B, pattern: "bayer8", ratio: 0.05 }]);
  const rows = picture(studio, sprite);
  const blue: string[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "B" && blue.push(`${x},${y}`)));
  assert.deepEqual(blue.sort(), ["0,0", "4,0", "4,4"]);
});

test("the dither pattern tiles by canvas position, so it continues left of the origin", async () => {
  const { studio, sprite, draw } = setup(2, 1);
  const res = await draw([{ kind: "dither", rect: { x: -2, y: 0, width: 4, height: 1 }, colorA: R, colorB: B, pattern: "bayer4", ratio: 0.5 }]);
  assert.deepEqual(picture(studio, sprite), ["BR"]);
  assert.equal(res.pixelsChanged, 2);
});

test("an unknown dither pattern is invalid_args", async () => {
  const { draw } = setup();
  await rejectsWith(
    draw([{ kind: "dither", rect: { x: 0, y: 0, width: 2, height: 2 }, colorA: R, colorB: B, pattern: "lines" }]),
    "invalid_args",
    /Unknown dither pattern 'lines'\./,
  );
});

test("a vertical gradient with four steps lays one band per row, black to white in 85-steps", async () => {
  const { studio, sprite, draw } = setup(2, 4);
  await draw([{ kind: "gradient", rect: { x: 0, y: 0, width: 2, height: 4 }, from: "#000000", to: "#ffffff", steps: 4 }]);
  const flat = studio.composite(sprite, 1);
  assert.deepEqual([0, 1, 2, 3].map((y) => rgbaToHex(flat.get(1, y), false)), ["#000000", "#555555", "#aaaaaa", "#ffffff"]);
});

test("a horizontal gradient runs along x", async () => {
  const { studio, sprite, draw } = setup(4, 2);
  await draw([{ kind: "gradient", rect: { x: 0, y: 0, width: 4, height: 2 }, from: "#000000", to: "#ffffff", steps: 4, direction: "horizontal" }]);
  const flat = studio.composite(sprite, 1);
  assert.deepEqual([0, 1, 2, 3].map((x) => rgbaToHex(flat.get(x, 1), false)), ["#000000", "#555555", "#aaaaaa", "#ffffff"]);
});

test("a diagonal gradient bands by x+y, rounding halves up", async () => {
  const { studio, sprite, draw } = setup(3, 3);
  await draw([{ kind: "gradient", rect: { x: 0, y: 0, width: 3, height: 3 }, from: "#000000", to: "#ff0000", steps: 3, direction: "diagonal" }]);
  const flat = studio.composite(sprite, 1);
  const red = (x: number, y: number) => flat.get(x, y) >>> 24;
  assert.deepEqual([0, 1, 2].map((y) => [0, 1, 2].map((x) => red(x, y))), [
    [0, 128, 128],
    [128, 128, 255],
    [128, 255, 255],
  ]);
});

test("a radial gradient is the first colour at the centre and the last at the corners", async () => {
  const { studio, sprite, draw } = setup(3, 3);
  await draw([{ kind: "gradient", rect: { x: 0, y: 0, width: 3, height: 3 }, from: "#000000", to: "#ffffff", steps: 2, direction: "radial" }]);
  const flat = studio.composite(sprite, 1);
  const light = (x: number, y: number) => (flat.get(x, y) >>> 24) === 255;
  assert.deepEqual([0, 1, 2].map((y) => [0, 1, 2].map((x) => light(x, y))), [
    [true, false, true],
    [false, false, false],
    [true, false, true],
  ]);
});

test("a dithered gradient breaks the band boundary with the Bayer matrix instead of a hard edge", async () => {
  const { studio, sprite, draw } = setup(4, 4);
  await draw([{ kind: "gradient", rect: { x: 0, y: 0, width: 4, height: 4 }, from: "#000000", to: "#ffffff", steps: 2, dither: true }]);
  const flat = studio.composite(sprite, 1);
  const rows = [0, 1, 2, 3].map((y) => [0, 1, 2, 3].map((x) => ((flat.get(x, y) >>> 24) === 255 ? "1" : "0")).join(""));
  assert.deepEqual(rows, ["0000", "0100", "1011", "1111"]);
});

// ── clear and blit ──────────────────────────────────────────────────────────

test("clear without a region empties the whole cel and counts the pixels it erased", async () => {
  const { studio, sprite, draw } = setup(3, 2);
  await draw([{ kind: "rect", fill: R, rect: { x: 0, y: 0, width: 3, height: 2 } }]);
  const res = await draw([{ kind: "clear" }]);
  assert.deepEqual(picture(studio, sprite), ["...", "..."]);
  assert.equal(res.pixelsChanged, 6);
});

test("clear without a region counts only the painted pixels it erased, and bounds them", async () => {
  const { studio, sprite, draw } = setup(16, 16);
  await draw([{ kind: "rect", fill: R, rect: { x: 4, y: 5, width: 3, height: 2 } }]);
  const res = await draw([{ kind: "clear" }]);
  assert.equal(picture(studio, sprite).join(""), ".".repeat(256));
  assert.equal(res.pixelsChanged, 6);
  assert.deepEqual(res.bounds, { x: 4, y: 5, width: 3, height: 2 });
});

test("clear without a region on an empty cel changes nothing and bounds nothing", async () => {
  const { draw } = setup(4, 4);
  await draw([{ kind: "rect", fill: R, rect: { x: 0, y: 0, width: 1, height: 1 } }]);
  await draw([{ kind: "clear" }]);
  const again = await draw([{ kind: "clear" }]);
  assert.equal(again.pixelsChanged, 0);
  assert.equal(again.bounds, undefined);
});

test("clear with a region still counts every pixel it writes in that region, painted or not, as the extension did", async () => {
  const { draw } = setup(4, 1);
  await draw([{ kind: "pixels", color: R, points: [{ x: 1, y: 0 }] }]);
  const res = await draw([{ kind: "clear", region: { x: 0, y: 0, width: 3, height: 1 } }]);
  assert.equal(res.pixelsChanged, 3);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 3, height: 1 });
});

test("clear with a region erases only that region", async () => {
  const { studio, sprite, draw } = setup(4, 1);
  await draw([{ kind: "rect", fill: R, rect: { x: 0, y: 0, width: 4, height: 1 } }]);
  const res = await draw([{ kind: "clear", region: { x: 1, y: 0, width: 2, height: 1 } }]);
  assert.deepEqual(picture(studio, sprite), ["R..R"]);
  assert.equal(res.pixelsChanged, 2);
});

test("clear on an indexed sprite writes its transparent index, not 0", async () => {
  const palette = [rgba(255, 0, 0), rgba(0, 255, 0), rgba(0, 0, 0, 0)];
  const { sprite, draw } = setup(2, 1, { colorMode: "indexed", palette });
  sprite.transparentIndex = 2;
  await draw([{ kind: "rect", fill: "#ff0000", rect: { x: 0, y: 0, width: 2, height: 1 } }]);
  const cel = sprite.layers[0]!.cels.get(1)!;
  assert.deepEqual([...cel.image.pixels], [0, 0]);
  await draw([{ kind: "clear" }]);
  assert.deepEqual([...cel.image.pixels], [2, 2]);
  await draw([{ kind: "rect", fill: "#00ff00", rect: { x: 0, y: 0, width: 2, height: 1 } }]);
  await draw([{ kind: "clear", region: { x: 1, y: 0, width: 1, height: 1 } }]);
  assert.deepEqual([...cel.image.pixels], [1, 2]);
});

test("blit copies a region to a new place, skipping transparent source pixels by default", async () => {
  const { studio, sprite, draw } = setup(6, 2);
  await draw([{ kind: "pixels", points: [{ x: 0, y: 0, color: R }, { x: 2, y: 0, color: B }] }]);
  await draw([{ kind: "pixels", color: G, points: [{ x: 4, y: 0 }] }]);
  const res = await draw([{ kind: "blit", from: { x: 0, y: 0, width: 3, height: 1 }, to: { x: 3, y: 1 } }]);
  assert.deepEqual(picture(studio, sprite), ["R.B.G.", "...R.B"]);
  assert.equal(res.pixelsChanged, 2);
  assert.deepEqual(res.bounds, { x: 3, y: 1, width: 3, height: 1 });
});

test("blit with skipTransparent false copies the transparent pixels too", async () => {
  const { studio, sprite, draw } = setup(4, 1);
  await draw([{ kind: "pixels", points: [{ x: 0, y: 0, color: R }, { x: 3, y: 0, color: G }] }]);
  await draw([{ kind: "blit", from: { x: 0, y: 0, width: 2, height: 1 }, to: { x: 2, y: 0 }, skipTransparent: false }]);
  assert.deepEqual(picture(studio, sprite), ["R.R."]);
});

test("blit can flip horizontally and vertically as it copies", async () => {
  const { studio, sprite, draw } = setup(4, 4);
  await draw([{ kind: "pixels", points: [{ x: 0, y: 0, color: R }, { x: 1, y: 0, color: G }, { x: 0, y: 1, color: B }] }]);
  await draw([{ kind: "blit", from: { x: 0, y: 0, width: 2, height: 2 }, to: { x: 2, y: 2 }, flipHorizontal: true }]);
  assert.deepEqual(picture(studio, sprite), ["RG..", "B...", "..GR", "...B"]);
  await draw([{ kind: "clear", region: { x: 2, y: 2, width: 2, height: 2 } }]);
  await draw([{ kind: "blit", from: { x: 0, y: 0, width: 2, height: 2 }, to: { x: 2, y: 2 }, flipVertical: true }]);
  assert.deepEqual(picture(studio, sprite), ["RG..", "B...", "..B.", "..RG"]);
});

test("blit reads from another layer and frame when told to, and copies nothing from a cel that does not exist", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  sprite.frames.push({ durationMs: 100 });
  studio.addLayer(sprite, "ink");
  await draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }], { layer: "Layer 1", frame: 2 });
  const res = await draw(
    [{ kind: "blit", from: { x: 0, y: 0, width: 1, height: 1 }, to: { x: 2, y: 0 }, fromLayer: "Layer 1", fromFrame: 2 }],
    { layer: "ink", frame: 1 },
  );
  assert.equal(res.pixelsChanged, 1);
  assert.deepEqual(picture(studio, sprite, 1), ["..R"]);
  const none = await draw([{ kind: "blit", from: { x: 0, y: 0, width: 1, height: 1 }, to: { x: 1, y: 0 }, fromFrame: 1, fromLayer: "Layer 1" }], {
    layer: "ink",
    frame: 1,
  });
  assert.equal(none.pixelsChanged, 0);
});

test("a blit from the cel being drawn reads it as it was before the batch, not the earlier ops of the same batch", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await draw([
    { kind: "pixels", color: R, points: [{ x: 0, y: 0 }] },
    { kind: "blit", from: { x: 0, y: 0, width: 1, height: 1 }, to: { x: 2, y: 0 } },
  ]);
  assert.deepEqual(picture(studio, sprite), ["R.."]);
});

// ── palette lock and colour modes ───────────────────────────────────────────

const PALETTE = [rgba(0, 0, 0), rgba(255, 255, 255), rgba(255, 0, 0)];

test("palette lock snaps a colour to the nearest palette entry and reports each snap once", async () => {
  const { studio, sprite } = setup(3, 1, { palette: PALETTE });
  const res = await studio.call<Res>("draw.batch", {
    ops: [{ kind: "pixels", color: "#fe0101", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, { kind: "pixels", color: "#fe0101", points: [{ x: 2, y: 0 }] }],
  });
  assert.deepEqual(picture(studio, sprite), ["RRR"]);
  assert.equal(res.colorsSnapped.length, 1);
  const [snap] = res.colorsSnapped;
  assert.equal(snap.from, "#fe0101");
  assert.equal(snap.to, "#ff0000");
  assert.ok(snap.deltaE > 0 && snap.deltaE < 1, `deltaE ${snap.deltaE}`);
  assert.equal(Math.round(snap.deltaE * 100) / 100, snap.deltaE);
});

test("a colour already in the palette is not reported, and paletteLock false writes the colour as given", async () => {
  const { studio, sprite } = setup(2, 1, { palette: PALETTE });
  const kept = await studio.call<Res>("draw.batch", { ops: [{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }] });
  assert.deepEqual(kept.colorsSnapped, []);
  const loose = await studio.call<Res>("draw.batch", { paletteLock: false, ops: [{ kind: "pixels", color: "#fe0101", points: [{ x: 1, y: 0 }] }] });
  assert.deepEqual(loose.colorsSnapped, []);
  assert.equal(studio.composite(sprite, 1).get(1, 0), rgba(254, 1, 1));
});

test("palette lock keeps the alpha of the colour it moves, and does nothing against an empty palette", async () => {
  const locked = setup(1, 1, { palette: PALETTE });
  await locked.studio.call("draw.batch", { ops: [{ kind: "pixels", color: "#fe010180", points: [{ x: 0, y: 0 }] }] });
  assert.equal(locked.sprite.layers[0]!.cels.get(1)!.image.get(0, 0), rgba(255, 0, 0, 128));

  const empty = setup(1, 1);
  const res = await empty.studio.call<Res>("draw.batch", { ops: [{ kind: "pixels", color: "#123456", points: [{ x: 0, y: 0 }] }] });
  assert.deepEqual(res.colorsSnapped, []);
  assert.equal(empty.sprite.layers[0]!.cels.get(1)!.image.get(0, 0), rgba(0x12, 0x34, 0x56));
});

test("every colour of a gradient's bands goes through the palette lock", async () => {
  const { studio, sprite } = setup(2, 1, { palette: PALETTE });
  const res = await studio.call<Res>("draw.batch", {
    ops: [{ kind: "gradient", rect: { x: 0, y: 0, width: 2, height: 1 }, from: "#101010", to: "#f0f0f0", steps: 2, direction: "horizontal" }],
  });
  assert.deepEqual(res.colorsSnapped.map((s: Res) => [s.from, s.to]), [["#101010", "#000000"], ["#f0f0f0", "#ffffff"]]);
  assert.equal(studio.composite(sprite, 1).get(0, 0), rgba(0, 0, 0));
  assert.equal(studio.composite(sprite, 1).get(1, 0), rgba(255, 255, 255));
});

test("on an indexed sprite a colour becomes the RGB-nearest palette index, whatever paletteLock says", async () => {
  const palette = [rgba(0, 0, 0, 0), rgba(200, 0, 0), rgba(0, 200, 0)];
  const studio = createStudio();
  const s = studio.addSprite({ width: 2, height: 1, colorMode: "indexed", palette });
  const res = await studio.call<Res>("draw.batch", {
    ops: [{ kind: "pixels", points: [{ x: 0, y: 0, color: "#ff2020" }, { x: 1, y: 0, color: "#10f010" }] }],
  });
  assert.deepEqual([...s.layers[0]!.cels.get(1)!.image.pixels], [1, 2]);
  assert.deepEqual(res.colorsSnapped, []);
});

test("on a grayscale sprite a colour is stored as its luma with its alpha", async () => {
  const { sprite, draw } = setup(1, 1, { colorMode: "grayscale" });
  await draw([{ kind: "pixels", color: "#ff0000", points: [{ x: 0, y: 0 }] }]);
  assert.equal(sprite.layers[0]!.cels.get(1)!.image.get(0, 0), rgba(76, 76, 76, 255));
});

// ── selectionOnly ───────────────────────────────────────────────────────────

test("selectionOnly with nothing selected refuses rather than painting the whole cel", async () => {
  const { sprite, draw } = setup();
  await rejectsWith(
    draw([{ kind: "rect", fill: R, rect: { x: 0, y: 0, width: 5, height: 5 } }], { selectionOnly: true }),
    "invalid_args",
    /selectionOnly was set but nothing is selected\./,
  );
  assert.equal(sprite.layers[0]!.cels.size, 0);
});

test("selectionOnly clips every primitive to the selection", async () => {
  const { studio, sprite, draw } = setup(5, 5);
  await select(studio, { op: "rect", rect: { x: 1, y: 1, width: 3, height: 2 } });
  await draw(
    [
      { kind: "rect", fill: R, rect: { x: 0, y: 0, width: 5, height: 5 } },
      { kind: "line", color: B, from: { x: 0, y: 4 }, to: { x: 4, y: 4 } },
      { kind: "pixels", color: G, points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] },
    ],
    { selectionOnly: true },
  );
  assert.deepEqual(picture(studio, sprite), [".....", ".RRR.", ".RGR.", ".....", "....."]);
});

test("selectionOnly counts only the pixels that landed inside the selection", async () => {
  const { studio, draw } = setup(5, 5);
  await select(studio, { op: "rect", rect: { x: 1, y: 1, width: 2, height: 2 } });
  const res = await draw([{ kind: "rect", fill: R, rect: { x: 0, y: 0, width: 5, height: 5 } }], { selectionOnly: true });
  assert.equal(res.pixelsChanged, 4);
});

test("a fill under selectionOnly neither starts outside the selection nor leaks out of it", async () => {
  const { studio, sprite, draw } = setup(5, 5);
  await select(studio, { op: "rect", rect: { x: 1, y: 1, width: 2, height: 2 } });
  const outside = await draw([{ kind: "fill", color: R, at: { x: 0, y: 0 } }], { selectionOnly: true });
  assert.equal(outside.pixelsChanged, 0);
  const inside = await draw([{ kind: "fill", color: R, at: { x: 1, y: 1 } }], { selectionOnly: true });
  assert.equal(inside.pixelsChanged, 4);
  assert.deepEqual(picture(studio, sprite), [".....", ".RR..", ".RR..", ".....", "....."]);
});

test("clear under selectionOnly erases only the selected part of the cel", async () => {
  const { studio, sprite, draw } = setup(4, 1);
  await draw([{ kind: "rect", fill: R, rect: { x: 0, y: 0, width: 4, height: 1 } }]);
  await select(studio, { op: "rect", rect: { x: 1, y: 0, width: 2, height: 1 } });
  const res = await draw([{ kind: "clear" }], { selectionOnly: true });
  assert.deepEqual(picture(studio, sprite), ["R..R"]);
  assert.equal(res.pixelsChanged, 2);
});

test("the selection does not clip a later batch that does not ask for it", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await select(studio, { op: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } });
  await draw([{ kind: "pixels", color: R, points: [{ x: 0, y: 0 }] }], { selectionOnly: true });
  await draw([{ kind: "pixels", color: B, points: [{ x: 2, y: 0 }] }]);
  assert.deepEqual(picture(studio, sprite), ["R.B"]);
});

// ── select.apply ────────────────────────────────────────────────────────────

test("get reports no selection as empty with no bounds, and changes nothing", async () => {
  const { sprite, studio } = setup();
  assert.deepEqual(await select(studio, { op: "get" }), { sprite: "Sprite", empty: true, bounds: undefined, pixelCount: 0 });
  assert.equal(sprite.selection, null);
  assert.equal(sprite.modified, false);
});

test("rect selects the rectangle clamped to the canvas, and reports its bounds and pixel count", async () => {
  const { sprite, studio } = setup(6, 6);
  assert.deepEqual(await select(studio, { op: "rect", rect: { x: 1, y: 2, width: 3, height: 2 } }), {
    sprite: "Sprite",
    empty: false,
    bounds: { x: 1, y: 2, width: 3, height: 2 },
    pixelCount: 6,
  });
  assert.equal(sprite.modified, true);
  const clamped = await select(studio, { op: "rect", rect: { x: 4, y: 4, width: 9, height: 9 } });
  assert.deepEqual(clamped.bounds, { x: 4, y: 4, width: 2, height: 2 });
  assert.equal(clamped.pixelCount, 4);
});

test("all selects the whole canvas and none clears the selection", async () => {
  const { sprite, studio } = setup(3, 2);
  const all = await select(studio, { op: "all" });
  assert.deepEqual(all.bounds, { x: 0, y: 0, width: 3, height: 2 });
  assert.equal(all.pixelCount, 6);
  const none = await select(studio, { op: "none" });
  assert.equal(none.empty, true);
  assert.equal(none.pixelCount, 0);
  assert.equal(sprite.selection, null);
});

test("ellipse selects the pixels whose centres are inside the ellipse through the box's outer pixel centres", async () => {
  const { sprite, studio } = setup(5, 5);
  const res = await select(studio, { op: "ellipse", rect: { x: 0, y: 0, width: 5, height: 5 } });
  const mask = sprite.selection!.mask;
  const rows = [0, 1, 2, 3, 4].map((y) => [0, 1, 2, 3, 4].map((x) => (mask[y * 5 + x] ? "#" : ".")).join(""));
  // radius 2 about (2,2) measured to pixel corners: (1,1) is at 0.5 inside, (1,0) at 1.25 outside
  assert.deepEqual(rows, ["..#..", ".###.", "#####", ".###.", "..#.."]);
  assert.equal(res.pixelCount, 13);
});

test("a one-pixel-wide ellipse selection is that column", async () => {
  const { studio } = setup(3, 3);
  const res = await select(studio, { op: "ellipse", rect: { x: 1, y: 0, width: 1, height: 3 } });
  assert.deepEqual(res.bounds, { x: 1, y: 0, width: 1, height: 3 });
  assert.equal(res.pixelCount, 3);
});

test("color selects every pixel of the composited frame with that colour, ignoring alpha, wherever it is", async () => {
  const { studio, draw } = setup(4, 2);
  await draw([{ kind: "pixels", points: [{ x: 0, y: 0, color: R }, { x: 3, y: 1, color: R }, { x: 1, y: 0, color: B }, { x: 2, y: 1, color: "#ff000080" }] }]);
  const res = await select(studio, { op: "color", color: R });
  assert.equal(res.pixelCount, 3);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 4, height: 2 });
});

test("color with no match is an empty selection, and without a colour is invalid_args", async () => {
  const { studio } = setup();
  const res = await select(studio, { op: "color", color: R });
  assert.equal(res.empty, true);
  await rejectsWith(select(studio, { op: "color" }), "invalid_args", /Missing required argument 'color'\./);
});

/** The selection as rows of '#' and '.', for comparing against a hand-drawn picture. */
function selected(sprite: Sprite): string[] {
  const mask = sprite.selection?.mask ?? new Uint8Array(sprite.width * sprite.height);
  const rows: string[] = [];
  for (let y = 0; y < sprite.height; y++) {
    let row = "";
    for (let x = 0; x < sprite.width; x++) row += mask[y * sprite.width + x] ? "#" : ".";
    rows.push(row);
  }
  return rows;
}

const paint = (draw: ReturnType<typeof setup>["draw"], cells: Record<string, [number, number][]>) =>
  draw(Object.entries(cells).map(([color, at]) => ({ kind: "pixels", color, points: at.map(([x, y]) => ({ x, y })) })));

test("select color with contiguous picks only the region connected to the seed", async () => {
  const { studio, sprite, draw } = setup(4, 2);
  await paint(draw, { [R]: [[0, 0], [1, 0], [1, 1], [3, 0], [3, 1]], [B]: [[2, 0], [2, 1], [0, 1]] });
  const res = await select(studio, { op: "color", color: R, contiguous: true, x: 0, y: 0 });
  assert.deepEqual(selected(sprite), ["##..", ".#.."]);
  assert.equal(res.pixelCount, 3);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(sprite.modified, true);
});

test("select color without contiguous picks every match, wherever the seed would have been", async () => {
  const { studio, sprite, draw } = setup(4, 2);
  await paint(draw, { [R]: [[0, 0], [1, 0], [1, 1], [3, 0], [3, 1]], [B]: [[2, 0], [2, 1], [0, 1]] });
  await select(studio, { op: "color", color: R, contiguous: false, x: 0, y: 0 });
  assert.deepEqual(selected(sprite), ["##.#", ".#.#"]);
});

test("select color with contiguous does not cross diagonally", async () => {
  const { studio, sprite, draw } = setup(3, 2);
  await paint(draw, { [R]: [[0, 0], [1, 1]] });
  await select(studio, { op: "color", color: R, contiguous: true, x: 0, y: 0 });
  assert.deepEqual(selected(sprite), ["#..", "..."]);
});

test("select color with a tolerance takes colours within that per-channel distance and no further", async () => {
  const { studio, sprite, draw } = setup(4, 1);
  // #fa0505 is 5 away from red in every channel; #f01010 is 16 away in two.
  await paint(draw, { [R]: [[0, 0]], "#fa0505": [[1, 0]], "#f01010": [[2, 0]], [B]: [[3, 0]] });
  await select(studio, { op: "color", color: R });
  assert.deepEqual(selected(sprite), ["#..."]);
  await select(studio, { op: "color", color: R, tolerance: 4 });
  assert.deepEqual(selected(sprite), ["#..."]);
  await select(studio, { op: "color", color: R, tolerance: 5 });
  assert.deepEqual(selected(sprite), ["##.."]);
  await select(studio, { op: "color", color: R, tolerance: 16 });
  assert.deepEqual(selected(sprite), ["###."]);
});

test("select color with a tolerance counts alpha like fill does, while no tolerance still ignores it", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await paint(draw, { [R]: [[0, 0]], "#ff000080": [[1, 0]], "#ff0000f8": [[2, 0]] });
  await select(studio, { op: "color", color: R });
  assert.deepEqual(selected(sprite), ["###"]);
  await select(studio, { op: "color", color: R, tolerance: 7 });
  assert.deepEqual(selected(sprite), ["#.#"]);
  await select(studio, { op: "color", color: R, tolerance: 127 });
  assert.deepEqual(selected(sprite), ["###"]);
});

test("select color with a tolerance never selects transparent pixels", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await paint(draw, { [R]: [[0, 0]] });
  await select(studio, { op: "color", color: R, tolerance: 255 });
  assert.deepEqual(selected(sprite), ["#.."]);
});

test("select color with a tolerance and contiguous stops at a colour outside the tolerance", async () => {
  const { studio, sprite, draw } = setup(4, 1);
  await paint(draw, { [R]: [[0, 0], [3, 0]], "#fa0505": [[1, 0]], [B]: [[2, 0]] });
  await select(studio, { op: "color", color: R, tolerance: 5 });
  assert.deepEqual(selected(sprite), ["##.#"]);
  await select(studio, { op: "color", color: R, tolerance: 5, contiguous: true, x: 1, y: 0 });
  assert.deepEqual(selected(sprite), ["##.."]);
});

test("select color with contiguous from a seed that is not that colour selects nothing", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await paint(draw, { [R]: [[0, 0]], [B]: [[1, 0]] });
  const res = await select(studio, { op: "color", color: R, contiguous: true, x: 1, y: 0 });
  assert.equal(res.empty, true);
  assert.equal(sprite.selection, null);
});

test("select color with contiguous needs a seed on the canvas, else invalid_args", async () => {
  const { studio, draw } = setup(3, 1);
  await paint(draw, { [R]: [[0, 0]] });
  await rejectsWith(
    select(studio, { op: "color", color: R, contiguous: true }),
    "invalid_args",
    /select op 'color' with contiguous needs a starting point: pass 'x' and 'y'\./,
  );
  await rejectsWith(select(studio, { op: "color", color: R, contiguous: true, x: 0 }), "invalid_args", /starting point/);
  await rejectsWith(
    select(studio, { op: "color", color: R, contiguous: true, x: 3, y: 0 }),
    "invalid_args",
    /Starting point \(3, 0\) is outside the 3x1 canvas\./,
  );
});

test("a contiguous color selection combines with the existing selection by mode", async () => {
  const { studio, sprite, draw } = setup(4, 2);
  await paint(draw, { [R]: [[0, 0], [1, 0], [3, 0], [3, 1]] });
  await select(studio, { op: "rect", rect: { x: 3, y: 1, width: 1, height: 1 } });
  await select(studio, { op: "color", color: R, contiguous: true, x: 0, y: 0, mode: "add" });
  assert.deepEqual(selected(sprite), ["##..", "...#"]);
  await select(studio, { op: "color", color: R, contiguous: true, x: 0, y: 0, mode: "subtract" });
  assert.deepEqual(selected(sprite), ["....", "...#"]);
  await select(studio, { op: "all" });
  await select(studio, { op: "color", color: R, contiguous: true, x: 3, y: 0, mode: "intersect" });
  assert.deepEqual(selected(sprite), ["...#", "...#"]);
});

test("select color reads the composited frame, so a seed on an upper layer's paint counts", async () => {
  const { studio, sprite, draw } = setup(3, 1);
  await paint(draw, { [R]: [[0, 0]] });
  studio.addLayer(sprite, "Top");
  await studio.call("draw.batch", { layer: "Top", paletteLock: false, ops: [{ kind: "pixels", color: R, points: [{ x: 1, y: 0 }] }] });
  await select(studio, { op: "color", color: R, contiguous: true, x: 0, y: 0 });
  assert.deepEqual(selected(sprite), ["##."]);
});

test("invert selects what was not selected, and everything when nothing was", async () => {
  const { studio } = setup(3, 2);
  assert.equal((await select(studio, { op: "invert" })).pixelCount, 6);
  await select(studio, { op: "rect", rect: { x: 0, y: 0, width: 1, height: 2 } });
  const res = await select(studio, { op: "invert" });
  assert.equal(res.pixelCount, 4);
  assert.deepEqual(res.bounds, { x: 1, y: 0, width: 2, height: 2 });
});

test("grow and shrink move the selection's bounding box outward or inward by the amount", async () => {
  const { studio } = setup(8, 8);
  await select(studio, { op: "rect", rect: { x: 3, y: 3, width: 2, height: 2 } });
  const grown = await select(studio, { op: "grow", amount: 2 });
  assert.deepEqual(grown.bounds, { x: 1, y: 1, width: 6, height: 6 });
  assert.equal(grown.pixelCount, 36);
  const shrunk = await select(studio, { op: "shrink" });
  assert.deepEqual(shrunk.bounds, { x: 2, y: 2, width: 4, height: 4 });
});

test("growing past the canvas is clipped to it", async () => {
  const { studio } = setup(4, 4);
  await select(studio, { op: "rect", rect: { x: 1, y: 1, width: 2, height: 2 } });
  const res = await select(studio, { op: "grow", amount: 5 });
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 4, height: 4 });
});

test("grow and shrink with nothing selected are invalid_args", async () => {
  const { studio } = setup();
  await rejectsWith(select(studio, { op: "grow" }), "invalid_args", /Nothing is selected to grow\./);
  await rejectsWith(select(studio, { op: "shrink" }), "invalid_args", /Nothing is selected to shrink\./);
});

test("add, subtract and intersect combine a new selection with the existing one", async () => {
  const { studio } = setup(6, 2);
  await select(studio, { op: "rect", rect: { x: 0, y: 0, width: 4, height: 2 } });
  const added = await select(studio, { op: "rect", rect: { x: 3, y: 0, width: 3, height: 1 }, mode: "add" });
  assert.equal(added.pixelCount, 10);
  assert.deepEqual(added.bounds, { x: 0, y: 0, width: 6, height: 2 });
  const subtracted = await select(studio, { op: "rect", rect: { x: 0, y: 0, width: 2, height: 2 }, mode: "subtract" });
  assert.equal(subtracted.pixelCount, 6);
  assert.deepEqual(subtracted.bounds, { x: 2, y: 0, width: 4, height: 2 });
  const intersected = await select(studio, { op: "rect", rect: { x: 0, y: 1, width: 6, height: 1 }, mode: "intersect" });
  assert.equal(intersected.pixelCount, 2);
  assert.deepEqual(intersected.bounds, { x: 2, y: 1, width: 2, height: 1 });
});

test("an intersect that leaves nothing is an empty selection", async () => {
  const { sprite, studio } = setup(4, 1);
  await select(studio, { op: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } });
  const res = await select(studio, { op: "rect", rect: { x: 3, y: 0, width: 1, height: 1 }, mode: "intersect" });
  assert.equal(res.empty, true);
  assert.equal(sprite.selection, null);
});

test("none, all and invert replace the selection whatever the mode says", async () => {
  const { studio } = setup(3, 1);
  await select(studio, { op: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal((await select(studio, { op: "all", mode: "intersect" })).pixelCount, 3);
  assert.equal((await select(studio, { op: "none", mode: "add" })).empty, true);
});

test("a rect selection needs a rect, and one wholly off the canvas is invalid_args", async () => {
  const { studio } = setup(4, 4);
  await rejectsWith(select(studio, { op: "rect" }), "invalid_args", /Missing required argument 'rect'\./);
  await rejectsWith(
    select(studio, { op: "rect", rect: { x: 9, y: 9, width: 1, height: 1 } }),
    "invalid_args",
    /Region is empty after clamping to the 4x4 canvas\./,
  );
});

test("an unknown select op is unsupported_command, an unknown mode is invalid_args, and a missing op is invalid_args", async () => {
  const { studio } = setup();
  await rejectsWith(select(studio, { op: "wand" }), "unsupported_command", /select op 'wand' is not supported\./);
  await select(studio, { op: "all" });
  await rejectsWith(select(studio, { op: "rect", rect: { x: 0, y: 0, width: 1, height: 1 }, mode: "xor" }), "invalid_args", /Unknown selection mode 'xor'/);
  await rejectsWith(select(studio, {}), "invalid_args", /Missing required argument 'op'\./);
});

test("a selection is read back by sprite.info", async () => {
  const { studio } = setup(6, 6);
  await select(studio, { op: "rect", rect: { x: 2, y: 1, width: 3, height: 2 } });
  assert.deepEqual((await studio.call<Res>("sprite.info")).selection, { x: 2, y: 1, width: 3, height: 2 });
});

// ── through the MCP tools ───────────────────────────────────────────────────

function errorText(result: { content?: unknown }): string {
  return ((result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text) ?? "";
}

async function connected() {
  const { server, studio } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, studio, close: async () => { await server.close(); } };
}

test("the draw tool expands a grid into ops and the batch paints it, reporting the ops the agent sent", async () => {
  const { client, studio, close } = await connected();
  const sprite = studio.addSprite({ width: 4, height: 3 });
  const res = await client.callTool({
    name: "draw",
    arguments: {
      paletteLock: false,
      ops: [{ kind: "grid", x: 1, y: 1, legend: { r: R, b: B }, rows: ["rb", "br"] }],
    },
  });
  assert.ok(!res.isError);
  const data = res.structuredContent as Res;
  assert.equal(data.opsApplied, 1);
  assert.equal(data.pixelsChanged, 4);
  assert.deepEqual(picture(studio, sprite), ["....", ".RB.", ".BR."]);
  await close();
});

test("the draw tool expands text into pixels before the batch", async () => {
  const { client, studio, close } = await connected();
  const sprite = studio.addSprite({ width: 16, height: 12 });
  const res = await client.callTool({
    name: "draw",
    arguments: { paletteLock: false, ops: [{ kind: "text", text: "I", x: 1, y: 1, color: R }] },
  });
  assert.ok(!res.isError);
  const data = res.structuredContent as Res;
  assert.equal(data.opsApplied, 1);
  assert.ok(data.pixelsChanged > 0);
  assert.ok(picture(studio, sprite).some((row) => row.includes("R")));
  await close();
});

test("the draw tool returns a failed batch as a tool error with its code", async () => {
  const { client, studio, close } = await connected();
  studio.addSprite({ width: 4, height: 4 });
  const res = await client.callTool({
    name: "draw",
    arguments: { ops: [{ kind: "clear" }], selectionOnly: true },
  });
  assert.equal(res.isError, true);
  assert.match(errorText(res), /^invalid_args: /);
  await close();
});

test("the select tool's magic wand takes tolerance, contiguous and a start point through MCP", async () => {
  const { client, studio, close } = await connected();
  const sprite = studio.addSprite({ width: 4, height: 1 });
  await studio.call("draw.batch", {
    paletteLock: false,
    ops: [
      { kind: "pixels", color: R, points: [{ x: 0, y: 0 }, { x: 3, y: 0 }] },
      { kind: "pixels", color: "#fa0505", points: [{ x: 1, y: 0 }] },
      { kind: "pixels", color: B, points: [{ x: 2, y: 0 }] },
    ],
  });
  // Defaults (tolerance 0, not contiguous) keep the old exact, whole-canvas match.
  const exact = await client.callTool({ name: "select", arguments: { op: "color", color: R } });
  assert.deepEqual(selected(sprite), ["#..#"]);
  assert.equal((exact.structuredContent as Res).pixelCount, 2);
  const wand = await client.callTool({
    name: "select",
    arguments: { op: "color", color: R, tolerance: 5, contiguous: true, x: 0, y: 0 },
  });
  assert.ok(!wand.isError);
  assert.deepEqual(selected(sprite), ["##.."]);
  assert.deepEqual(wand.structuredContent, {
    sprite: "Sprite",
    empty: false,
    bounds: { x: 0, y: 0, width: 2, height: 1 },
    pixelCount: 2,
  });
  const bad = await client.callTool({ name: "select", arguments: { op: "color", color: R, contiguous: true } });
  assert.equal(bad.isError, true);
  assert.match(errorText(bad), /^invalid_args: /);
  await close();
});

test("the select tool selects through MCP and its result reads back", async () => {
  const { client, studio, close } = await connected();
  studio.addSprite({ width: 6, height: 6 });
  const res = await client.callTool({ name: "select", arguments: { op: "rect", rect: { x: 1, y: 1, width: 2, height: 3 } } });
  assert.ok(!res.isError);
  assert.deepEqual(res.structuredContent, {
    sprite: "Sprite",
    empty: false,
    bounds: { x: 1, y: 1, width: 2, height: 3 },
    pixelCount: 6,
  });
  await close();
});
