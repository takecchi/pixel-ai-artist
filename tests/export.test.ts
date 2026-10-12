import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { decodeGif } from "../dist/lib/gif.js";
import { decodePng } from "../dist/lib/png.js";

type Reply = Record<string, any>;
type Studio = ReturnType<typeof createStudio>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

async function inTempDir(body: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-ai-artist-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const img = (width: number, height: number, pixels: number[]) => Image.from(width, height, new Uint32Array(pixels));
const readPng = (file: string) => decodePng(new Uint8Array(readFileSync(file)));
const readGif = (file: string) => decodeGif(new Uint8Array(readFileSync(file)));
const readJson = (file: string): Reply => JSON.parse(readFileSync(file, "utf8"));
const run = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("export.run", args);

const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);
const YELLOW = rgba(255, 255, 0);
const WHITE = rgba(255, 255, 255);

/**
 * A 2x1 sprite of three frames (100, 200, 300 ms) on three layers, bottom to top:
 *   Back   visible, one colour per frame: RED, GREEN, BLUE
 *   Front  visible, 50% opaque, frame 1 only: [clear, YELLOW]
 *   Ghost  hidden, every frame: [WHITE, clear]
 * and the tags walk 1..2, idle 3..3 and late 2..3.
 */
async function fixture(studio = createStudio()) {
  await studio.call("sprite.manage", { op: "new", width: 2, height: 1 });
  const sprite = studio.activeSprite()!;
  sprite.palette = [RED, GREEN, BLUE, YELLOW, WHITE];
  sprite.frames = [{ durationMs: 100 }, { durationMs: 200 }, { durationMs: 300 }];
  const back = sprite.layers[0]!;
  back.name = "Back";
  [RED, GREEN, BLUE].forEach((c, i) => studio.ensureCel(sprite, back, i + 1).image = img(2, 1, [c, c]));
  const front = studio.addLayer(sprite, "Front");
  front.opacity = 128;
  studio.ensureCel(sprite, front, 1).image = img(2, 1, [0, YELLOW]);
  const ghost = studio.addLayer(sprite, "Ghost");
  ghost.visible = false;
  for (const n of [1, 2, 3]) studio.ensureCel(sprite, ghost, n).image = img(2, 1, [WHITE, 0]);
  const tag = (name: string, from: number, to: number) =>
    ({ name, from, to, direction: "forward" as const, repeats: 0, color: 0 });
  sprite.tags = [tag("walk", 1, 2), tag("idle", 3, 3), tag("late", 2, 3)];
  sprite.activeFrame = 1;
  return { studio, sprite };
}

// ── common ──────────────────────────────────────────────────────────────

test("export.run answers the sprite, op, files and the original size and frame count, whatever the scale", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const file = path.join(dir, "out.png");
    const reply = await run(studio, { op: "png", path: file, scale: 4 });
    assert.equal(reply.sprite, "Sprite");
    assert.equal(reply.op, "png");
    assert.deepEqual(reply.files, [file]);
    assert.deepEqual([reply.width, reply.height, reply.frameCount], [2, 1, 3]);
    assert.equal(reply.atlas, undefined);
    const written = readPng(file);
    assert.deepEqual([written.width, written.height], [8, 4]);
  });
});

test("export.run exports the sprite named by `sprite`, not the active one", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await fixture();
    const other = await studio.call<Reply>("sprite.manage", { op: "new", width: 1, height: 1 });
    assert.notEqual(studio.activeSprite()!.id, sprite.id);
    const file = path.join(dir, "named.png");
    const reply = await run(studio, { op: "png", path: file, sprite: `#${sprite.id}` });
    assert.deepEqual([reply.width, reply.height, reply.frameCount], [2, 1, 3]);
    assert.notEqual(other.id, sprite.id);
    assert.equal(readPng(file).get(0, 0), RED);
  });
});

test("export.run without a path or an op is invalid_args, and an unknown op is unsupported_command", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    await rejectsWith(run(studio, { op: "png" }), "invalid_args", /path/);
    await rejectsWith(run(studio, { path: path.join(dir, "a.png") }), "invalid_args", /op/);
    await rejectsWith(run(studio, { op: "bmp", path: path.join(dir, "a.bmp") }), "unsupported_command", /bmp/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("export.run refuses a scale that is not an integer in 1..16 and writes nothing", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    for (const scale of [0, 17, 1.5, -2, "2"]) {
      await rejectsWith(run(studio, { op: "png", path: path.join(dir, "s.png"), scale }), "invalid_args", /scale/);
    }
    assert.deepEqual(readdirSync(dir), []);
    await run(studio, { op: "png", path: path.join(dir, "s.png"), scale: 16 });
    assert.equal(readPng(path.join(dir, "s.png")).width, 32);
  });
});

// ── layers ──────────────────────────────────────────────────────────────

test("layers draws only the named layers, a hidden one included", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const ghost = path.join(dir, "ghost.png");
    await run(studio, { op: "png", path: ghost, layers: ["Ghost"] });
    assert.deepEqual([...readPng(ghost).pixels], [WHITE, 0]);
    const both = path.join(dir, "both.png");
    await run(studio, { op: "png", path: both, layers: ["Back", "Ghost"] });
    assert.deepEqual([...readPng(both).pixels], [WHITE, RED]);
  });
});

test("without layers only the visible layers are drawn", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const file = path.join(dir, "visible.png");
    await run(studio, { op: "png", path: file });
    const pixels = readPng(file).pixels;
    assert.equal(pixels[0], RED);
    assert.notEqual(pixels[1], RED, "the visible Front layer shows over Back");
    assert.notEqual(pixels[0], WHITE, "the hidden Ghost layer stays out");
  });
});

test("an unknown layer name is invalid_args and nothing is written", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    for (const op of ["png", "gif", "frames", "spritesheet"]) {
      const file = path.join(dir, op === "gif" ? "a.gif" : "a_{frame}.png");
      await rejectsWith(run(studio, { op, path: file, layers: ["Back", "Nope"] }), "invalid_args", /Nope/);
    }
    assert.deepEqual(readdirSync(dir), []);
  });
});

// ── tags ────────────────────────────────────────────────────────────────

test("tags keeps the frames the tags cover, the union when there are several", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const file = path.join(dir, "t.gif");
    await run(studio, { op: "gif", path: file, tags: ["walk", "idle"] });
    assert.equal(readGif(file).frames.length, 3);
    await run(studio, { op: "gif", path: file, tags: ["idle"] });
    assert.deepEqual(readGif(file).frames.map((f) => [...f.image.pixels]), [[BLUE, BLUE]]);
    await run(studio, { op: "gif", path: file, tags: ["walk", "late"] });
    assert.equal(readGif(file).frames.length, 3);
    await run(studio, { op: "gif", path: file, tags: ["walk"] });
    assert.deepEqual(readGif(file).frames.map((f) => f.durationMs), [100, 200]);
  });
});

test("an unknown tag name is invalid_args and nothing is written", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    for (const op of ["gif", "frames", "spritesheet"]) {
      const file = path.join(dir, op === "gif" ? "a.gif" : "a_{frame}.png");
      await rejectsWith(run(studio, { op, path: file, tags: ["walk", "run"] }), "invalid_args", /run/);
    }
    assert.deepEqual(readdirSync(dir), []);
  });
});

// ── scale ───────────────────────────────────────────────────────────────

test("scale enlarges nearest-neighbour: N times the size, each pixel an NxN block", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const plain = path.join(dir, "plain.png");
    const big = path.join(dir, "big.png");
    await run(studio, { op: "png", path: plain });
    await run(studio, { op: "png", path: big, scale: 3 });
    const small = readPng(plain);
    const scaled = readPng(big);
    assert.deepEqual([scaled.width, scaled.height], [6, 3]);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) assert.equal(scaled.get(x, y), small.get(Math.floor(x / 3), Math.floor(y / 3)));
    }
  });
});

// ── png ─────────────────────────────────────────────────────────────────

test("png writes the frame asked for, counted from 1, and answers its number", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const file = path.join(dir, "f.png");
    const reply = await run(studio, { op: "png", path: file, frame: 3 });
    assert.equal(reply.frame, 3);
    assert.deepEqual(reply.files, [file]);
    assert.deepEqual([...readPng(file).pixels], [BLUE, BLUE]);
  });
});

test("png without frame writes the active frame", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await fixture();
    sprite.activeFrame = 2;
    const file = path.join(dir, "active.png");
    const reply = await run(studio, { op: "png", path: file });
    assert.equal(reply.frame, 2);
    assert.deepEqual([...readPng(file).pixels], [GREEN, GREEN]);
  });
});

test("png with tags is invalid_args and writes nothing", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    await rejectsWith(run(studio, { op: "png", path: path.join(dir, "t.png"), tags: ["walk"] }), "invalid_args", /one frame/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("png with a frame outside 1..frameCount is invalid_args and writes nothing", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    for (const frame of [0, 4, -1]) {
      await rejectsWith(run(studio, { op: "png", path: path.join(dir, "r.png"), frame }), "invalid_args", /range/);
    }
    assert.deepEqual(readdirSync(dir), []);
  });
});

// ── aseprite ────────────────────────────────────────────────────────────

test("aseprite with layers or tags is invalid_args, and otherwise unsupported_command", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const file = path.join(dir, "x.aseprite");
    const whole = /'aseprite' saves the whole document; `layers` and `tags` apply to png, gif, frames and spritesheet\./;
    await rejectsWith(run(studio, { op: "aseprite", path: file, layers: ["Back"] }), "invalid_args", whole);
    await rejectsWith(run(studio, { op: "aseprite", path: file, tags: ["walk"] }), "invalid_args", whole);
    await rejectsWith(run(studio, { op: "aseprite", path: file }), "unsupported_command");
    assert.deepEqual(readdirSync(dir), []);
  });
});

// ── gif ─────────────────────────────────────────────────────────────────

test("gif writes every frame with its duration", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const file = path.join(dir, "a.gif");
    const reply = await run(studio, { op: "gif", path: file });
    assert.deepEqual(reply.files, [file]);
    const gif = readGif(file);
    assert.deepEqual(gif.frames.map((f) => f.durationMs), [100, 200, 300]);
    assert.equal(gif.frames[1]!.image.get(0, 0), GREEN);
    assert.equal(gif.frames[2]!.image.get(1, 0), BLUE);
  });
});

test("gif moves a colour outside the sprite's palette to the nearest palette colour", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await fixture();
    sprite.palette = [rgba(0, 0, 0), RED, BLUE];
    sprite.layers[0]!.cels.get(1)!.image = img(2, 1, [rgba(250, 10, 10), rgba(20, 20, 240)]);
    sprite.layers[1]!.visible = false;
    const file = path.join(dir, "snap.gif");
    await run(studio, { op: "gif", path: file, tags: ["idle", "walk"] });
    assert.deepEqual([...readGif(file).frames[0]!.image.pixels], [RED, BLUE]);
  });
});

// ── frames ──────────────────────────────────────────────────────────────

test("frames writes one file per frame from {frame} counted from 0, and lists the files it wrote", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const reply = await run(studio, { op: "frames", path: path.join(dir, "walk_{frame}.png") });
    const expected = [0, 1, 2].map((n) => path.join(dir, `walk_${n}.png`));
    assert.deepEqual(reply.files, expected);
    assert.deepEqual(readdirSync(dir).sort(), ["walk_0.png", "walk_1.png", "walk_2.png"]);
    assert.deepEqual(expected.map((f) => readPng(f).get(0, 0)), [RED, GREEN, BLUE]);
  });
});

test("frames with tags numbers the kept frames from 0", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const reply = await run(studio, { op: "frames", path: path.join(dir, "walk_{frame}.png"), tags: ["late"] });
    assert.deepEqual(reply.files, [path.join(dir, "walk_0.png"), path.join(dir, "walk_1.png")]);
    assert.deepEqual(readdirSync(dir).sort(), ["walk_0.png", "walk_1.png"]);
    assert.equal(readPng(path.join(dir, "walk_0.png")).get(0, 0), GREEN);
    assert.equal(readPng(path.join(dir, "walk_1.png")).get(0, 0), BLUE);
  });
});

// ── spritesheet ─────────────────────────────────────────────────────────

test("spritesheet writes the PNG and a .json beside it, listed json first, and answers the atlas path", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const png = path.join(dir, "sheet.v2.png");
    const json = path.join(dir, "sheet.v2.json");
    const reply = await run(studio, { op: "spritesheet", path: png });
    assert.deepEqual(reply.files, [json, png]);
    assert.equal(reply.atlas, json);
    const sheet = readPng(png);
    assert.deepEqual([sheet.width, sheet.height], [6, 1]);
    assert.equal(sheet.get(0, 0), RED);
    assert.equal(sheet.get(2, 0), GREEN);
    assert.equal(sheet.get(4, 0), BLUE);
    const atlas = readJson(json);
    assert.deepEqual(atlas.frames.map((f: Reply) => f.frame), [
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 2, y: 0, w: 2, h: 1 },
      { x: 4, y: 0, w: 2, h: 1 },
    ]);
    assert.deepEqual(atlas.frames.map((f: Reply) => f.duration), [100, 200, 300]);
    assert.deepEqual(atlas.meta.size, { w: 6, h: 1 });
  });
});

test("spritesheet with includeJson false writes only the PNG and answers no atlas", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const png = path.join(dir, "only.png");
    const reply = await run(studio, { op: "spritesheet", path: png, includeJson: false });
    assert.deepEqual(reply.files, [png]);
    assert.equal(reply.atlas, undefined);
    assert.deepEqual(readdirSync(dir), ["only.png"]);
  });
});

test("spritesheet sheetType picks the layout", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const png = path.join(dir, "v.png");
    await run(studio, { op: "spritesheet", path: png, sheetType: "vertical" });
    const sheet = readPng(png);
    assert.deepEqual([sheet.width, sheet.height], [2, 3]);
    assert.deepEqual([0, 1, 2].map((y) => sheet.get(0, y)), [RED, GREEN, BLUE]);
    assert.deepEqual(readJson(path.join(dir, "v.json")).frames.map((f: Reply) => f.frame.y), [0, 1, 2]);
  });
});

test("spritesheet with an unknown sheetType is invalid_args and writes nothing", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    await rejectsWith(run(studio, { op: "spritesheet", path: path.join(dir, "x.png"), sheetType: "diagonal" }), "invalid_args", /sheetType/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("spritesheet with a texture that is not .png is unsupported_command and writes nothing", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    await rejectsWith(run(studio, { op: "spritesheet", path: path.join(dir, "x.gif") }), "unsupported_command", /\.png/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("spritesheet byTag lays each tag's frames out apart and names them after the tag", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await fixture();
    sprite.tags = sprite.tags.filter((t) => t.name !== "late");
    sprite.filename = path.join(dir, "hero.aseprite");
    const png = path.join(dir, "tags.png");
    await run(studio, { op: "spritesheet", path: png, byTag: true, sheetType: "rows" });
    const atlas = readJson(path.join(dir, "tags.json"));
    assert.deepEqual(atlas.frames.map((f: Reply) => f.filename), ["hero #walk 0.aseprite", "hero #walk 1.aseprite", "hero #idle.aseprite"]);
    assert.deepEqual(atlas.frames.map((f: Reply) => [f.frame.x, f.frame.y]), [[0, 0], [2, 0], [0, 1]]);
    const sheet = readPng(png);
    assert.deepEqual([sheet.width, sheet.height], [4, 2]);
    assert.equal(sheet.get(0, 1), BLUE);
  });
});

test("spritesheet padding surrounds every frame with transparent pixels and enlarges the cells", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const png = path.join(dir, "pad.png");
    await run(studio, { op: "spritesheet", path: png, padding: 1 });
    const sheet = readPng(png);
    assert.deepEqual([sheet.width, sheet.height], [12, 3]);
    assert.equal(sheet.get(0, 0), 0);
    assert.equal(sheet.get(1, 1), RED);
    assert.equal(sheet.get(5, 1), GREEN);
    const atlas = readJson(path.join(dir, "pad.json"));
    assert.deepEqual(atlas.frames[1].frame, { x: 4, y: 0, w: 4, h: 3 });
  });
});

test("spritesheet trim crops each frame to its opaque pixels and records where they were", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const png = path.join(dir, "trim.png");
    await run(studio, { op: "spritesheet", path: png, trim: true, layers: ["Ghost"] });
    const sheet = readPng(png);
    assert.deepEqual([sheet.width, sheet.height], [3, 1]);
    assert.deepEqual([...sheet.pixels], [WHITE, WHITE, WHITE]);
    const frame = readJson(path.join(dir, "trim.json")).frames[0];
    assert.equal(frame.trimmed, true);
    assert.deepEqual(frame.spriteSourceSize, { x: 0, y: 0, w: 1, h: 1 });
    assert.deepEqual(frame.sourceSize, { w: 2, h: 1 });
  });
});

test("spritesheet with tags renumbers the atlas's frameTags within the kept frames and drops tags with none left", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const png = path.join(dir, "late.png");
    await run(studio, { op: "spritesheet", path: png, tags: ["late"] });
    const atlas = readJson(path.join(dir, "late.json"));
    assert.equal(atlas.frames.length, 2);
    assert.deepEqual(
      atlas.meta.frameTags.map((t: Reply) => [t.name, t.from, t.to]),
      [["walk", 0, 0], ["idle", 1, 1], ["late", 0, 1]],
    );
    const idle = path.join(dir, "idle.png");
    await run(studio, { op: "spritesheet", path: idle, tags: ["idle"] });
    assert.deepEqual(
      readJson(path.join(dir, "idle.json")).meta.frameTags.map((t: Reply) => [t.name, t.from, t.to]),
      [["idle", 0, 0], ["late", 0, 0]],
    );
  });
});

test("spritesheet meta names the texture file, the app, the package version and the layers exported", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await fixture();
    const version = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
    await run(studio, { op: "spritesheet", path: path.join(dir, "sub", "meta.png") });
    const meta = readJson(path.join(dir, "sub", "meta.json")).meta;
    assert.equal(meta.image, "meta.png");
    assert.equal(meta.app, "https://github.com/takecchi/pixel-ai-artist");
    assert.equal(meta.version, version);
    assert.deepEqual(meta.layers.map((l: Reply) => [l.name, l.opacity]), [["Back", 255], ["Front", 128]]);
    await run(studio, { op: "spritesheet", path: path.join(dir, "sub", "ghost.png"), layers: ["Ghost"] });
    assert.deepEqual(readJson(path.join(dir, "sub", "ghost.json")).meta.layers.map((l: Reply) => l.name), ["Ghost"]);
  });
});

test("spritesheet names a saved sprite's frames after its file", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await fixture();
    sprite.filename = path.join(dir, "hero.aseprite");
    const reply = await run(studio, { op: "spritesheet", path: path.join(dir, "hero.png") });
    assert.equal(reply.sprite, "hero.aseprite");
    const names = readJson(path.join(dir, "hero.json")).frames.map((f: Reply) => f.filename);
    assert.deepEqual(names, ["hero 0.aseprite", "hero 1.aseprite", "hero 2.aseprite"]);
    assert.equal(existsSync(path.join(dir, "hero.png")), true);
  });
});
