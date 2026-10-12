import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ToolError, createStudio, rgba } from "../dist/doc/index.js";

type Reply = Record<string, any>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

/** Paints frame n with red level n so cels can be told apart after a move. */
function setup(frames: number[] = [100, 100, 100]) {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 1, height: 1 });
  sprite.frames = frames.map((durationMs) => ({ durationMs }));
  const layer = sprite.layers[0]!;
  frames.forEach((_, i) => studio.ensureCel(sprite, layer, i + 1).image.set(0, 0, rgba(i + 1, 0, 0)));
  sprite.modified = false;
  return { studio, sprite, layer };
}

const apply = (studio: ReturnType<typeof createStudio>, args: Record<string, unknown>) => studio.call<Reply>("frame.apply", args);
const order = (layer: { cels: Map<number, { image: { get(x: number, y: number): number } }> }, count: number) =>
  Array.from({ length: count }, (_, i) => (layer.cels.get(i + 1)?.image.get(0, 0) ?? 0) >>> 24);

test("list reports each frame's duration, the total and the active frame, changing nothing", async () => {
  const { studio, sprite } = setup([100, 80, 120]);
  sprite.activeFrame = 2;
  const reply = await apply(studio, { op: "list" });
  assert.deepEqual(reply, {
    sprite: "Sprite",
    frameCount: 3,
    frames: [
      { number: 1, durationMs: 100 },
      { number: 2, durationMs: 80 },
      { number: 3, durationMs: 120 },
    ],
    totalDurationMs: 300,
    activeFrame: 2,
  });
  assert.equal(sprite.modified, false);
});

test("add appends empty frames that take the previous frame's duration", async () => {
  const { studio, sprite, layer } = setup([100, 80]);
  const reply = await apply(studio, { op: "add", count: 2 });
  assert.deepEqual(reply.frames.map((f: Reply) => f.durationMs), [100, 80, 80, 80]);
  assert.deepEqual(order(layer, 4), [1, 2, 0, 0]);
  assert.equal(sprite.modified, true);
});

test("add with afterFrame inserts there and moves the later frames' cels along", async () => {
  const { studio, layer } = setup();
  await apply(studio, { op: "add", afterFrame: 1 });
  assert.deepEqual(order(layer, 4), [1, 0, 2, 3]);
  await apply(studio, { op: "add", afterFrame: 0 });
  assert.deepEqual(order(layer, 5), [0, 1, 0, 2, 3]);
  await rejectsWith(apply(studio, { op: "add", afterFrame: 9 }), "invalid_args", /afterFrame/);
});

test("inserting a frame grows a tag that spans the insertion point and shifts a tag after it", async () => {
  const { studio, sprite } = setup([100, 100, 100, 100]);
  const tag = (name: string, from: number, to: number) => ({ name, from, to, direction: "forward" as const, repeats: 0, color: 0 });
  sprite.tags.push(tag("walk", 1, 2), tag("idle", 3, 4));
  await apply(studio, { op: "add", afterFrame: 1 });
  assert.deepEqual(sprite.tags.map((t) => [t.name, t.from, t.to]), [["walk", 1, 3], ["idle", 4, 5]]);
});

test("duplicate puts a copy of the frame, cels and duration, right after it", async () => {
  const { studio, layer } = setup([100, 70, 100]);
  const reply = await apply(studio, { op: "duplicate", frame: 2, count: 2 });
  assert.deepEqual(reply.frames.map((f: Reply) => f.durationMs), [100, 70, 70, 70, 100]);
  assert.deepEqual(order(layer, 5), [1, 2, 2, 2, 3]);
  layer.cels.get(3)!.image.set(0, 0, rgba(9, 0, 0));
  assert.equal(layer.cels.get(2)!.image.get(0, 0) >>> 24, 2, "the copy's pixels are its own");
});

test("duplicate with linkCels answers unsupported_command, because linked cels are not ported", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(apply(studio, { op: "duplicate", frame: 1, linkCels: true }), "unsupported_command", /[Ll]inked cels/);
  assert.equal(sprite.frames.length, 3);
});

test("delete removes the frame and its cels; tags behind it move back and a tag left empty goes", async () => {
  const { studio, sprite, layer } = setup([100, 100, 100, 100]);
  const tag = (name: string, from: number, to: number) => ({ name, from, to, direction: "forward" as const, repeats: 0, color: 0 });
  sprite.tags.push(tag("hit", 2, 2), tag("walk", 1, 3), tag("idle", 4, 4));
  await apply(studio, { op: "delete", frame: 2 });
  assert.deepEqual(order(layer, 3), [1, 3, 4]);
  assert.deepEqual(sprite.tags.map((t) => [t.name, t.from, t.to]), [["walk", 1, 2], ["idle", 3, 3]]);
});

test("the last frame cannot be deleted", async () => {
  const { studio } = setup([100]);
  await rejectsWith(apply(studio, { op: "delete", frame: 1 }), "invalid_args", /at least one frame/);
});

test("deleting the active last frame moves the active frame back onto the sprite", async () => {
  const { studio, sprite } = setup();
  sprite.activeFrame = 3;
  assert.equal((await apply(studio, { op: "delete", frame: 3 })).activeFrame, 2);
});

test("set_duration sets one frame, every frame, or a whole cycle from frame 1", async () => {
  const { studio } = setup();
  assert.deepEqual((await apply(studio, { op: "set_duration", durationMs: 50, frame: 2 })).frames.map((f: Reply) => f.durationMs), [100, 50, 100]);
  assert.deepEqual((await apply(studio, { op: "set_duration", durationMs: 90 })).frames.map((f: Reply) => f.durationMs), [90, 90, 90]);
  const cycle = await apply(studio, { op: "set_duration", durations: [10, 20, 30, 40] });
  assert.deepEqual(cycle.frames.map((f: Reply) => f.durationMs), [10, 20, 30]);
  assert.equal(cycle.totalDurationMs, 60);
});

test("set_duration needs a duration, and refuses one that is not 1–65535 ms without changing any frame", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(apply(studio, { op: "set_duration" }), "invalid_args", /'durationMs'/);
  await rejectsWith(apply(studio, { op: "set_duration", durationMs: 0 }), "invalid_args", /durationMs/);
  await rejectsWith(apply(studio, { op: "set_duration", durations: [50, -1] }), "invalid_args", /durations\[1\]/);
  assert.deepEqual(sprite.frames.map((f) => f.durationMs), [100, 100, 100]);
});

test("activate changes the frame tools use by default, without marking the sprite modified", async () => {
  const { studio, sprite } = setup();
  assert.equal((await apply(studio, { op: "activate", frame: 3 })).activeFrame, 3);
  assert.equal((await studio.call<Reply>("sprite.info")).activeFrame, 3);
  assert.equal(sprite.modified, false);
});

test("reorder moves a frame's cels and duration to toIndex, while tag ranges stay on their positions", async () => {
  const { studio, sprite, layer } = setup([100, 200, 300, 400]);
  sprite.tags.push({ name: "walk", from: 1, to: 2, direction: "forward", repeats: 0, color: 0 });
  const reply = await apply(studio, { op: "reorder", frame: 1, toIndex: 3 });
  assert.deepEqual(order(layer, 4), [2, 3, 1, 4]);
  assert.deepEqual(reply.frames.map((f: Reply) => f.durationMs), [200, 300, 100, 400]);
  assert.deepEqual([sprite.tags[0]!.from, sprite.tags[0]!.to], [1, 2]);
  await apply(studio, { op: "reorder", frame: 4, toIndex: 1 });
  assert.deepEqual(order(layer, 4), [4, 2, 3, 1]);
});

test("reorder needs a toIndex inside the frames", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, { op: "reorder", frame: 1 }), "invalid_args", /'toIndex'/);
  await rejectsWith(apply(studio, { op: "reorder", frame: 1, toIndex: 4 }), "invalid_args", /toIndex 4 is outside frames 1–3/);
});

test("a missing op is invalid_args, an unknown one unsupported_command, and an out-of-range frame invalid_args", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, {}), "invalid_args", /'op'/);
  await rejectsWith(apply(studio, { op: "explode" }), "unsupported_command", /explode/);
  await rejectsWith(apply(studio, { op: "delete", frame: 7 }), "invalid_args", /out of range/);
});
