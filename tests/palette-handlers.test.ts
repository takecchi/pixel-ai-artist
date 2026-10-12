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

function setup(palette = [rgba(0, 0, 0), RED]) {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1, palette });
  sprite.modified = false;
  return { studio, sprite };
}

const call = (studio: ReturnType<typeof createStudio>, cmd: string, args: Record<string, unknown> = {}) => studio.call<Reply>(cmd, args);

test("palette.get lists the entries as hex, alpha only where not opaque, with the size", async () => {
  const { studio } = setup([rgba(0, 0, 0, 0), RED, rgba(41, 173, 255, 128)]);
  assert.deepEqual(await call(studio, "palette.get"), {
    sprite: "Sprite",
    colors: ["#00000000", "#ff004d", "#29adff80"],
    size: 3,
  });
});

test("palette.set overwrites from startIndex and grows the palette when the colours run past its end", async () => {
  const { studio, sprite } = setup();
  assert.deepEqual((await call(studio, "palette.set", { colors: ["#29adff"], startIndex: 1 })).colors, ["#000000", "#29adff"]);
  const grown = await call(studio, "palette.set", { colors: ["#ffffff", "#ff004d"], startIndex: 1 });
  assert.deepEqual([grown.colors, grown.size], [["#000000", "#ffffff", "#ff004d"], 3]);
  assert.equal(sprite.modified, true);
});

test("a startIndex past the end fills the gap with black entries", async () => {
  const { studio } = setup();
  assert.deepEqual((await call(studio, "palette.set", { colors: ["#ffffff"], startIndex: 4 })).colors, [
    "#000000", "#ff004d", "#000000", "#000000", "#ffffff",
  ]);
});

test("palette.set replace swaps the whole palette and append adds to its end", async () => {
  const { studio } = setup();
  assert.deepEqual((await call(studio, "palette.set", { colors: ["#29adff"], append: true })).colors, ["#000000", "#ff004d", "#29adff"]);
  assert.deepEqual((await call(studio, "palette.set", { colors: ["#ffffff"], replace: true })).colors, ["#ffffff"]);
});

test("palette.set without remapArt leaves rgb art as it was", async () => {
  const { studio, sprite } = setup();
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 1, new Uint32Array([RED, BLUE]));
  await call(studio, "palette.set", { colors: ["#ffffff"], replace: true });
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [RED, BLUE]);
});

test("remapArt repaints every rgb cel with each colour's nearest new entry, keeping alpha and clear pixels", async () => {
  const { studio, sprite } = setup();
  const top = studio.addLayer(sprite, "hidden");
  top.visible = false;
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(2, 1, new Uint32Array([rgba(250, 10, 70), rgba(30, 160, 250, 128)]));
  studio.ensureCel(sprite, top, 1).image = Image.from(2, 1, new Uint32Array([0, rgba(240, 5, 80)]));
  await call(studio, "palette.set", { colors: ["#ff004d", "#29adff"], replace: true, remapArt: true });
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [RED, rgba(41, 173, 255, 128)]);
  assert.deepEqual([...top.cels.get(1)!.image.pixels], [0, RED], "hidden layers are repainted too");
});

test("remapArt on a grayscale sprite keeps each pixel's alpha", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 1, height: 1, colorMode: "grayscale", palette: [] });
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image.set(0, 0, rgba(100, 100, 100, 90));
  await call(studio, "palette.set", { colors: ["#808080", "#000000"], replace: true, remapArt: true });
  assert.equal(sprite.layers[0]!.cels.get(1)!.image.get(0, 0), rgba(128, 128, 128, 90));
});

test("remapArt on an indexed sprite is refused, since its pixels already follow the palette", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 1, height: 1, colorMode: "indexed", palette: [rgba(0, 0, 0), RED] });
  await rejectsWith(call(studio, "palette.set", { colors: ["#ffffff"], remapArt: true }), "invalid_args", /indexed/);
  assert.equal(sprite.palette.length, 2);
});

test("palette.set needs colours and refuses a malformed one without changing the palette", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(call(studio, "palette.set", {}), "invalid_args", /'colors'/);
  await rejectsWith(call(studio, "palette.set", { colors: ["#ffffff", "blue"], replace: true }), "invalid_args", /#rrggbb/);
  await rejectsWith(call(studio, "palette.set", { colors: ["#ffffff"], startIndex: -1 }), "invalid_args", /startIndex/);
  assert.deepEqual(sprite.palette, [rgba(0, 0, 0), RED]);
  assert.equal(sprite.modified, false);
});

test("palette.stats answers what paletteStats computes for the sprite", async () => {
  const { studio, sprite } = setup();
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(2, 1, new Uint32Array([RED, BLUE]));
  assert.deepEqual(await call(studio, "palette.stats"), {
    sprite: "Sprite",
    colors: ["#000000", "#ff004d"],
    usage: [
      { index: 0, hex: "#000000", pixels: 0 },
      { index: 1, hex: "#ff004d", pixels: 1 },
    ],
    offPalette: [{ hex: "#29adff", pixels: 1 }],
  });
});

test("palette.extract keeps every colour when there are no more than maxColors, most used first", async () => {
  const { studio, sprite } = setup();
  sprite.width = 3;
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(3, 1, new Uint32Array([BLUE, RED, RED]));
  const reply = await call(studio, "palette.extract", { maxColors: 4 });
  assert.deepEqual(reply, { sprite: "Sprite", colors: ["#ff004d", "#29adff"] });
  assert.equal(sprite.modified, true);
});

test("palette.extract reduces to maxColors by merging the closest colours, weighted by use", async () => {
  const { studio, sprite } = setup();
  sprite.width = 4;
  const pixels = [rgba(250, 0, 0), rgba(250, 0, 0), rgba(254, 0, 0), rgba(0, 0, 250)];
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(4, 1, new Uint32Array(pixels));
  assert.deepEqual((await call(studio, "palette.extract", { maxColors: 2 })).colors, ["#fb0000", "#0000fa"]);
});

test("palette.extract ignores alpha and clear pixels, and leaves the art alone", async () => {
  const { studio, sprite } = setup();
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 1, new Uint32Array([rgba(255, 0, 77, 40), 0]));
  assert.deepEqual((await call(studio, "palette.extract")).colors, ["#ff004d"]);
  assert.equal(cel.image.get(0, 0), rgba(255, 0, 77, 40));
});

test("palette.extract refuses a non-rgb sprite, a maxColors outside 2–256 and a sprite with nothing painted", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(call(studio, "palette.extract"), "invalid_args", /no painted pixels/);
  await rejectsWith(call(studio, "palette.extract", { maxColors: 1 }), "invalid_args", /maxColors/);
  assert.deepEqual(sprite.palette, [rgba(0, 0, 0), RED]);
  studio.addSprite({ width: 1, height: 1, colorMode: "indexed", palette: [RED] });
  await rejectsWith(call(studio, "palette.extract"), "invalid_args", /only works on RGB/);
});
