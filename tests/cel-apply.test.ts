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

/** Four frames; the bottom layer has a 1x1 red cel at (2,3) on frame 1 only. */
function setup() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 8, height: 8 });
  sprite.frames = [100, 100, 100, 100].map((durationMs) => ({ durationMs }));
  const layer = sprite.layers[0]!;
  layer.cels.set(1, { x: 2, y: 3, image: Image.from(1, 1, new Uint32Array([RED])), opacity: 200 });
  sprite.modified = false;
  return { studio, sprite, layer };
}

const apply = (studio: ReturnType<typeof createStudio>, args: Record<string, unknown>) => studio.call<Reply>("cel.apply", args);

test("list reports every cel's layer, frame, bounds and opacity", async () => {
  const { studio, sprite } = setup();
  const top = studio.addLayer(sprite, "top");
  studio.ensureCel(sprite, top, 2);
  sprite.modified = false;
  assert.deepEqual(await apply(studio, { op: "list" }), {
    sprite: "Sprite",
    cels: [
      { layer: "Layer 1", frame: 1, x: 2, y: 3, width: 1, height: 1, opacity: 200 },
      { layer: "top", frame: 2, x: 0, y: 0, width: 8, height: 8, opacity: 255 },
    ],
  });
  assert.equal(sprite.modified, false);
});

test("create makes an empty canvas-sized cel where there is none and keeps one that exists", async () => {
  const { studio, sprite, layer } = setup();
  const reply = await apply(studio, { op: "create", frame: 2 });
  assert.deepEqual([reply.sprite, reply.applied, reply.frames], ["Sprite", 1, undefined]);
  assert.deepEqual([layer.cels.get(2)!.image.width, layer.cels.get(2)!.image.height], [8, 8]);
  await apply(studio, { op: "create", frame: 1 });
  assert.equal(layer.cels.get(1)!.image.get(0, 0), RED);
  assert.equal(sprite.modified, true);
});

test("clear empties a cel in place; delete removes it; both report 0 where there is no cel", async () => {
  const { studio, layer } = setup();
  assert.equal((await apply(studio, { op: "clear", frame: 1 })).applied, 1);
  const cleared = layer.cels.get(1)!;
  assert.deepEqual([cleared.x, cleared.y, cleared.image.width, cleared.image.get(0, 0)], [2, 3, 1, 0]);
  assert.equal((await apply(studio, { op: "delete", frame: 1 })).applied, 1);
  assert.equal(layer.cels.has(1), false);
  assert.equal((await apply(studio, { op: "clear", frame: 1 })).applied, 0);
  assert.equal((await apply(studio, { op: "delete", frame: 1 })).applied, 0);
});

test("move shifts a cel by dx/dy or to x/y, and set changes its opacity", async () => {
  const { studio, layer } = setup();
  await apply(studio, { op: "move", frame: 1, dx: 1, dy: -2 });
  assert.deepEqual([layer.cels.get(1)!.x, layer.cels.get(1)!.y], [3, 1]);
  await apply(studio, { op: "set", frame: 1, x: 0, opacity: 50 });
  assert.deepEqual([layer.cels.get(1)!.x, layer.cels.get(1)!.y, layer.cels.get(1)!.opacity], [0, 1, 50]);
});

test("move and set need a cel, and refuse an out-of-range opacity without moving it", async () => {
  const { studio, layer } = setup();
  await rejectsWith(apply(studio, { op: "move", frame: 2, dx: 1 }), "invalid_args", /No cel on 'Layer 1' frame 2/);
  await rejectsWith(apply(studio, { op: "set", frame: 1, x: 5, opacity: 300 }), "invalid_args", /opacity/);
  assert.equal(layer.cels.get(1)!.x, 2);
});

test("copy puts an independent copy of the cel on another frame or layer, at full opacity", async () => {
  const { studio, sprite, layer } = setup();
  const top = studio.addLayer(sprite, "top");
  await apply(studio, { op: "copy", layer: "Layer 1", frame: 1, toFrame: 3 });
  await apply(studio, { op: "copy", layer: "Layer 1", frame: 1, toLayer: "top" });
  const copy = layer.cels.get(3)!;
  assert.deepEqual([copy.x, copy.y, copy.opacity, copy.image.get(0, 0)], [2, 3, 255, RED]);
  assert.equal(top.cels.get(1)!.image.get(0, 0), RED);
  copy.image.set(0, 0, 0);
  assert.equal(layer.cels.get(1)!.image.get(0, 0), RED, "the copy's pixels are its own");
  await rejectsWith(apply(studio, { op: "copy", layer: "Layer 1", frame: 2, toFrame: 3 }), "invalid_args", /Nothing to copy/);
});

test("tween eases a position from the start cel to the end value, copying the start cel into empty frames", async () => {
  const { studio, layer } = setup();
  const reply = await apply(studio, { op: "tween", fromFrame: 1, toFrame: 4, property: "position", to: { x: 8, y: 0 }, easing: "linear" });
  assert.deepEqual(reply.frames, [
    { frame: 1, x: 2, y: 3 },
    { frame: 2, x: 4, y: 2 },
    { frame: 3, x: 6, y: 1 },
    { frame: 4, x: 8, y: 0 },
  ]);
  assert.equal(reply.applied, 4);
  assert.equal(layer.cels.get(3)!.image.get(0, 0), RED);
  layer.cels.get(3)!.image.set(0, 0, 0);
  assert.equal(layer.cels.get(1)!.image.get(0, 0), RED, "filled-in cels are copies, not links");
});

test("tween opacity follows the easing curve", async () => {
  const { studio } = setup();
  const reply = await apply(studio, { op: "tween", fromFrame: 1, toFrame: 3, property: "opacity", to: 0, easing: "ease_in" });
  // ease_in at t=0.5 is 0.25 of the way from 200 to 0.
  assert.deepEqual(reply.frames, [
    { frame: 1, opacity: 200 },
    { frame: 2, opacity: 150 },
    { frame: 3, opacity: 0 },
  ]);
});

test("tween refuses a backwards range, a bad property or end value, an unknown easing, and a missing start cel", async () => {
  const { studio, layer } = setup();
  const base = { op: "tween", fromFrame: 1, toFrame: 2, property: "position", to: { x: 1, y: 1 } };
  await rejectsWith(apply(studio, { ...base, fromFrame: 2, toFrame: 1 }), "invalid_args", /toFrame > fromFrame/);
  await rejectsWith(apply(studio, { ...base, property: "scale" }), "invalid_args", /property/);
  await rejectsWith(apply(studio, { ...base, to: 5 }), "invalid_args", /to\.x/);
  await rejectsWith(apply(studio, { ...base, property: "opacity", to: 999 }), "invalid_args", /opacity/);
  await rejectsWith(apply(studio, { ...base, easing: "bounce" }), "invalid_args", /Unknown easing 'bounce'/);
  await rejectsWith(apply(studio, { ...base, fromFrame: 2, toFrame: 3 }), "invalid_args", /No cel on 'Layer 1' frame 2 to tween from/);
  assert.deepEqual([...layer.cels.keys()], [1], "a refused tween fills in nothing");
});

test("oscillate offsets the start position along one sine wave over the range", async () => {
  const { studio } = setup();
  const reply = await apply(studio, { op: "oscillate", fromFrame: 1, toFrame: 4, amplitudeX: 0, amplitudeY: 2 });
  // period 4: sin at 0, 1/4, 1/2, 3/4 of a turn.
  assert.deepEqual(reply.frames, [
    { frame: 1, x: 2, y: 3 },
    { frame: 2, x: 2, y: 5 },
    { frame: 3, x: 2, y: 3 },
    { frame: 4, x: 2, y: 1 },
  ]);
  await rejectsWith(apply(studio, { op: "oscillate", fromFrame: 1, toFrame: 4, period: 1 }), "invalid_args", /period/);
});

test("a missing op is invalid_args and an unknown one unsupported_command", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, {}), "invalid_args", /'op'/);
  await rejectsWith(apply(studio, { op: "explode" }), "unsupported_command", /explode/);
});
