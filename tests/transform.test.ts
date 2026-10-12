import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { ToolError, createStudio, pixelToHex, rgba, type Sprite, type Studio } from "../dist/doc/index.js";

type Reply = Record<string, any>;

const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

/** A sprite whose only layer has a full-canvas cel with `pixels` drawn at the given points. */
function sketch(studio: Studio, width: number, height: number, pixels: [number, number, number][], opts = {}) {
  const sprite = studio.addSprite({ width, height, ...opts });
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  for (const [x, y, v] of pixels) cel.image.set(x, y, v);
  return { sprite, cel };
}

/** The cel's pixels as rows of hex-or-dot, for reading a transform's result at a glance. */
function rows(sprite: Sprite, cel: { image: { width: number; height: number; get(x: number, y: number): number } }) {
  const letter: Record<string, string> = { "#ff0000": "R", "#00ff00": "G", "#0000ff": "B" };
  const out: string[] = [];
  for (let y = 0; y < cel.image.height; y++) {
    let row = "";
    for (let x = 0; x < cel.image.width; x++) {
      const hex = pixelToHex(sprite, cel.image.get(x, y));
      row += hex === null ? "." : (letter[hex] ?? "?");
    }
    out.push(row);
  }
  return out;
}

test("flip horizontal mirrors each row and reports every pixel of the cel as changed", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 3, 2, [[0, 0, RED], [1, 0, GREEN], [2, 0, BLUE], [0, 1, RED]]);
  const r = await studio.call<Reply>("transform.apply", { op: "flip" });
  assert.deepEqual(rows(sprite, cel), ["BGR", "..R"]);
  assert.equal(r.pixelsChanged, 6);
  assert.equal(r.op, "flip");
  assert.equal(r.sprite, "Sprite");
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 3, height: 2 });
  assert.equal(sprite.modified, true);
});

test("flip vertical mirrors the rows top to bottom", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 3, [[0, 0, RED], [1, 2, BLUE]]);
  await studio.call("transform.apply", { op: "flip", axis: "vertical" });
  assert.deepEqual(rows(sprite, cel), [".B", "..", "R."]);
});

test("rotate defaults to 90 degrees clockwise and swaps the cel's width and height", async () => {
  const studio = createStudio();
  // 2 wide, 3 tall:  RG / B. / .R
  const { sprite, cel } = sketch(studio, 2, 3, [[0, 0, RED], [1, 0, GREEN], [0, 1, BLUE], [1, 2, RED]]);
  const r = await studio.call<Reply>("transform.apply", { op: "rotate" });
  // (x, y) -> (h-1-y, x): clockwise, so the top row becomes the right column.
  assert.deepEqual(rows(sprite, cel), [".BR", "R.G"]);
  assert.equal(cel.image.width, 3);
  assert.equal(cel.image.height, 2);
  assert.equal(r.pixelsChanged, 6);
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 3, height: 2 });
});

test("rotate 270 turns the cel counter-clockwise and rotate 180 turns it over", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 3, [[0, 0, RED], [1, 0, GREEN], [0, 1, BLUE], [1, 2, RED]]);
  await studio.call("transform.apply", { op: "rotate", angle: 270 });
  // (x, y) -> (y, w-1-x): the top row becomes the left column, read bottom to top.
  assert.deepEqual(rows(sprite, cel), ["G.R", "RB."]);
});

test("rotating by 180 sends each pixel to the opposite corner, and by 0 changes nothing and says so", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 3, 2, [[0, 0, RED], [2, 1, BLUE]]);
  const none = await studio.call<Reply>("transform.apply", { op: "rotate", angle: 360 });
  assert.equal(none.pixelsChanged, 0);
  assert.deepEqual(rows(sprite, cel), ["R..", "..B"]);
  const r = await studio.call<Reply>("transform.apply", { op: "rotate", angle: -180 });
  assert.equal(r.pixelsChanged, 6);
  assert.deepEqual(rows(sprite, cel), ["B..", "..R"]);
});

test("an angle that is not a multiple of 90 is refused with the extension's wording", async () => {
  const studio = createStudio();
  sketch(studio, 3, 3, [[0, 0, RED]]);
  await rejectsWith(
    studio.call("transform.apply", { op: "rotate", angle: 45 }),
    "invalid_args",
    /^Only 90\/180\/270 rotations are lossless\. The server should have blocked this; pass allowLossy there if the user accepted the quality loss\.$/,
  );
});

test("scale repeats each pixel factor times in both directions", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 1, [[0, 0, RED], [1, 0, BLUE]]);
  const r = await studio.call<Reply>("transform.apply", { op: "scale", factor: 2 });
  assert.equal(r.pixelsChanged, 8);
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 4, height: 2 });
  assert.deepEqual(rows(sprite, cel), ["RRBB", "RRBB"]);
});

test("scale without a factor doubles", async () => {
  const studio = createStudio();
  const { cel } = sketch(studio, 3, 3, []);
  await studio.call("transform.apply", { op: "scale" });
  assert.equal(cel.image.width, 6);
});

test("translate moves the cel by dx, dy and reports its size as changed", async () => {
  const studio = createStudio();
  const { cel } = sketch(studio, 4, 4, [[0, 0, RED]]);
  const r = await studio.call<Reply>("transform.apply", { op: "translate", dx: 2, dy: -1 });
  assert.deepEqual([cel.x, cel.y], [2, -1]);
  assert.equal(r.pixelsChanged, 16);
  assert.deepEqual(r.bounds, { x: 2, y: -1, width: 4, height: 4 });
  await studio.call("transform.apply", { op: "translate", dx: 1 });
  assert.deepEqual([cel.x, cel.y], [3, -1]);
});

test("outside outline paints the four neighbours of a lone pixel and grows the cel by one pixel each way", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 3, 3, [[1, 1, RED]]);
  const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00" });
  assert.equal(r.pixelsChanged, 4);
  assert.deepEqual(r.bounds, { x: -1, y: -1, width: 5, height: 5 });
  assert.deepEqual(rows(sprite, cel), [".....", "..G..", ".GRG.", "..G..", "....."]);
});

test("outside outline with diagonals paints all eight neighbours", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 3, 3, [[1, 1, RED]]);
  const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", diagonals: true });
  assert.equal(r.pixelsChanged, 8);
  assert.deepEqual(rows(sprite, cel), [".....", ".GGG.", ".GRG.", ".GGG.", "....."]);
});

test("inside outline recolours opaque pixels that touch transparency or the cel edge, and keeps the cel's size", async () => {
  const studio = createStudio();
  const px: [number, number, number][] = [];
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) px.push([x, y, RED]);
  const { sprite, cel } = sketch(studio, 5, 5, px);
  const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", side: "inside" });
  assert.equal(r.pixelsChanged, 8);
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 5, height: 5 });
  assert.deepEqual(rows(sprite, cel), [".....", ".GGG.", ".GRG.", ".GGG.", "....."]);

  const full = createStudio();
  const filled: [number, number, number][] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) filled.push([x, y, RED]);
  const b = sketch(full, 3, 3, filled);
  const r2 = await full.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", side: "inside" });
  assert.equal(r2.pixelsChanged, 8, "the cel edge counts as transparency's counterpart");
  assert.deepEqual(rows(b.sprite, b.cel), ["GGG", "GRG", "GGG"]);
});

test("outside outline of thickness 2 reaches two steps: a diamond with four neighbours, a square with eight", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 3, 3, [[1, 1, RED]]);
  const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", thickness: 2 });
  assert.equal(r.pixelsChanged, 12);
  assert.deepEqual(r.bounds, { x: -2, y: -2, width: 7, height: 7 });
  assert.deepEqual(rows(sprite, cel), [".......", "...G...", "..GGG..", ".GGRGG.", "..GGG..", "...G...", "......."]);

  const diag = createStudio();
  const d = sketch(diag, 3, 3, [[1, 1, RED]]);
  const r2 = await diag.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", thickness: 2, diagonals: true });
  assert.equal(r2.pixelsChanged, 24);
  assert.deepEqual(r2.bounds, { x: -2, y: -2, width: 7, height: 7 });
  assert.deepEqual(rows(d.sprite, d.cel), [
    ".......",
    ".GGGGG.",
    ".GGGGG.",
    ".GGRGG.",
    ".GGGGG.",
    ".GGGGG.",
    ".......",
  ]);
});

test("inside outline of thickness 2 recolours what lies within two steps of transparency or the cel edge", async () => {
  const studio = createStudio();
  const px: [number, number, number][] = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (x !== 4 || y !== 4) px.push([x, y, RED]);
  const { sprite, cel } = sketch(studio, 9, 9, px);
  const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", side: "inside", thickness: 2 });
  // The hole reaches two steps along rows and columns only, so the corners of the
  // 5x5 core stay red; the edge reaches two pixels in everywhere else.
  assert.equal(r.pixelsChanged, 68);
  assert.deepEqual(r.bounds, { x: 0, y: 0, width: 9, height: 9 });
  assert.deepEqual(rows(sprite, cel), [
    "GGGGGGGGG",
    "GGGGGGGGG",
    "GGRRGRRGG",
    "GGRGGGRGG",
    "GGGG.GGGG",
    "GGRGGGRGG",
    "GGRRGRRGG",
    "GGGGGGGGG",
    "GGGGGGGGG",
  ]);

  const diag = createStudio();
  const d = sketch(diag, 9, 9, px);
  const r2 = await diag.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", side: "inside", thickness: 2, diagonals: true });
  assert.equal(r2.pixelsChanged, 80);
  assert.ok(rows(d.sprite, d.cel).every((row, y) => row === (y === 4 ? "GGGG.GGGG" : "GGGGGGGGG")));
});

test("outline thickness 1 is the same as no thickness, on either side", async () => {
  for (const side of ["outside", "inside"]) {
    const results: unknown[] = [];
    for (const extra of [{}, { thickness: 1 }]) {
      const studio = createStudio();
      const { sprite, cel } = sketch(studio, 4, 4, [[1, 1, RED], [2, 1, RED], [1, 2, RED]]);
      const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", side, diagonals: true, ...extra });
      results.push([r, cel.x, cel.y, rows(sprite, cel)]);
    }
    assert.deepEqual(results[0], results[1], side);
  }
});

test("outline without a colour, or with an unknown side, is invalid_args", async () => {
  const studio = createStudio();
  sketch(studio, 3, 3, [[1, 1, RED]]);
  await rejectsWith(studio.call("transform.apply", { op: "outline" }), "invalid_args", /^Missing required argument 'color'\.$/);
  await rejectsWith(
    studio.call("transform.apply", { op: "outline", color: "#00ff00", side: "around" }),
    "invalid_args",
    /^transform op 'outline' side must be 'outside' or 'inside'\.$/,
  );
});

test("crop_to_content trims the canvas to the painted area, moves cels with it, and reports the pixels removed", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 8, 8, [[2, 3, RED], [4, 5, BLUE]]);
  const r = await studio.call<Reply>("transform.apply", { op: "crop_to_content" });
  assert.equal(r.pixelsChanged, 64 - 9);
  assert.deepEqual([sprite.width, sprite.height], [3, 3]);
  assert.deepEqual([cel.x, cel.y], [-2, -3]);
  assert.deepEqual(r.bounds, { x: -2, y: -3, width: 8, height: 8 });
  const flat = studio.composite(sprite, 1);
  assert.equal(flat.get(0, 0), RED);
  assert.equal(flat.get(2, 2), BLUE);
  assert.equal(flat.get(1, 1), 0);
});

test("crop_to_content unions the content of every frame and ignores hidden layers", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 8, 8, [[1, 1, RED]]);
  sprite.frames.push({ durationMs: 100 });
  const layer = sprite.layers[0]!;
  studio.ensureCel(sprite, layer, 2).image.set(5, 4, BLUE);
  const hidden = studio.addLayer(sprite, "hidden");
  hidden.visible = false;
  studio.ensureCel(sprite, hidden, 1).image.set(7, 7, GREEN);
  await studio.call("transform.apply", { op: "crop_to_content", layer: "Layer 1" });
  assert.deepEqual([sprite.width, sprite.height], [5, 4]);
});

test("crop_to_content on an empty sprite does nothing and says so", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 4, 4, []);
  const r = await studio.call<Reply>("transform.apply", { op: "crop_to_content" });
  assert.equal(r.pixelsChanged, 0);
  assert.deepEqual([sprite.width, sprite.height], [4, 4]);
});

test("crop_to_content needs no cel on the target layer, and leaves bounds out when there is none", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 6, 6, [[3, 3, RED]]);
  studio.addLayer(sprite, "empty");
  const r = await studio.call<Reply>("transform.apply", { op: "crop_to_content" });
  assert.equal(r.pixelsChanged, 35);
  assert.equal(r.bounds, undefined);
});

test("crop_to_content cuts the selection to the new canvas", async () => {
  const studio = createStudio();
  const { sprite } = sketch(studio, 8, 8, [[2, 3, RED], [4, 5, BLUE]]);
  const mask = new Uint8Array(64);
  mask[3 * 8 + 2] = 1;
  mask[0] = 1;
  sprite.selection = { mask, bounds: { x: 0, y: 0, width: 3, height: 4 } };
  await studio.call("transform.apply", { op: "crop_to_content" });
  assert.deepEqual(sprite.selection?.bounds, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(sprite.selection?.mask.length, 9);
  assert.equal(sprite.selection?.mask[0], 1);
});

test("transform on a layer or frame with no cel is invalid_args naming both", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  await rejectsWith(studio.call("transform.apply", { op: "flip" }), "invalid_args", /^No cel on 'Layer 1' frame 1\.$/);
  sprite.frames.push({ durationMs: 100 });
  await rejectsWith(studio.call("transform.apply", { op: "flip", frame: 2 }), "invalid_args", /frame 2\.$/);
});

test("an unknown op is unsupported_command and a missing op is invalid_args", async () => {
  const studio = createStudio();
  sketch(studio, 4, 4, [[0, 0, RED]]);
  await rejectsWith(studio.call("transform.apply", { op: "shear" }), "unsupported_command", /^transform op 'shear' is not supported\.$/);
  await rejectsWith(studio.call("transform.apply", {}), "invalid_args", /^Missing required argument 'op'\.$/);
});

test("transforms keep raw palette indices in an indexed sprite", async () => {
  const studio = createStudio();
  const palette = [rgba(0, 0, 0, 0), RED, BLUE, GREEN];
  const { sprite, cel } = sketch(studio, 2, 1, [], { colorMode: "indexed", palette });
  cel.image.set(0, 0, 1);
  cel.image.set(1, 0, 2);
  await studio.call("transform.apply", { op: "flip" });
  assert.deepEqual([...cel.image.pixels], [2, 1]);
  const r = await studio.call<Reply>("transform.apply", { op: "outline", color: "#00ff00", side: "inside" });
  // Neither pixel has a transparent neighbour inside a 2x1 cel, but both touch its edge.
  assert.equal(r.pixelsChanged, 2);
  assert.deepEqual([...cel.image.pixels], [3, 3]);
  assert.deepEqual(rows(sprite, cel), ["GG"]);
});

test("the transform tool passes outline thickness through over MCP", async () => {
  const { server, studio } = createServer();
  sketch(studio, 3, 3, [[1, 1, RED]]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name: "transform", arguments: { op: "outline", color: "#00ff00", thickness: 2 } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    sprite: "Sprite",
    op: "outline",
    pixelsChanged: 12,
    bounds: { x: -2, y: -2, width: 7, height: 7 },
  });
  await server.close();
});

test("the transform tool runs over MCP and reports pixelsChanged and bounds", async () => {
  const { server, studio } = createServer();
  const { sprite } = sketch(studio, 4, 2, [[0, 0, RED]]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name: "transform", arguments: { op: "flip" } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    sprite: "Sprite",
    op: "flip",
    pixelsChanged: 8,
    bounds: { x: 0, y: 0, width: 4, height: 2 },
  });
  assert.equal(studio.activeSprite()?.layers[0]!.cels.get(1)!.image.get(3, 0), RED);
  assert.equal(sprite.modified, true);
  await server.close();
});
