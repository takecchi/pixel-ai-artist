import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Image, ToolError, createStudio, pixelToHex, rgba } from "../dist/doc/index.js";

type Reply = Record<string, any>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

const manage = (studio: ReturnType<typeof createStudio>, args: Record<string, unknown>) =>
  studio.call<Reply>("sprite.manage", args);

test("new makes the sprite active and answers an id that resolves back to it", async () => {
  const studio = createStudio();
  const made = await manage(studio, { op: "new", width: 12, height: 7 });
  assert.deepEqual(made, { sprite: "Sprite", id: made.id, width: 12, height: 7 });
  const info = await studio.call<Reply>("sprite.info", { sprite: `#${made.id}` });
  assert.deepEqual([info.id, info.width, info.height, info.colorMode], [made.id, 12, 7, "rgb"]);
  assert.equal((await studio.call<Reply>("session.site")).sprite.id, made.id);
});

test("a new indexed sprite starts on the DawnBringer 32 palette with index 0 transparent", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 4, height: 4, colorMode: "indexed" });
  const info = await studio.call<Reply>("sprite.info");
  assert.equal(info.colorMode, "indexed");
  assert.equal(info.transparentIndex, 0);
  assert.equal(info.palette.length, 32);
  assert.deepEqual(info.palette.slice(0, 3), ["#000000", "#222034", "#45283c"]);
});

test("new refuses a missing or non-positive size and an unknown colour mode", async () => {
  const studio = createStudio();
  await rejectsWith(manage(studio, { op: "new", height: 4 }), "invalid_args", /'width'/);
  await rejectsWith(manage(studio, { op: "new", width: 0, height: 4 }), "invalid_args", /width/);
  await rejectsWith(manage(studio, { op: "new", width: 4, height: 2.5 }), "invalid_args", /height/);
  await rejectsWith(manage(studio, { op: "new", width: 4, height: 4, colorMode: "cmyk" }), "invalid_args", /colorMode/);
  assert.equal(studio.sprites().length, 0);
});

test("list reports every open sprite, which one is active and which have unsaved changes", async () => {
  const studio = createStudio();
  const a = await manage(studio, { op: "new", width: 2, height: 2 });
  const b = await manage(studio, { op: "new", width: 3, height: 3 });
  studio.resolveSprite(`#${a.id}`).modified = true;
  const { sprites } = await manage(studio, { op: "list" });
  assert.deepEqual(
    sprites.map((s: Reply) => [s.id, s.width, s.active, s.modified]),
    [
      [a.id, 2, false, true],
      [b.id, 3, true, false],
    ],
  );
});

test("activate switches which sprite tools use when not told one", async () => {
  const studio = createStudio();
  const a = await manage(studio, { op: "new", width: 2, height: 2 });
  await manage(studio, { op: "new", width: 3, height: 3 });
  assert.deepEqual(await manage(studio, { op: "activate", sprite: `#${a.id}` }), { sprite: "Sprite", id: a.id });
  assert.equal((await studio.call<Reply>("sprite.info")).id, a.id);
});

test("close removes the sprite, and the id it answered no longer resolves", async () => {
  const studio = createStudio();
  const a = await manage(studio, { op: "new", width: 2, height: 2 });
  const b = await manage(studio, { op: "new", width: 3, height: 3 });
  assert.deepEqual(await manage(studio, { op: "close", sprite: `#${b.id}` }), { sprite: "Sprite", id: b.id });
  await rejectsWith(studio.call("sprite.info", { sprite: `#${b.id}` }), "invalid_args", /No open sprite/);
  assert.equal((await studio.call<Reply>("sprite.info")).id, a.id);
});

test("growing the canvas around the centre moves the art to stay centred", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 2, new Uint32Array([rgba(255, 0, 0), 0, 0, rgba(0, 0, 255)]));
  assert.deepEqual(await manage(studio, { op: "resize_canvas", width: 6, height: 4 }), { sprite: "Sprite", width: 6, height: 4 });
  const after = sprite.layers[0]!.cels.get(1)!;
  assert.deepEqual([after.x, after.y], [2, 1]);
  assert.equal(after.image.get(0, 0), rgba(255, 0, 0));
  assert.equal(sprite.modified, true);
});

test("shrinking the canvas toward an anchor keeps that side and trims what falls off", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 4, height: 1 });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  const [a, b, c, d] = [rgba(1, 0, 0), rgba(2, 0, 0), rgba(3, 0, 0), rgba(4, 0, 0)];
  cel.image = Image.from(4, 1, new Uint32Array([a, b, c, d]));
  await manage(studio, { op: "resize_canvas", width: 2, anchor: "right" });
  const after = sprite.layers[0]!.cels.get(1)!;
  assert.deepEqual([sprite.width, sprite.height, after.x, after.y], [2, 1, 0, 0]);
  assert.deepEqual([...after.image.pixels], [c, d]);
});

test("an odd shrink around the centre rounds the offset down, as Aseprite does", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 5, height: 1 });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(5, 1, new Uint32Array([1, 2, 3, 4, 5].map((r) => rgba(r, 0, 0))));
  await manage(studio, { op: "resize_canvas", width: 2 });
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [rgba(3, 0, 0), rgba(4, 0, 0)]);
});

test("a cel left entirely off the resized canvas is removed", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 8, height: 8 });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 2, new Uint32Array(4).fill(rgba(9, 9, 9)));
  cel.x = 6;
  cel.y = 6;
  await manage(studio, { op: "resize_canvas", width: 4, height: 4, anchor: "top_left" });
  assert.equal(sprite.layers[0]!.cels.has(1), false);
});

test("the selection moves with the art when the canvas is resized", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  const sprite = studio.activeSprite()!;
  const mask = new Uint8Array(4);
  mask[0] = 1;
  sprite.selection = { mask, bounds: { x: 0, y: 0, width: 1, height: 1 } };
  await manage(studio, { op: "resize_canvas", width: 4, height: 4, anchor: "bottom_right" });
  assert.deepEqual((await studio.call<Reply>("sprite.info")).selection, { x: 2, y: 2, width: 1, height: 1 });
});

test("resize_canvas refuses a non-positive size", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  await rejectsWith(manage(studio, { op: "resize_canvas", width: -1 }), "invalid_args", /width/);
});

test("set_properties converts the art to grayscale by luma, keeping alpha", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 1 });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 1, new Uint32Array([rgba(255, 0, 0), rgba(0, 0, 255, 128)]));
  await manage(studio, { op: "set_properties", colorMode: "grayscale" });
  assert.equal(sprite.colorMode, "grayscale");
  assert.deepEqual([...cel.image.pixels].map((v) => [pixelToHex(sprite, v), v & 255]), [
    ["#4c4c4c", 255],
    ["#1d1d1d", 128],
  ]);
});

test("set_properties to indexed maps each colour to its nearest palette entry and clear pixels to the transparent index", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 3, height: 1 });
  const sprite = studio.activeSprite()!;
  sprite.palette = [rgba(0, 0, 0), rgba(250, 10, 10), rgba(10, 10, 250)];
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(3, 1, new Uint32Array([rgba(255, 0, 0), 0, rgba(0, 0, 0)]));
  await manage(studio, { op: "set_properties", colorMode: "indexed" });
  // Black is entry 0, the transparent index, so opaque black lands on the nearest other entry.
  assert.deepEqual([...cel.image.pixels], [1, 0, 1]);
  assert.equal((await studio.call<Reply>("sprite.info")).transparentIndex, 0);
});

test("set_properties back from indexed paints each pixel its palette colour", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 1, colorMode: "indexed" });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(2, 1, new Uint32Array([0, 1]));
  await manage(studio, { op: "set_properties", colorMode: "rgb" });
  assert.deepEqual([...cel.image.pixels], [0, rgba(0x22, 0x20, 0x34)]);
});

test("converting to indexed without a palette is refused and leaves the art alone", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 1, height: 1 });
  const sprite = studio.activeSprite()!;
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  cel.image = Image.from(1, 1, new Uint32Array([rgba(5, 6, 7)]));
  await rejectsWith(manage(studio, { op: "set_properties", colorMode: "indexed" }), "invalid_args", /palette/);
  assert.equal(sprite.colorMode, "rgb");
  assert.equal(cel.image.get(0, 0), rgba(5, 6, 7));
});

test("set_properties records a pixel aspect and refuses one that is not W:H", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  const sprite = studio.activeSprite()!;
  await manage(studio, { op: "set_properties", pixelAspect: "2:1" });
  assert.deepEqual(sprite.pixelRatio, { w: 2, h: 1 });
  await rejectsWith(manage(studio, { op: "set_properties", pixelAspect: "wide" }), "invalid_args", /pixelAspect/);
  assert.deepEqual(sprite.pixelRatio, { w: 2, h: 1 });
});

test("open, save and save_as answer unsupported_command until file I/O lands, and touch nothing", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  for (const op of ["open", "save", "save_as"]) {
    await rejectsWith(manage(studio, { op, path: "/tmp/never-written.png" }), "unsupported_command", new RegExp(op));
  }
  assert.equal(studio.sprites().length, 1);
  assert.equal(studio.activeSprite()!.filename, null);
});

test("slice ops answer unsupported_command, because slices are not ported", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  for (const op of ["slice_create", "slice_update", "slice_delete"]) {
    await rejectsWith(manage(studio, { op, name: "s", bounds: { x: 0, y: 0, width: 1, height: 1 } }), "unsupported_command", /[Ss]lice/);
  }
});

test("a missing op is invalid_args and an unknown one is unsupported_command", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 2 });
  await rejectsWith(manage(studio, {}), "invalid_args", /'op'/);
  await rejectsWith(manage(studio, { op: "explode" }), "unsupported_command", /explode/);
});
