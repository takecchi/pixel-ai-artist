import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  Studio,
  ToolError,
  createStudio,
  hexToRgba,
  pixelToHex,
  rgbaToHex,
  rgbaToPixel,
  snapToPalette,
} from "../dist/doc/index.js";

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

function throwsWith(fn: () => unknown, code: string, message?: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

test("a command with no handler answers unsupported_command naming it, unknown names included", async () => {
  const studio = createStudio();
  await rejectsWith(studio.call("export.run"), "unsupported_command", /'export\.run'/);
  await rejectsWith(studio.call("lua.run"), "unsupported_command", /'lua\.run'/);
});

test("a reply missing a field the caller expects is an internal_error; null is an answer", async () => {
  const studio = new Studio({
    "sprite.info": () => ({ width: 8, height: undefined, palette: null }),
  });
  await rejectsWith(studio.call("sprite.info", {}, { expect: ["width", "height"] }), "internal_error", /height/);
  assert.deepEqual(await studio.call("sprite.info", {}, { expect: ["width", "palette"] }), {
    width: 8,
    height: undefined,
    palette: null,
  });
});

test("a handler that throws something other than a ToolError surfaces as internal_error", async () => {
  const studio = new Studio({
    "draw.batch": () => {
      throw new TypeError("boom");
    },
  });
  await rejectsWith(studio.call("draw.batch"), "internal_error", /draw\.batch.*boom/);
});

test("arguments the caller left undefined do not reach the handler", async () => {
  let seen: Record<string, unknown> = {};
  const studio = new Studio({
    "pixels.read": (_s, args) => {
      seen = args;
      return {};
    },
  });
  await studio.call("pixels.read", { sprite: undefined, frame: 2 });
  assert.deepEqual(Object.keys(seen), ["frame"]);
});

test("session.site with nothing open reports no sprite and zero open sprites", async () => {
  const site = await createStudio().call<Record<string, unknown>>("session.site");
  assert.deepEqual(JSON.parse(JSON.stringify(site)), { openSprites: 0 });
});

test("a new sprite has one empty layer and one frame, is unmodified, and becomes the site", async () => {
  const studio = createStudio();
  const s = studio.addSprite({ width: 16, height: 8 });
  assert.equal(s.layers.length, 1);
  assert.equal(s.layers[0]!.cels.size, 0);
  assert.equal(s.frames.length, 1);
  assert.equal(s.modified, false);
  const site = await studio.call<Record<string, unknown>>("session.site");
  assert.deepEqual(JSON.parse(JSON.stringify(site)), {
    sprite: { id: s.id, name: "Sprite", width: 16, height: 8, colorMode: "rgb", frames: 1, layers: 1 },
    layer: "Layer 1",
    frame: 1,
    openSprites: 1,
  });
});

test("a sprite is found by '#id', bare id, full filename or file name; a shared name is refused with the ids", () => {
  const studio = createStudio();
  const a = studio.addSprite({ width: 4, height: 4 });
  const b = studio.addSprite({ width: 4, height: 4 });
  const c = studio.addSprite({ width: 4, height: 4, filename: "/art/knight.png" });
  assert.equal(studio.resolveSprite(`#${a.id}`), a);
  assert.equal(studio.resolveSprite(String(b.id)), b);
  assert.equal(studio.resolveSprite("/art/knight.png"), c);
  assert.equal(studio.resolveSprite("knight.png"), c);
  assert.equal(studio.resolveSprite(undefined), c, "omitted means the active sprite");
  throwsWith(() => studio.resolveSprite("Sprite"), "invalid_args", new RegExp(`#${a.id}, #${b.id}`));
  throwsWith(() => studio.resolveSprite("missing.png"), "invalid_args", /No open sprite matches 'missing\.png'/);
});

test("with no sprite open, a command that needs one answers no_active_sprite", () => {
  throwsWith(() => createStudio().resolveSprite(undefined), "no_active_sprite");
});

test("an unknown layer, a layer name two layers share, and an out-of-range frame are invalid_args", () => {
  const studio = createStudio();
  const s = studio.addSprite({ width: 4, height: 4 });
  studio.addLayer(s, "Ink");
  studio.addLayer(s, "Ink");
  throwsWith(() => studio.resolveLayer(s, "Paint"), "invalid_args", /No layer named 'Paint'/);
  throwsWith(() => studio.resolveLayer(s, "Ink"), "invalid_args", /ambiguous/);
  throwsWith(() => studio.resolveFrame(s, 2), "invalid_args", /out of range \(1\.\.1\)/);
  assert.equal(studio.resolveFrame(s, undefined), 1);
});

test("an omitted layer is the most recently added one", () => {
  const studio = createStudio();
  const s = studio.addSprite({ width: 4, height: 4 });
  const top = studio.addLayer(s, "Top");
  assert.equal(studio.resolveLayer(s), top);
});

test("a new cel covers the canvas; growing one keeps its pixels in place and stops at the canvas edge", () => {
  const studio = createStudio();
  const s = studio.addSprite({ width: 8, height: 8 });
  const layer = studio.resolveLayer(s);
  const cel = studio.ensureCel(s, layer, 1);
  assert.deepEqual([cel.x, cel.y, cel.image.width, cel.image.height], [0, 0, 8, 8]);

  cel.x = 2;
  cel.y = 2;
  cel.image = studio.newImage(s, 2, 2);
  cel.image.set(0, 0, hexToRgba("#ff0000"));
  studio.ensureCel(s, layer, 1, { x: 6, y: 6, width: 10, height: 10 });
  assert.deepEqual([cel.x, cel.y, cel.image.width, cel.image.height], [2, 2, 6, 6]);
  assert.equal(rgbaToHex(cel.image.get(0, 0)), "#ff0000");
});

test("the composite stacks visible layers bottom to top at layer × cel opacity", () => {
  const studio = createStudio();
  const s = studio.addSprite({ width: 1, height: 1 });
  const bottom = studio.resolveLayer(s);
  studio.ensureCel(s, bottom, 1).image.set(0, 0, hexToRgba("#0000ff"));
  const top = studio.addLayer(s, "Top");
  const cel = studio.ensureCel(s, top, 1);
  cel.image.set(0, 0, hexToRgba("#ff0000"));

  assert.equal(rgbaToHex(studio.composite(s, 1).get(0, 0)), "#ff0000");
  top.opacity = 255;
  cel.opacity = 0;
  assert.equal(rgbaToHex(studio.composite(s, 1).get(0, 0)), "#0000ff");
  cel.opacity = 255;
  top.visible = false;
  assert.equal(rgbaToHex(studio.composite(s, 1).get(0, 0)), "#0000ff");
  assert.equal(rgbaToHex(studio.composite(s, 1, { includeHidden: true }).get(0, 0)), "#ff0000");
  assert.equal(rgbaToHex(studio.composite(s, 1, { layers: [bottom], includeHidden: true }).get(0, 0)), "#0000ff");
});

test("an indexed sprite holds palette indices: editing the palette recolours the pixels, the transparent index shows nothing", () => {
  const studio = createStudio();
  const s = studio.addSprite({
    width: 2,
    height: 1,
    colorMode: "indexed",
    palette: [hexToRgba("#00000000"), hexToRgba("#102030"), hexToRgba("#f0f0f0")],
  });
  const cel = studio.ensureCel(s, studio.resolveLayer(s), 1);
  cel.image.set(0, 0, rgbaToPixel(s, hexToRgba("#112233")));
  assert.equal(cel.image.get(0, 0), 1, "the RGB-nearest entry");
  assert.equal(pixelToHex(s, cel.image.get(1, 0)), null);

  s.palette[1] = hexToRgba("#abcdef80");
  assert.equal(pixelToHex(s, cel.image.get(0, 0)), "#abcdef", "indexed pixels are opaque whatever the entry's alpha");
  assert.equal(rgbaToHex(studio.composite(s, 1).get(0, 0)), "#abcdef");
});

test("a grayscale pixel keeps luma and alpha, and reads back without its alpha", () => {
  const studio = createStudio();
  const s = studio.addSprite({ width: 1, height: 1, colorMode: "grayscale" });
  const value = rgbaToPixel(s, hexToRgba("#ff000080"));
  assert.equal(pixelToHex(s, value), "#4c4c4c");
});

test("hex colours show alpha only when it is not opaque; a malformed colour is invalid_args", () => {
  assert.equal(rgbaToHex(hexToRgba("#A1B2C3")), "#a1b2c3");
  assert.equal(rgbaToHex(hexToRgba("a1b2c380")), "#a1b2c380");
  assert.equal(rgbaToHex(hexToRgba("#a1b2c380"), false), "#a1b2c3");
  throwsWith(() => hexToRgba("#abc"), "invalid_args", /must be #rrggbb or #rrggbbaa/);
});

test("snapping to the palette is perceptual, keeps the colour's alpha and skips clear entries", () => {
  const studio = createStudio();
  const s = studio.addSprite({
    width: 1,
    height: 1,
    palette: [hexToRgba("#00000000"), hexToRgba("#0000ff"), hexToRgba("#00ff00")],
  });
  const { color } = snapToPalette(s, hexToRgba("#0000c880"));
  assert.equal(rgbaToHex(color), "#0000ff80");
  const empty = studio.addSprite({ width: 1, height: 1 });
  assert.deepEqual(snapToPalette(empty, hexToRgba("#123456")), { color: hexToRgba("#123456"), distance: 0 });
});
