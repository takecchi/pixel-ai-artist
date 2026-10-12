import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ToolError, createStudio } from "../dist/doc/index.js";

type Reply = Record<string, any>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

function setup() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 1, height: 1 });
  sprite.frames = [{ durationMs: 100 }, { durationMs: 150 }, { durationMs: 200 }, { durationMs: 250 }];
  sprite.modified = false;
  return { studio, sprite };
}

const apply = (studio: ReturnType<typeof createStudio>, args: Record<string, unknown>) => studio.call<Reply>("tag.apply", args);

test("create adds a tag and the reply lists every tag with its frame count and summed duration", async () => {
  const { studio, sprite } = setup();
  const reply = await apply(studio, { op: "create", name: "walk", from: 2, to: 4, direction: "pingpong", repeats: 3, color: "#ff004d" });
  assert.deepEqual(reply, {
    sprite: "Sprite",
    tags: [{ name: "walk", from: 2, to: 4, direction: "pingpong", frames: 3, durationMs: 600 }],
  });
  assert.deepEqual([sprite.tags[0]!.repeats, sprite.tags[0]!.color], [3, 0xff004dff]);
  assert.equal(sprite.modified, true);
});

test("a created tag defaults to playing forward, forever", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "create", name: "idle", from: 1, to: 1 });
  assert.deepEqual([sprite.tags[0]!.direction, sprite.tags[0]!.repeats], ["forward", 0]);
});

test("create needs a name and a range", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, { op: "create", from: 1, to: 2 }), "invalid_args", /'name'/);
  await rejectsWith(apply(studio, { op: "create", name: "x", to: 2 }), "invalid_args", /'from'/);
  await rejectsWith(apply(studio, { op: "create", name: "x", from: 1 }), "invalid_args", /'to'/);
});

test("a range that runs backwards or past the frames is refused and no tag is made", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(apply(studio, { op: "create", name: "x", from: 3, to: 2 }), "invalid_args", /within frames 1–4/);
  await rejectsWith(apply(studio, { op: "create", name: "x", from: 1, to: 5 }), "invalid_args", /within frames 1–4/);
  assert.deepEqual(sprite.tags, []);
});

test("an unknown direction, a negative repeat count or a malformed colour is invalid_args", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(apply(studio, { op: "create", name: "x", from: 1, to: 2, direction: "sideways" }), "invalid_args", /direction/);
  await rejectsWith(apply(studio, { op: "create", name: "x", from: 1, to: 2, repeats: -1 }), "invalid_args", /repeats/);
  await rejectsWith(apply(studio, { op: "create", name: "x", from: 1, to: 2, color: "red" }), "invalid_args", /#rrggbb/);
  assert.deepEqual(sprite.tags, []);
});

test("update changes only the fields it is given", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "create", name: "walk", from: 1, to: 2, direction: "reverse", repeats: 2 });
  const reply = await apply(studio, { op: "update", name: "walk", newName: "run", to: 3 });
  assert.deepEqual(reply.tags, [{ name: "run", from: 1, to: 3, direction: "reverse", frames: 3, durationMs: 450 }]);
  assert.equal(sprite.tags[0]!.repeats, 2);
});

test("an update that would leave the range invalid is refused and changes nothing", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "create", name: "walk", from: 2, to: 3 });
  await rejectsWith(apply(studio, { op: "update", name: "walk", newName: "run", from: 4 }), "invalid_args", /within frames/);
  assert.deepEqual([sprite.tags[0]!.name, sprite.tags[0]!.from, sprite.tags[0]!.to], ["walk", 2, 3]);
});

test("update and delete act on the last tag with the name, and an unknown name is invalid_args", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "create", name: "a", from: 1, to: 1 });
  await apply(studio, { op: "create", name: "a", from: 2, to: 2 });
  await apply(studio, { op: "update", name: "a", newName: "b" });
  assert.deepEqual(sprite.tags.map((t) => t.name), ["a", "b"]);
  assert.deepEqual((await apply(studio, { op: "delete", name: "a" })).tags.map((t: Reply) => t.name), ["b"]);
  await rejectsWith(apply(studio, { op: "delete", name: "nope" }), "invalid_args", /No tag named 'nope'/);
});

test("list changes nothing; a missing op is invalid_args and an unknown one unsupported_command", async () => {
  const { studio, sprite } = setup();
  assert.deepEqual((await apply(studio, { op: "list" })).tags, []);
  assert.equal(sprite.modified, false);
  await rejectsWith(apply(studio, {}), "invalid_args", /'op'/);
  await rejectsWith(apply(studio, { op: "explode" }), "unsupported_command", /explode/);
});
