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

function setup() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1 });
  sprite.modified = false;
  return { studio, sprite };
}

const apply = (studio: ReturnType<typeof createStudio>, args: Record<string, unknown>) => studio.call<Reply>("layer.apply", args);
const names = (reply: Reply) => reply.layers.map((l: Reply) => l.name);

test("list reports the layers bottom to top and the active one, without changing anything", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "ink");
  sprite.modified = false;
  const reply = await apply(studio, { op: "list" });
  assert.deepEqual(names(reply), ["Layer 1", "ink"]);
  assert.equal(reply.activeLayer, "ink");
  assert.equal(reply.applied, undefined);
  assert.equal(sprite.modified, false);
});

test("create adds a layer on top with its settings, makes it active, and marks the sprite modified", async () => {
  const { studio, sprite } = setup();
  const reply = await apply(studio, { op: "create", name: "shade", opacity: 128, visible: false });
  assert.deepEqual(names(reply), ["Layer 1", "shade"]);
  assert.deepEqual([reply.layers[1].opacity, reply.layers[1].visible], [128, false]);
  assert.deepEqual([reply.applied, reply.activeLayer], [1, "shade"]);
  assert.equal(sprite.modified, true);
});

test("create without a name is called 'Layer N', and index places it in the stack (1 is the bottom)", async () => {
  const { studio } = setup();
  assert.deepEqual(names(await apply(studio, { op: "create" })), ["Layer 1", "Layer 2"]);
  assert.deepEqual(names(await apply(studio, { op: "create", name: "under", index: 1 })), ["under", "Layer 1", "Layer 2"]);
});

test("reorder moves a layer to a stack position, clamping a position past either end", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "a");
  studio.addLayer(sprite, "b");
  assert.deepEqual(names(await apply(studio, { op: "reorder", name: "b", index: 2 })), ["Layer 1", "b", "a"]);
  assert.deepEqual(names(await apply(studio, { op: "reorder", name: "b", index: 0 })), ["b", "Layer 1", "a"]);
  assert.deepEqual(names(await apply(studio, { op: "reorder", name: "b", index: 99 })), ["Layer 1", "a", "b"]);
  await rejectsWith(apply(studio, { op: "reorder", name: "b" }), "invalid_args", /'index'/);
});

test("rename, set and delete change the named layer", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "ink");
  await apply(studio, { op: "rename", name: "ink", newName: "lines" });
  const set = await apply(studio, { op: "set", name: "lines", visible: false, editable: false, opacity: 10, newName: "faint" });
  assert.deepEqual(set.layers[1], {
    name: "faint", index: 2, visible: false, editable: false, opacity: 10,
    cels: [],
  });
  assert.deepEqual(names(await apply(studio, { op: "delete", name: "faint" })), ["Layer 1"]);
  await rejectsWith(apply(studio, { op: "rename", name: "Layer 1" }), "invalid_args", /'newName'/);
});

test("the last layer cannot be deleted", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, { op: "delete", name: "Layer 1" }), "invalid_args", /at least one layer/);
});

test("activate changes the layer tools use by default, without marking the sprite modified", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "top");
  sprite.modified = false;
  const reply = await apply(studio, { op: "activate", name: "Layer 1" });
  assert.equal(reply.activeLayer, "Layer 1");
  assert.equal((await studio.call<Reply>("sprite.info")).activeLayer, "Layer 1");
  assert.equal(sprite.modified, false);
});

test("duplicate puts a '<name> Copy' with its own copy of every cel directly above the original", async () => {
  const { studio, sprite } = setup();
  sprite.frames.push({ durationMs: 100 });
  const base = sprite.layers[0]!;
  studio.ensureCel(sprite, base, 2).image.set(0, 0, RED);
  studio.addLayer(sprite, "top");
  const reply = await apply(studio, { op: "duplicate", name: "Layer 1" });
  assert.deepEqual(names(reply), ["Layer 1", "Layer 1 Copy", "top"]);
  assert.deepEqual(reply.layers[1].cels, [2]);
  assert.equal(reply.activeLayer, "top", "duplicating does not move the active layer");
  sprite.layers[1]!.cels.get(2)!.image.set(0, 0, BLUE);
  assert.equal(base.cels.get(2)!.image.get(0, 0), RED, "the copy's pixels are its own");
});

test("duplicate toSprite copies cels by frame into another sprite, renaming on a clash and reporting dropped frames", async () => {
  const { studio, sprite } = setup();
  sprite.frames.push({ durationMs: 100 });
  const base = sprite.layers[0]!;
  studio.ensureCel(sprite, base, 1).image.set(0, 0, RED);
  studio.ensureCel(sprite, base, 2).image.set(0, 0, BLUE);
  const target = studio.addSprite({ width: 2, height: 1 });
  target.modified = false;
  studio.activate(sprite);
  const reply = await apply(studio, { op: "duplicate", name: "Layer 1", toSprite: `#${target.id}` });
  assert.deepEqual(reply.duplicated, [{ sourceLayer: "Layer 1", name: "Layer 1 2", toSprite: `#${target.id}`, framesDropped: 1 }]);
  assert.deepEqual(target.layers.map((l) => l.name), ["Layer 1", "Layer 1 2"]);
  assert.equal(target.layers[1]!.cels.get(1)!.image.get(0, 0), RED);
  assert.equal(target.modified, true);
});

test("duplicating into an indexed sprite re-encodes the pixels into its palette", async () => {
  const { studio, sprite } = setup();
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image.set(1, 0, BLUE);
  const target = studio.addSprite({ width: 2, height: 1, colorMode: "indexed", palette: [rgba(0, 0, 0), RED, BLUE] });
  studio.activate(sprite);
  await apply(studio, { op: "duplicate", name: "Layer 1", toSprite: `#${target.id}` });
  assert.deepEqual([...target.layers[1]!.cels.get(1)!.image.pixels], [0, 2]);
});

test("merge paints a layer onto the one below at its opacity and removes it; the lower layer keeps its name", async () => {
  const { studio, sprite } = setup();
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(2, 1, new Uint32Array([RED, RED]));
  const top = studio.addLayer(sprite, "top");
  top.opacity = 255;
  studio.ensureCel(sprite, top, 1).image.set(1, 0, BLUE);
  const reply = await apply(studio, { op: "merge", name: "top" });
  assert.deepEqual(names(reply), ["Layer 1"]);
  assert.equal(reply.activeLayer, "Layer 1");
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [RED, BLUE]);
});

test("merge creates the lower cel where only the upper layer had one", async () => {
  const { studio, sprite } = setup();
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 1).image.set(0, 0, RED);
  await apply(studio, { op: "merge", name: "top" });
  assert.equal(sprite.layers[0]!.cels.get(1)!.image.get(0, 0), RED);
});

test("the bottom layer cannot be merged down", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, { op: "merge", name: "Layer 1" }), "invalid_args", /bottom layer/);
});

test("a batch applies in order; one failing op undoes the whole batch", async () => {
  const { studio, sprite } = setup();
  const ok = await apply(studio, {
    batch: [
      { op: "create", name: "head" },
      { op: "create", name: "body", index: 1 },
      { op: "rename", name: "head", newName: "face" },
    ],
  });
  assert.equal(ok.applied, 3);
  assert.deepEqual(names(ok), ["body", "Layer 1", "face"]);
  sprite.modified = false;
  const pixels = [...sprite.layers[0]!.cels.values()];
  await rejectsWith(
    apply(studio, {
      batch: [
        { op: "create", name: "arm" },
        { op: "merge", name: "face" },
        { op: "delete", name: "nope" },
      ],
    }),
    "invalid_args",
    /No layer named 'nope'/,
  );
  assert.deepEqual(names(await apply(studio, { op: "list" })), ["body", "Layer 1", "face"]);
  assert.equal(sprite.modified, false);
  assert.deepEqual([...sprite.layers[0]!.cels.values()], pixels);
});

test("a failed merge leaves the lower layer's pixels as they were", async () => {
  const { studio, sprite } = setup();
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image.set(0, 0, RED);
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 1).image.set(0, 0, BLUE);
  await rejectsWith(apply(studio, { batch: [{ op: "merge", name: "top" }, { op: "explode", name: "Layer 1" }] }), "unsupported_command");
  assert.equal(sprite.layers[0]!.cels.get(1)!.image.get(0, 0), RED);
  assert.deepEqual(sprite.layers.map((l) => l.name), ["Layer 1", "top"]);
});

test("an out-of-range opacity is invalid_args, and an unknown op or 'list' inside a batch is unsupported_command", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, { op: "set", name: "Layer 1", opacity: 300 }), "invalid_args", /opacity/);
  await rejectsWith(apply(studio, { op: "explode", name: "Layer 1" }), "unsupported_command", /explode/);
  await rejectsWith(apply(studio, { batch: [{ op: "list" }] }), "unsupported_command", /list/);
});
