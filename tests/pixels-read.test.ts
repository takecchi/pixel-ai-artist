import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";

type Reply = Record<string, any>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

const RED = rgba(255, 0, 77);
const BLUE = rgba(41, 173, 255);

/** A 3x2 rgb sprite: row 0 = red, clear, blue; row 1 = blue, red, clear. */
function setup() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 3, height: 2 });
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(3, 2, new Uint32Array([RED, 0, BLUE, BLUE, RED, 0]));
  return { studio, sprite };
}

test("pixels come back as distinct colours plus a row-major grid, with 0 always meaning transparent", async () => {
  const { studio } = setup();
  const read = await studio.call<Reply>("pixels.read");
  assert.deepEqual(read, {
    sprite: "Sprite",
    x: 0,
    y: 0,
    width: 3,
    height: 2,
    colors: ["#00000000", "#ff004d", "#29adff"],
    grid: [1, 0, 2, 2, 1, 0],
  });
});

test("a region reads only that rectangle, and colours are numbered in the order the region meets them", async () => {
  const { studio } = setup();
  const read = await studio.call<Reply>("pixels.read", { region: { x: 1, y: 0, width: 2, height: 2 } });
  assert.deepEqual([read.x, read.y, read.width, read.height], [1, 0, 2, 2]);
  assert.deepEqual(read.colors, ["#00000000", "#29adff", "#ff004d"]);
  assert.deepEqual(read.grid, [0, 1, 2, 0]);
});

test("a region running past the canvas is clamped to it; one left empty is invalid_args", async () => {
  const { studio } = setup();
  const read = await studio.call<Reply>("pixels.read", { region: { x: -2, y: 1, width: 99, height: 99 } });
  assert.deepEqual([read.x, read.y, read.width, read.height], [0, 1, 3, 1]);
  await rejectsWith(studio.call("pixels.read", { region: { x: 3, y: 0 } }), "invalid_args", /empty after clamping to the 3x2 canvas/);
});

test("the default read is the composite of visible layers at their opacity", async () => {
  const { studio, sprite } = setup();
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 1).image.set(1, 0, rgba(0, 255, 0));
  const hidden = studio.addLayer(sprite, "hidden");
  hidden.visible = false;
  studio.ensureCel(sprite, hidden, 1).image.set(2, 1, rgba(9, 9, 9));
  const read = await studio.call<Reply>("pixels.read");
  assert.deepEqual(read.colors, ["#00000000", "#ff004d", "#00ff00", "#29adff"]);
  assert.deepEqual(read.grid, [1, 2, 3, 3, 1, 0]);
});

test("a partly transparent pixel in an rgb sprite reads with its alpha", async () => {
  const { studio, sprite } = setup();
  sprite.layers[0]!.opacity = 128;
  const read = await studio.call<Reply>("pixels.read", { region: { x: 0, y: 0, width: 1, height: 1 } });
  assert.deepEqual(read.colors, ["#00000000", "#ff004d80"]);
});

test("composite false reads one layer's cel as it is, ignoring layer and cel opacity and other layers", async () => {
  const { studio, sprite } = setup();
  const bottom = sprite.layers[0]!;
  bottom.opacity = 10;
  bottom.cels.get(1)!.opacity = 10;
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 1).image.set(1, 0, rgba(0, 255, 0));
  const read = await studio.call<Reply>("pixels.read", { layer: "Layer 1", composite: false });
  assert.deepEqual(read.colors, ["#00000000", "#ff004d", "#29adff"]);
  assert.deepEqual(read.grid, [1, 0, 2, 2, 1, 0]);
});

test("composite false places a cel at its position and leaves the rest of the canvas transparent", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 1 });
  const layer = sprite.layers[0]!;
  layer.cels.set(1, { x: 2, y: 0, image: Image.from(1, 1, new Uint32Array([RED])), opacity: 255 });
  const read = await studio.call<Reply>("pixels.read", { composite: false });
  assert.deepEqual(read.grid, [0, 0, 1, 0]);
});

test("a layer with no cel on the frame reads as fully transparent", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "empty");
  const read = await studio.call<Reply>("pixels.read", { layer: "empty", composite: false });
  assert.deepEqual(read.colors, ["#00000000"]);
  assert.deepEqual(read.grid, [0, 0, 0, 0, 0, 0]);
});

test("frame picks which frame is read", async () => {
  const { studio, sprite } = setup();
  sprite.frames.push({ durationMs: 100 });
  studio.ensureCel(sprite, sprite.layers[0]!, 2).image.set(0, 0, BLUE);
  const read = await studio.call<Reply>("pixels.read", { frame: 2 });
  assert.deepEqual(read.grid, [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(read.colors, ["#00000000", "#29adff"]);
  await rejectsWith(studio.call("pixels.read", { frame: 3 }), "invalid_args", /out of range/);
});

test("an indexed sprite reads its palette colours as opaque #rrggbb, and the transparent index as transparent", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({
    width: 3,
    height: 1,
    colorMode: "indexed",
    palette: [rgba(0, 0, 0), rgba(255, 0, 77, 100), rgba(41, 173, 255)],
  });
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image.pixels.set([0, 1, 2]);
  for (const composite of [true, false]) {
    const read = await studio.call<Reply>("pixels.read", { composite });
    assert.deepEqual(read.colors, ["#00000000", "#ff004d", "#29adff"], `composite ${composite}`);
    assert.deepEqual(read.grid, [0, 1, 2], `composite ${composite}`);
  }
});

test("a grayscale sprite reads without alpha", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 1, height: 1, colorMode: "grayscale" });
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image.set(0, 0, rgba(80, 80, 80, 128));
  assert.deepEqual((await studio.call<Reply>("pixels.read", { composite: false })).colors, ["#00000000", "#505050"]);
});

test("an unknown layer name is invalid_args even for a composite read, as in the extension", async () => {
  const { studio } = setup();
  await rejectsWith(studio.call("pixels.read", { layer: "nope" }), "invalid_args", /No layer named 'nope'/);
});

test("reading does not change the document", async () => {
  const { studio, sprite } = setup();
  sprite.modified = false;
  await studio.call("pixels.read");
  await studio.call("pixels.read", { composite: false });
  assert.equal(sprite.modified, false);
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [RED, 0, BLUE, BLUE, RED, 0]);
});
