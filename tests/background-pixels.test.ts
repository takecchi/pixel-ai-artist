import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Image, createStudio, rgba } from "../dist/doc/index.js";
import { createServer } from "../dist/server.js";

type Reply = Record<string, any>;

const WHITE = rgba(255, 255, 255);
const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);

const img = (width: number, height: number, pixels: number[]) => Image.from(width, height, new Uint32Array(pixels));

/** A 2x1 indexed sprite, palette [white, red, green], transparent index 0; one layer holding [0, 1]. */
function indexed(background: boolean, studio = createStudio()) {
  const sprite = studio.addSprite({ width: 2, height: 1, colorMode: "indexed", palette: [WHITE, RED, GREEN] });
  sprite.transparentIndex = 0;
  const layer = sprite.layers[0]!;
  if (background) layer.background = true;
  studio.ensureCel(sprite, layer, 1).image = img(2, 1, [0, 1]);
  return { studio, sprite, layer };
}

const composite = (studio: ReturnType<typeof createStudio>, sprite: ReturnType<typeof indexed>["sprite"]) => [
  ...studio.composite(sprite, 1).pixels,
];

test("read_pixels composite:false and composite:true agree on a Background's transparent-index pixel, which reads as its palette colour", async () => {
  const { studio } = indexed(true);
  const flat = await studio.call<Reply>("pixels.read", { composite: false });
  const merged = await studio.call<Reply>("pixels.read", { composite: true });
  assert.deepEqual(flat.colors, ["#00000000", "#ffffff", "#ff0000"]);
  assert.deepEqual(flat.grid, [1, 2]);
  assert.deepEqual(merged, flat);
});

test("read_pixels composite:false still reads a non-Background layer's transparent index as clear", async () => {
  const { studio } = indexed(false);
  const flat = await studio.call<Reply>("pixels.read", { composite: false });
  assert.deepEqual(flat.grid, [0, 1]);
  assert.deepEqual(flat, await studio.call<Reply>("pixels.read", { composite: true }));
});

test("read_pixels composite:false reads clear outside a Background's cel, not its transparent index", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 3, height: 1, colorMode: "indexed", palette: [WHITE, RED, GREEN] });
  sprite.transparentIndex = 0;
  sprite.layers[0]!.background = true;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1, { x: 0, y: 0, width: 1, height: 1 });
  cel.image = img(1, 1, [0]);
  assert.deepEqual((await studio.call<Reply>("pixels.read", { composite: false })).grid, [1, 0, 0]);
});

test("look ascii shows a Background's transparent-index pixel as a colour, and a non-Background's as '.'", async () => {
  const { server, studio } = createServer();
  indexed(true, studio);
  indexed(false, studio);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const rows = async (sprite: string, layer: boolean) => {
    const r = await client.callTool({ name: "look", arguments: { op: "ascii", rulers: false, sprite, ...(layer ? { layer: "Layer 1" } : {}) } });
    assert.notEqual(r.isError, true);
    return (r.structuredContent as Reply).gridRows as string[];
  };
  const [bg, plain] = [studio.sprites()[0]!, studio.sprites()[1]!];
  const solid = await rows(`#${bg.id}`, true);
  assert.equal(solid[0]!.includes("."), false);
  assert.deepEqual(await rows(`#${bg.id}`, false), solid);
  assert.equal((await rows(`#${plain.id}`, true))[0]![0], ".");
});

test("recolor replaces a Background's transparent-index pixel by its palette colour, and leaves a non-Background's alone", async () => {
  const bg = indexed(true);
  const r = await bg.studio.call<Reply>("recolor.apply", { op: "replace", from: "#ffffff", to: "#00ff00", clampToPalette: false });
  assert.equal(r.pixelsChanged, 1);
  assert.deepEqual([...bg.layer.cels.get(1)!.image.pixels], [2, 1]);

  const plain = indexed(false);
  const p = await plain.studio.call<Reply>("recolor.apply", { op: "replace", from: "#ffffff", to: "#00ff00", clampToPalette: false });
  assert.equal(p.pixelsChanged, 0);
  assert.deepEqual([...plain.layer.cels.get(1)!.image.pixels], [0, 1]);
});

test("validate finds no stray pixel in a Background whose transparent-index pixel sits beside paint, and one on a plain layer", async () => {
  const strays = async (background: boolean) => {
    const { studio } = indexed(background);
    const r = await studio.call<Reply>("validate.run", { checks: ["strays"] });
    return r.findings.filter((f: Reply) => f.check === "strays");
  };
  assert.deepEqual(await strays(true), []);
  const plain = await strays(false);
  assert.deepEqual(plain.map((f: Reply) => f.count), [1]);
});

test("validate's mustNotOverlap counts a Background's transparent-index pixel as opaque", async () => {
  const { studio, sprite } = indexed(true);
  const top = studio.addLayer(sprite, "top");
  top.background = undefined;
  studio.ensureCel(sprite, top, 1).image = img(2, 1, [2, 0]);
  const r = await studio.call<Reply>("validate.run", { checks: [], expect: { mustNotOverlap: [["Layer 1", "top"]] } });
  assert.deepEqual(r.findings.map((f: Reply) => f.at), [{ x: 0, y: 0 }]);
});

test("palette stats and usage count a Background's transparent-index pixel under its palette colour", async () => {
  const bg = indexed(true);
  const stats = await bg.studio.call<Reply>("palette.stats", {});
  assert.deepEqual(stats.usage.map((u: Reply) => u.pixels), [1, 1, 0]);
  assert.deepEqual((await bg.studio.call<Reply>("palette.get", {})).usage, stats.usage);

  const plain = await indexed(false).studio.call<Reply>("palette.stats", {});
  assert.deepEqual(plain.usage.map((u: Reply) => u.pixels), [0, 1, 0]);
});

test("merging a layer down into a Background leaves the composite unchanged", async () => {
  const { studio, sprite } = indexed(true);
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 1).image = img(2, 1, [0, 2]);
  const before = composite(studio, sprite);
  assert.deepEqual(before, [WHITE, GREEN]);
  await studio.call<Reply>("layer.apply", { op: "merge", name: "top" });
  assert.deepEqual(composite(studio, sprite), before);
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [0, 2]);
});

test("merging a layer down into a Background keeps the colour where the upper layer is clear and the Background's pixel is its transparent index", async () => {
  const { studio, sprite } = indexed(true);
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 1).image = img(2, 1, [0, 0]);
  await studio.call<Reply>("layer.apply", { op: "merge", name: "top" });
  assert.deepEqual(composite(studio, sprite), [WHITE, RED]);
});

test("merging a faint layer down into a Background blends over the Background's palette colour, not over nothing", async () => {
  const { studio, sprite } = indexed(true);
  const top = studio.addLayer(sprite, "top");
  top.opacity = 64;
  studio.ensureCel(sprite, top, 1).image = img(2, 1, [1, 0]);
  await studio.call<Reply>("layer.apply", { op: "merge", name: "top" });
  assert.deepEqual(composite(studio, sprite), [WHITE, RED]);
});

test("merging a Background into the layer below reads its transparent-index pixel as colour", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1, colorMode: "indexed", palette: [WHITE, RED, GREEN] });
  sprite.transparentIndex = 0;
  const low = sprite.layers[0]!;
  studio.ensureCel(sprite, low, 1).image = img(2, 1, [0, 0]);
  const bg = studio.addLayer(sprite, "bg");
  bg.background = true;
  studio.ensureCel(sprite, bg, 1).image = img(2, 1, [0, 1]);
  const before = composite(studio, sprite);
  await studio.call<Reply>("layer.apply", { op: "merge", name: "bg" });
  assert.deepEqual([...low.cels.get(1)!.image.pixels], [0, 1]);
  assert.deepEqual(before, [WHITE, RED]);
});

test("duplicating a Background into an RGB sprite copies its transparent-index pixel as the palette colour", async () => {
  const { studio, sprite } = indexed(true);
  const target = studio.addSprite({ width: 2, height: 1 });
  studio.activate(sprite);
  await studio.call<Reply>("layer.apply", { op: "duplicate", name: "Layer 1", toSprite: `#${target.id}` });
  assert.deepEqual([...target.layers[1]!.cels.get(1)!.image.pixels], [WHITE, RED]);
});

test("duplicating a non-Background layer into an RGB sprite keeps its transparent-index pixel clear", async () => {
  const { studio, sprite } = indexed(false);
  const target = studio.addSprite({ width: 2, height: 1 });
  studio.activate(sprite);
  await studio.call<Reply>("layer.apply", { op: "duplicate", name: "Layer 1", toSprite: `#${target.id}` });
  assert.deepEqual([...target.layers[1]!.cels.get(1)!.image.pixels], [0, RED]);
});

test("changing an indexed sprite with a Background to rgb keeps the composite", async () => {
  const { studio, sprite } = indexed(true);
  const before = composite(studio, sprite);
  await studio.call<Reply>("sprite.manage", { op: "set_properties", colorMode: "rgb" });
  assert.deepEqual(before, [WHITE, RED]);
  assert.deepEqual(composite(studio, sprite), before);
});

test("changing an indexed sprite with a Background to grayscale keeps white white and red as its luma", async () => {
  const { studio, sprite } = indexed(true);
  await studio.call<Reply>("sprite.manage", { op: "set_properties", colorMode: "grayscale" });
  assert.deepEqual(composite(studio, sprite), [WHITE, rgba(76, 76, 76)]);
});

test("changing an indexed sprite without a Background to rgb leaves the transparent-index pixel clear", async () => {
  const { studio, sprite } = indexed(false);
  await studio.call<Reply>("sprite.manage", { op: "set_properties", colorMode: "rgb" });
  assert.deepEqual(composite(studio, sprite), [0, RED]);
});
