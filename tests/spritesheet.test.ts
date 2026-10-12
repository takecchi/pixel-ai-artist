import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Image } from "../dist/doc/model.js";
import { buildSpriteSheet, frameFileNames, type SheetTag } from "../dist/lib/spritesheet.js";

const RED = 0xff004dff;
const BLUE = 0x29adffff;
const GREEN = 0x00e436ff;
const YELLOW = 0xffec27ff;

/** A w*h image, transparent except for an opaque `color` rectangle at (x, y) of size rw*rh (default: everything). */
function art(w: number, h: number, color: number, x = 0, y = 0, rw = w - x, rh = h - y): Image {
  const pixels = new Uint32Array(w * h);
  for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) pixels[j * w + i] = color;
  return Image.from(w, h, pixels);
}

function px(img: Image, x: number, y: number): number {
  return img.pixels[y * img.width + x]!;
}

function frame(image: Image, durationMs = 100) {
  return { image, durationMs };
}

const base = { title: "walk", extension: "aseprite", app: "test-app", version: "1.2.3" };

function tag(name: string, from: number, to: number, extra: Partial<SheetTag> = {}): SheetTag {
  return { name, from, to, direction: "forward", repeat: 0, color: 0, ...extra };
}

/** Frames whose trimmed cells are 3x2, 2x5, 4x1 and 1x1 inside 8x8 sprites. */
function mixed() {
  return [
    frame(art(8, 8, RED, 1, 1, 3, 2), 10),
    frame(art(8, 8, BLUE, 0, 0, 2, 5), 20),
    frame(art(8, 8, GREEN, 4, 4, 4, 1), 30),
    frame(art(8, 8, YELLOW, 7, 7, 1, 1), 40),
  ];
}

function solids(n: number, w: number, h: number) {
  const colors = [RED, BLUE, GREEN, YELLOW, 0xffffffff];
  return Array.from({ length: n }, (_, i) => frame(art(w, h, colors[i % colors.length]!), 100 + i));
}

test("a horizontal sheet is as wide as the cells together and as tall as the tallest cell", () => {
  const { image, atlas } = buildSpriteSheet(mixed(), { ...base, trim: true });
  assert.deepEqual([image.width, image.height], [10, 5]);
  assert.deepEqual(atlas.frames.map((f) => f.frame), [
    { x: 0, y: 0, w: 3, h: 2 },
    { x: 3, y: 0, w: 2, h: 5 },
    { x: 5, y: 0, w: 4, h: 1 },
    { x: 9, y: 0, w: 1, h: 1 },
  ]);
  assert.deepEqual(atlas.meta.size, { w: 10, h: 5 });
});

test("a vertical sheet is the transpose of a horizontal one", () => {
  const { image, atlas } = buildSpriteSheet(mixed(), { ...base, trim: true, type: "vertical" });
  assert.deepEqual([image.width, image.height], [4, 9]);
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [0, 2], [0, 7], [0, 8]]);
});

test("horizontal and vertical sheets stay a single strip when split by tags", () => {
  const tags = [tag("a", 0, 1), tag("b", 2, 3)];
  const h = buildSpriteSheet(mixed(), { ...base, trim: true, tags, splitTags: true });
  assert.deepEqual([h.image.width, h.image.height], [10, 5]);
  assert.ok(h.atlas.frames.every((f) => f.frame.y === 0));
  const v = buildSpriteSheet(mixed(), { ...base, trim: true, tags, splitTags: true, type: "vertical" });
  assert.deepEqual([v.image.width, v.image.height], [4, 9]);
  assert.ok(v.atlas.frames.every((f) => f.frame.x === 0));
});

test("a rows sheet puts every frame on one row when not split by tags", () => {
  const { image, atlas } = buildSpriteSheet(solids(7, 4, 3), { ...base, type: "rows" });
  assert.deepEqual([image.width, image.height], [28, 3]);
  assert.ok(atlas.frames.every((f) => f.frame.y === 0));
});

test("a columns sheet puts every frame in one column when not split by tags", () => {
  const { image, atlas } = buildSpriteSheet(solids(7, 4, 3), { ...base, type: "columns" });
  assert.deepEqual([image.width, image.height], [4, 21]);
  assert.ok(atlas.frames.every((f) => f.frame.x === 0));
});

test("a rows sheet starts a new row where the tag changes, as tall as the tallest cell of the row above", () => {
  const tags = [tag("a", 0, 1), tag("b", 2, 3)];
  const { image, atlas } = buildSpriteSheet(mixed(), { ...base, trim: true, tags, splitTags: true, type: "rows" });
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [3, 0], [0, 5], [4, 5]]);
  assert.deepEqual([image.width, image.height], [5, 6]);
});

test("a columns sheet starts a new column where the tag changes, as wide as the widest cell of the column before", () => {
  const tags = [tag("a", 0, 1), tag("b", 2, 3)];
  const { image, atlas } = buildSpriteSheet(mixed(), { ...base, trim: true, tags, splitTags: true, type: "columns" });
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [0, 2], [3, 0], [3, 1]]);
  assert.deepEqual([image.width, image.height], [7, 7]);
});

test("a rows sheet starts a new row when overlapping tags repeat a frame", () => {
  const tags = [tag("a", 0, 1), tag("b", 1, 2)];
  const { atlas } = buildSpriteSheet(solids(3, 2, 2), { ...base, tags, splitTags: true, type: "rows" });
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [2, 0], [0, 2], [2, 2]]);
});

test("a packed sheet grows width and height alternately from the largest cell, width first", () => {
  const { image, atlas } = buildSpriteSheet(solids(4, 2, 2), { ...base, type: "packed" });
  assert.deepEqual([image.width, image.height], [4, 4]);
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [2, 0], [0, 2], [2, 2]]);
});

test("a packed sheet is the smallest rectangle around the placed cells, not a power of two", () => {
  const { image, atlas } = buildSpriteSheet(solids(5, 1, 1), { ...base, type: "packed" });
  assert.deepEqual([image.width, image.height], [3, 2]);
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]);
});

test("a packed sheet places larger cells first at the first free spot from the top left", () => {
  const frames = [
    frame(art(4, 2, RED, 0, 0, 1, 1)),
    frame(art(4, 2, BLUE, 0, 0, 3, 1)),
    frame(art(4, 2, GREEN, 0, 0, 2, 2)),
  ];
  const { image, atlas } = buildSpriteSheet(frames, { ...base, type: "packed", trim: true });
  assert.deepEqual([image.width, image.height], [6, 2]);
  assert.deepEqual(atlas.frames.map((f) => f.frame), [
    { x: 5, y: 0, w: 1, h: 1 },
    { x: 2, y: 0, w: 3, h: 1 },
    { x: 0, y: 0, w: 2, h: 2 },
  ]);
  assert.equal(px(image, 5, 0), RED);
  assert.equal(px(image, 3, 0), BLUE);
  assert.equal(px(image, 1, 1), GREEN);
  assert.equal(px(image, 2, 1), 0);
});

test("cells of equal area are placed in frame order when packing", () => {
  const frames = [frame(art(3, 3, RED, 0, 0, 2, 1)), frame(art(3, 3, BLUE, 0, 0, 1, 2))];
  const { atlas } = buildSpriteSheet(frames, { ...base, type: "packed", trim: true });
  assert.deepEqual(atlas.frames.map((f) => [f.frame.x, f.frame.y]), [[0, 0], [2, 0]]);
});

test("packing keeps the frames array in frame order", () => {
  const { atlas } = buildSpriteSheet(mixed(), { ...base, type: "packed", trim: true });
  assert.deepEqual(atlas.frames.map((f) => f.duration), [10, 20, 30, 40]);
});

test("a packed sheet places identical frames once and points both atlas entries at the same rectangle", () => {
  const frames = [frame(art(2, 2, RED), 1), frame(art(2, 2, BLUE), 2), frame(art(2, 2, RED), 3)];
  const { image, atlas } = buildSpriteSheet(frames, { ...base, type: "packed" });
  assert.deepEqual([image.width, image.height], [4, 2]);
  assert.deepEqual(atlas.frames[2]!.frame, atlas.frames[0]!.frame);
  assert.deepEqual(atlas.frames[2]!.frame, { x: 0, y: 0, w: 2, h: 2 });
  assert.deepEqual(atlas.frames[1]!.frame, { x: 2, y: 0, w: 2, h: 2 });
  assert.equal(atlas.frames[2]!.duration, 3);
  assert.equal(px(image, 0, 0), RED);
  assert.equal(px(image, 2, 0), BLUE);
});

test("a packed trimmed sheet places frames once when their cropped art is identical", () => {
  const frames = [frame(art(4, 4, RED, 0, 0, 1, 1)), frame(art(4, 4, RED, 2, 2, 1, 1))];
  const { image, atlas } = buildSpriteSheet(frames, { ...base, type: "packed", trim: true });
  assert.deepEqual([image.width, image.height], [1, 1]);
  assert.deepEqual(atlas.frames[1]!.frame, atlas.frames[0]!.frame);
  assert.deepEqual(atlas.frames[1]!.spriteSourceSize, { x: 2, y: 2, w: 1, h: 1 });
});

test("a packed sheet keeps frames apart when their uncropped art differs", () => {
  const frames = [frame(art(4, 4, RED, 0, 0, 1, 1)), frame(art(4, 4, RED, 2, 2, 1, 1))];
  const { atlas } = buildSpriteSheet(frames, { ...base, type: "packed" });
  assert.notDeepEqual(atlas.frames[1]!.frame, atlas.frames[0]!.frame);
});

test("inner padding gives each cell a transparent border and the atlas frame covers the padded cell", () => {
  const { image, atlas } = buildSpriteSheet([frame(art(2, 2, RED)), frame(art(2, 2, BLUE))], { ...base, innerPadding: 1 });
  assert.deepEqual([image.width, image.height], [8, 4]);
  assert.deepEqual(atlas.frames[1]!.frame, { x: 4, y: 0, w: 4, h: 4 });
  assert.deepEqual(atlas.frames[1]!.spriteSourceSize, { x: 0, y: 0, w: 2, h: 2 });
  assert.deepEqual(atlas.frames[1]!.sourceSize, { w: 2, h: 2 });
  assert.equal(px(image, 1, 1), RED);
  assert.equal(px(image, 2, 2), RED);
  assert.equal(px(image, 5, 1), BLUE);
  for (const [x, y] of [[0, 0], [1, 0], [3, 3], [0, 2], [3, 1], [4, 0], [4, 2], [7, 3], [6, 3]] as const) {
    assert.equal(px(image, x, y), 0, `pixel ${x},${y}`);
  }
});

test("inner padding is added around trimmed art and trimming is not affected by it", () => {
  const { image, atlas } = buildSpriteSheet([frame(art(6, 6, RED, 2, 3, 2, 1))], { ...base, innerPadding: 2, trim: true });
  assert.deepEqual([image.width, image.height], [6, 5]);
  assert.deepEqual(atlas.frames[0]!.frame, { x: 0, y: 0, w: 6, h: 5 });
  assert.deepEqual(atlas.frames[0]!.spriteSourceSize, { x: 2, y: 3, w: 2, h: 1 });
  assert.deepEqual(atlas.frames[0]!.sourceSize, { w: 6, h: 6 });
  assert.equal(px(image, 2, 2), RED);
  assert.equal(px(image, 3, 2), RED);
  assert.equal(px(image, 1, 2), 0);
  assert.equal(px(image, 4, 2), 0);
});

test("inner padding accepts integers from 0 to 100 and refuses anything else", () => {
  const f = [frame(art(1, 1, RED))];
  assert.equal(buildSpriteSheet(f, { ...base, innerPadding: 0 }).image.width, 1);
  assert.equal(buildSpriteSheet(f, { ...base, innerPadding: 100 }).image.width, 201);
  for (const bad of [-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildSpriteSheet(f, { ...base, innerPadding: bad }), RangeError, String(bad));
  }
});

test("trim crops to the opaque bounding box and records where it came from", () => {
  const img = art(8, 8, RED, 2, 3, 1, 1);
  img.pixels[5 * 8 + 4] = RED;
  const { image, atlas } = buildSpriteSheet([frame(img)], { ...base, trim: true });
  assert.deepEqual([image.width, image.height], [3, 3]);
  const f = atlas.frames[0]!;
  assert.equal(f.trimmed, true);
  assert.deepEqual(f.frame, { x: 0, y: 0, w: 3, h: 3 });
  assert.deepEqual(f.spriteSourceSize, { x: 2, y: 3, w: 3, h: 3 });
  assert.deepEqual(f.sourceSize, { w: 8, h: 8 });
  assert.equal(px(image, 0, 0), RED);
  assert.equal(px(image, 2, 2), RED);
  assert.equal(px(image, 1, 1), 0);
});

test("trim treats a pixel with alpha 0 as transparent whatever its colour and keeps faint pixels", () => {
  const img = art(4, 4, 0);
  img.pixels[0] = 0xff000000;
  img.pixels[3 * 4 + 3] = 0x00000001;
  const { atlas } = buildSpriteSheet([frame(img)], { ...base, trim: true });
  assert.deepEqual(atlas.frames[0]!.spriteSourceSize, { x: 3, y: 3, w: 1, h: 1 });
});

test("trimmed is false when the opaque box is the whole frame and without trim", () => {
  const trimmed = buildSpriteSheet([frame(art(4, 4, RED))], { ...base, trim: true });
  assert.equal(trimmed.atlas.frames[0]!.trimmed, false);
  assert.deepEqual(trimmed.atlas.frames[0]!.spriteSourceSize, { x: 0, y: 0, w: 4, h: 4 });
  const plain = buildSpriteSheet([frame(art(4, 4, RED, 1, 1, 1, 1))], base);
  assert.equal(plain.atlas.frames[0]!.trimmed, false);
  assert.deepEqual(plain.atlas.frames[0]!.spriteSourceSize, { x: 0, y: 0, w: 4, h: 4 });
});

test("a fully transparent frame stays as a 1x1 cell when trimming", () => {
  const { image, atlas } = buildSpriteSheet([frame(art(4, 4, RED)), frame(art(4, 4, 0))], { ...base, trim: true });
  const f = atlas.frames[1]!;
  assert.deepEqual(f.frame, { x: 4, y: 0, w: 1, h: 1 });
  assert.deepEqual(f.spriteSourceSize, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(f.sourceSize, { w: 4, h: 4 });
  assert.equal(f.trimmed, true);
  assert.deepEqual([image.width, image.height], [5, 4]);
  assert.equal(px(image, 4, 0), 0);
});

test("split tags emits each tag's frames in tag order and drops frames outside every tag", () => {
  const tags = [tag("run", 2, 3), tag("idle", 0, 0)];
  const { atlas } = buildSpriteSheet(solids(5, 2, 2), { ...base, tags, splitTags: true });
  assert.deepEqual(atlas.frames.map((f) => [f.filename, f.duration]), [
    ["walk #run 0.aseprite", 102],
    ["walk #run 1.aseprite", 103],
    ["walk #idle.aseprite", 100],
  ]);
});

test("split tags emits a frame once per overlapping tag", () => {
  const tags = [tag("a", 0, 1), tag("b", 1, 2)];
  const { atlas } = buildSpriteSheet(solids(4, 2, 2), { ...base, tags, splitTags: true });
  assert.deepEqual(atlas.frames.map((f) => [f.filename, f.duration]), [
    ["walk #a 0.aseprite", 100],
    ["walk #a 1.aseprite", 101],
    ["walk #b 0.aseprite", 101],
    ["walk #b 1.aseprite", 102],
  ]);
});

test("split tags without any tag writes every frame untagged", () => {
  const { atlas } = buildSpriteSheet(solids(3, 2, 2), { ...base, splitTags: true });
  assert.deepEqual(atlas.frames.map((f) => f.filename), ["walk 0.aseprite", "walk 1.aseprite", "walk 2.aseprite"]);
});

test("tags without split tags still describe the tags but write every frame under the sprite's name", () => {
  const { atlas } = buildSpriteSheet(solids(3, 2, 2), { ...base, tags: [tag("a", 0, 0)] });
  assert.deepEqual(atlas.frames.map((f) => f.filename), ["walk 0.aseprite", "walk 1.aseprite", "walk 2.aseprite"]);
  assert.equal(atlas.meta.frameTags.length, 1);
});

test("a sheet of one frame names it without a number", () => {
  const { atlas } = buildSpriteSheet(solids(1, 2, 2), base);
  assert.equal(atlas.frames[0]!.filename, "walk.aseprite");
});

test("frame numbers count from 0 within each tag", () => {
  const { atlas } = buildSpriteSheet(solids(4, 2, 2), { ...base, tags: [tag("run", 1, 3)], splitTags: true });
  assert.deepEqual(atlas.frames.map((f) => f.filename), ["walk #run 0.aseprite", "walk #run 1.aseprite", "walk #run 2.aseprite"]);
});

test("the atlas has frames then meta, and each frame lists its keys in Aseprite's order", () => {
  const { atlas } = buildSpriteSheet(solids(2, 2, 2), base);
  assert.deepEqual(Object.keys(atlas), ["frames", "meta"]);
  assert.deepEqual(Object.keys(atlas.frames[0]!), [
    "filename",
    "frame",
    "rotated",
    "trimmed",
    "spriteSourceSize",
    "sourceSize",
    "duration",
  ]);
  assert.equal(atlas.frames[0]!.rotated, false);
});

test("meta lists its keys in Aseprite's order, with image only when an image name is given", () => {
  const withImage = buildSpriteSheet(solids(2, 2, 2), { ...base, imageName: "walk.png" }).atlas.meta;
  assert.deepEqual(Object.keys(withImage), ["app", "version", "image", "format", "size", "scale", "frameTags", "layers", "slices"]);
  assert.equal(withImage.image, "walk.png");
  const without = buildSpriteSheet(solids(2, 2, 2), base).atlas.meta;
  assert.deepEqual(Object.keys(without), ["app", "version", "format", "size", "scale", "frameTags", "layers", "slices"]);
  assert.equal(without.app, "test-app");
  assert.equal(without.version, "1.2.3");
  assert.equal(without.format, "RGBA8888");
  assert.equal(without.scale, "1");
  assert.deepEqual(without.slices, []);
  assert.deepEqual(without.frameTags, []);
  assert.deepEqual(without.layers, []);
});

test("frame tags list name, from, to and direction, plus repeat as a string when above 0 and colour when visible", () => {
  const tags = [
    tag("plain", 0, 0),
    tag("loop", 0, 1, { direction: "pingpong", repeat: 3, color: 0xaabbccdd }),
    tag("clear", 1, 1, { color: 0x0000ff00 }),
    tag("dim", 1, 1, { color: 0x0a0b0c01 }),
  ];
  const { frameTags } = buildSpriteSheet(solids(2, 2, 2), { ...base, tags }).atlas.meta;
  assert.deepEqual(Object.keys(frameTags[0]!), ["name", "from", "to", "direction"]);
  assert.deepEqual(frameTags[0], { name: "plain", from: 0, to: 0, direction: "forward" });
  assert.deepEqual(frameTags[1], { name: "loop", from: 0, to: 1, direction: "pingpong", repeat: "3", color: "#aabbccdd" });
  assert.deepEqual(Object.keys(frameTags[1]!), ["name", "from", "to", "direction", "repeat", "color"]);
  assert.deepEqual(frameTags[2], { name: "clear", from: 1, to: 1, direction: "forward" });
  assert.equal(frameTags[3]!.color, "#0a0b0c01");
});

test("layers are listed with name, opacity and a normal blend mode", () => {
  const layers = [{ name: "body", opacity: 255 }, { name: "shade", opacity: 128 }];
  const { atlas } = buildSpriteSheet(solids(1, 2, 2), { ...base, layers });
  assert.deepEqual(atlas.meta.layers, [
    { name: "body", opacity: 255, blendMode: "normal" },
    { name: "shade", opacity: 128, blendMode: "normal" },
  ]);
  assert.deepEqual(Object.keys(atlas.meta.layers[0]!), ["name", "opacity", "blendMode"]);
});

test("the texture holds each frame's pixels at its atlas rectangle and leaves the rest transparent", () => {
  const { image, atlas } = buildSpriteSheet(mixed(), { ...base, trim: true });
  assert.equal(px(image, 0, 0), RED);
  assert.equal(px(image, 2, 1), RED);
  assert.equal(px(image, 0, 2), 0);
  assert.equal(px(image, 3, 4), BLUE);
  assert.equal(px(image, 5, 0), GREEN);
  assert.equal(px(image, 9, 0), YELLOW);
  assert.equal(px(image, 9, 1), 0);
  assert.equal(atlas.frames[3]!.trimmed, true);
});

test("a sheet is refused for no frames, frames of different sizes, and tags outside the frames", () => {
  assert.throws(() => buildSpriteSheet([], base), RangeError);
  assert.throws(() => buildSpriteSheet([...solids(1, 4, 4), ...solids(1, 5, 4)], base), RangeError);
  assert.throws(() => buildSpriteSheet([...solids(1, 4, 4), ...solids(1, 4, 5)], base), RangeError);
  for (const bad of [tag("x", 2, 1), tag("x", -1, 0), tag("x", 0, 2), tag("x", 2, 2)]) {
    assert.throws(() => buildSpriteSheet(solids(2, 2, 2), { ...base, tags: [bad] }), RangeError, `${bad.from}..${bad.to}`);
  }
});

test("frame file names count {frame} from 0", () => {
  assert.deepEqual(frameFileNames("w_{frame}.png", 3), ["w_0.png", "w_1.png", "w_2.png"]);
  assert.deepEqual(frameFileNames("w_{frame}.png", 1), ["w_0.png"]);
});

test("frame file names count {frameNN} from NN, zero-padded to the characters after frame", () => {
  assert.deepEqual(frameFileNames("w{frame1}.png", 3), ["w1.png", "w2.png", "w3.png"]);
  assert.deepEqual(frameFileNames("w{frame01}.png", 2), ["w01.png", "w02.png"]);
  assert.deepEqual(frameFileNames("w{frame00}.png", 2), ["w00.png", "w01.png"]);
  assert.deepEqual(frameFileNames("w{frame10}.png", 2), ["w10.png", "w11.png"]);
  assert.deepEqual(frameFileNames("w{frame05}.png", 6).slice(4), ["w09.png", "w10.png"]);
});

test("frame file names replace every {frame} in the path", () => {
  assert.deepEqual(frameFileNames("{frame}/w_{frame}.png", 2), ["0/w_0.png", "1/w_1.png"]);
  assert.deepEqual(frameFileNames("{frame01}/w_{frame01}.png", 2), ["01/w_01.png", "02/w_02.png"]);
});

test("a single frame without {frame} keeps the path as it is", () => {
  assert.deepEqual(frameFileNames("walk.png", 1), ["walk.png"]);
  assert.deepEqual(frameFileNames("walk03.png", 1), ["walk03.png"]);
});

test("without {frame}, a number ending the name sets the first number and width", () => {
  assert.deepEqual(frameFileNames("walk03.png", 3), ["walk03.png", "walk04.png", "walk05.png"]);
  assert.deepEqual(frameFileNames("walk9.png", 2), ["walk9.png", "walk10.png"]);
  assert.deepEqual(frameFileNames("walk007", 2), ["walk007", "walk008"]);
});

test("without {frame} or a trailing number, frames count from 1 after the name", () => {
  assert.deepEqual(frameFileNames("walk.png", 2), ["walk1.png", "walk2.png"]);
  assert.deepEqual(frameFileNames("walk", 2), ["walk1", "walk2"]);
  assert.deepEqual(frameFileNames("walk3x.png", 2), ["walk3x1.png", "walk3x2.png"]);
});

test("digits and dots in directory names do not affect the numbering", () => {
  assert.deepEqual(frameFileNames("dir.v2/walk", 2), ["dir.v2/walk1", "dir.v2/walk2"]);
  assert.deepEqual(frameFileNames("dir2/walk.png", 2), ["dir2/walk1.png", "dir2/walk2.png"]);
  assert.deepEqual(frameFileNames("d.1/walk02.png", 2), ["d.1/walk02.png", "d.1/walk03.png"]);
  assert.deepEqual(frameFileNames("a1\\b.v2\\walk", 2), ["a1\\b.v2\\walk1", "a1\\b.v2\\walk2"]);
});

test("frame file names refuse a frame count that is not a positive integer", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => frameFileNames("w{frame}.png", bad), RangeError, String(bad));
  }
});

test("a source with no extension names frames without a trailing dot", () => {
  const sheet = buildSpriteSheet([frame(art(1, 1, RED)), frame(art(1, 1, BLUE))], { ...base, title: "Sprite", extension: "" });
  assert.deepEqual(sheet.atlas.frames.map((f) => f.filename), ["Sprite 0", "Sprite 1"]);
});
