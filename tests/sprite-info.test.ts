import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";

type Info = Record<string, any>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

test("a fresh sprite reports its size and mode, one empty layer, one 100ms frame, and no unsaved changes", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 16, height: 8 });
  const info = await studio.call<Info>("sprite.info");
  assert.equal(info.width, 16);
  assert.equal(info.height, 8);
  assert.equal(info.colorMode, "rgb");
  assert.equal(info.frameCount, 1);
  assert.deepEqual(info.frames, [{ number: 1, durationMs: 100 }]);
  assert.deepEqual(info.layers.map((l: Info) => [l.name, l.cels]), [["Layer 1", []]]);
  assert.deepEqual(info.tags, []);
  assert.equal(info.modified, false);
});

test("the id and the display name sprite.info reports both resolve back to the same sprite", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  const byDefault = await studio.call<Info>("sprite.info");
  assert.equal(byDefault.id, sprite.id);
  assert.equal(byDefault.name, "Sprite");
  assert.equal((await studio.call<Info>("sprite.info", { sprite: `#${byDefault.id}` })).id, sprite.id);
  assert.equal((await studio.call<Info>("sprite.info", { sprite: byDefault.name })).id, sprite.id);
});

test("filename is absent until the sprite has one, and the display name is then its base name", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  assert.equal((await studio.call<Info>("sprite.info")).filename, undefined);
  sprite.filename = "/tmp/art/hero.png";
  const info = await studio.call<Info>("sprite.info");
  assert.equal(info.filename, "/tmp/art/hero.png");
  assert.equal(info.name, "hero.png");
});

test("layers are listed bottom to top with a 1-based index and the frames that hold a cel", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  sprite.frames.push({ durationMs: 80 }, { durationMs: 120 });
  const bottom = sprite.layers[0]!;
  const top = studio.addLayer(sprite, "ink");
  top.visible = false;
  top.editable = false;
  top.opacity = 128;
  studio.ensureCel(sprite, bottom, 3);
  studio.ensureCel(sprite, bottom, 1);
  const info = await studio.call<Info>("sprite.info");
  assert.deepEqual(info.layers, [
    { name: "Layer 1", index: 1, visible: true, editable: true, opacity: 255, cels: [1, 3] },
    { name: "ink", index: 2, visible: false, editable: false, opacity: 128, cels: [] },
  ]);
  assert.deepEqual(info.frames, [
    { number: 1, durationMs: 100 },
    { number: 2, durationMs: 80 },
    { number: 3, durationMs: 120 },
  ]);
  assert.equal(info.frameCount, 3);
});

test("the palette is listed as hex with alpha only where an entry is not opaque, and left out when includePalette is false", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 4, height: 4, palette: [rgba(0, 0, 0, 0), rgba(255, 0, 77), rgba(41, 173, 255, 128)] });
  assert.deepEqual((await studio.call<Info>("sprite.info")).palette, ["#00000000", "#ff004d", "#29adff80"]);
  assert.equal((await studio.call<Info>("sprite.info", { includePalette: false })).palette, undefined);
});

test("transparentIndex is reported for an indexed sprite and absent otherwise", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 4, height: 4 });
  assert.equal((await studio.call<Info>("sprite.info")).transparentIndex, undefined);
  const indexed = studio.addSprite({ width: 4, height: 4, colorMode: "indexed", palette: [rgba(0, 0, 0), rgba(255, 255, 255)] });
  indexed.transparentIndex = 1;
  const info = await studio.call<Info>("sprite.info");
  assert.equal(info.colorMode, "indexed");
  assert.equal(info.transparentIndex, 1);
});

test("tags report their name, frame range, direction and repeat count", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  sprite.frames.push({ durationMs: 100 }, { durationMs: 100 });
  sprite.tags.push({ name: "walk", from: 1, to: 3, direction: "pingpong", repeats: 2, color: rgba(0, 0, 0) });
  assert.deepEqual((await studio.call<Info>("sprite.info")).tags, [
    { name: "walk", from: 1, to: 3, direction: "pingpong", repeats: 2 },
  ]);
});

test("the selection's bounds appear only while something is selected", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  assert.equal((await studio.call<Info>("sprite.info")).selection, undefined);
  const mask = new Uint8Array(16);
  mask[1 * 4 + 2] = 1;
  sprite.selection = { mask, bounds: { x: 2, y: 1, width: 1, height: 1 } };
  assert.deepEqual((await studio.call<Info>("sprite.info")).selection, { x: 2, y: 1, width: 1, height: 1 });
});

test("activeLayer and activeFrame name the layer and frame a tool uses when not told one", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 4, height: 4 });
  sprite.frames.push({ durationMs: 100 });
  studio.addLayer(sprite, "top");
  sprite.activeLayerId = sprite.layers[0]!.id;
  sprite.activeFrame = 2;
  const info = await studio.call<Info>("sprite.info");
  assert.equal(info.activeLayer, "Layer 1");
  assert.equal(info.activeFrame, 2);
});

test("sprite.info reads a sprite that is not the active one when named", async () => {
  const studio = createStudio();
  const first = studio.addSprite({ width: 3, height: 5 });
  studio.addSprite({ width: 9, height: 9 });
  const info = await studio.call<Info>("sprite.info", { sprite: `#${first.id}` });
  assert.deepEqual([info.width, info.height], [3, 5]);
});

test("with no sprite open, sprite.info answers no_active_sprite", async () => {
  await rejectsWith(createStudio().call("sprite.info"), "no_active_sprite");
});

test("sprite.info does not change the document", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 2 });
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 2, new Uint32Array([rgba(1, 2, 3), 0, 0, 0]));
  sprite.modified = false;
  await studio.call("sprite.info");
  assert.equal(sprite.modified, false);
  assert.equal(cel.image.get(0, 0), rgba(1, 2, 3));
});
