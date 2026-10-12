import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { encodePng } from "../dist/lib/png.js";

type Reply = Record<string, any>;

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

const scratch = mkdtempSync(path.join(tmpdir(), "pixel-ai-artist-reference-"));
const RED = rgba(255, 0, 77);
const BLUE = rgba(41, 173, 255);

/** Writes a PNG of `rows` (one RGBA number per pixel) and returns its path. */
function png(name: string, rows: number[][]): string {
  const img = Image.from(rows[0]!.length, rows.length, new Uint32Array(rows.flat()));
  const file = path.join(scratch, name);
  writeFileSync(file, encodePng(img));
  return file;
}

function setup(width = 4, height = 4, frames = 1) {
  const studio = createStudio();
  const sprite = studio.addSprite({ width, height });
  sprite.frames = Array.from({ length: frames }, () => ({ durationMs: 100 }));
  sprite.modified = false;
  return { studio, sprite };
}

const apply = (studio: ReturnType<typeof createStudio>, args: Record<string, unknown>) => studio.call<Reply>("reference.apply", args);

test("import scales the image to fit the canvas onto a new locked, half-transparent layer on top", async () => {
  const { studio, sprite } = setup(4, 4);
  const file = png("two.png", [[RED, BLUE]]);
  const reply = await apply(studio, { op: "import", path: file });
  assert.deepEqual(reply, { sprite: "Sprite", op: "import", layer: "reference", width: 4, height: 2, panels: 1, frames: [1] });
  const layer = sprite.layers.at(-1)!;
  assert.deepEqual([layer.name, layer.opacity, layer.editable], ["reference", 128, false]);
  const cel = layer.cels.get(1)!;
  assert.deepEqual([cel.x, cel.y, cel.image.width, cel.image.height], [0, 0, 4, 2]);
  assert.deepEqual([...cel.image.pixels], [RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE]);
  assert.equal(sprite.modified, true);
});

test("import leaves the layer tools draw on as it was", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "import", path: png("one.png", [[RED]]) });
  assert.equal((await studio.call<Reply>("sprite.info")).activeLayer, "Layer 1");
  assert.equal(sprite.layers.length, 2);
});

test("fit none keeps the source size, cover fills the canvas, stretch matches it exactly", async () => {
  const file = png("wide.png", [[RED, BLUE]]);
  for (const [fit, size] of [["none", [2, 1]], ["cover", [8, 4]], ["stretch", [4, 4]]] as const) {
    const { studio } = setup(4, 4);
    const reply = await apply(studio, { op: "import", path: file, fit, name: `reference ${fit}` });
    assert.deepEqual([reply.width, reply.height], size, fit);
  }
});

test("name, opacity and x/y place and label the reference", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "import", path: png("dot.png", [[RED]]), fit: "none", name: "reference pose", opacity: 60, x: 2, y: 1 });
  const layer = sprite.layers.at(-1)!;
  assert.deepEqual([layer.name, layer.opacity, layer.cels.get(1)!.x, layer.cels.get(1)!.y], ["reference pose", 60, 2, 1]);
});

test("a region takes one panel of the source, and one off the image is refused", async () => {
  const { studio, sprite } = setup(2, 2);
  const file = png("sheet.png", [[RED, BLUE]]);
  const reply = await apply(studio, { op: "import", path: file, region: { x: 1, y: 0, width: 1, height: 1 }, fit: "none" });
  assert.deepEqual([reply.width, reply.height], [1, 1]);
  assert.equal(sprite.layers.at(-1)!.cels.get(1)!.image.get(0, 0), BLUE);
  await rejectsWith(apply(studio, { op: "import", path: file, region: { x: 1, y: 0, width: 2, height: 1 } }), "invalid_args", /outside the 2x1 source image/);
});

test("grid cuts a storyboard into panels, row by row, one per frame from frame 1", async () => {
  const { studio, sprite } = setup(1, 1, 3);
  const file = png("board.png", [
    [RED, 0, BLUE],
    [0, 0, 0],
    [BLUE, 0, RED],
  ]);
  const reply = await apply(studio, { op: "import", path: file, grid: { columns: 2, rows: 2, gap: 1, count: 3 }, fit: "none" });
  assert.deepEqual([reply.panels, reply.frames, reply.width, reply.height], [3, [1, 2, 3], 1, 1]);
  const cels = sprite.layers.at(-1)!.cels;
  assert.deepEqual([1, 2, 3].map((f) => cels.get(f)!.image.get(0, 0)), [RED, BLUE, BLUE]);
});

test("a grid with more panels than the sprite has frames is refused, naming the fix", async () => {
  const { studio, sprite } = setup(1, 1, 1);
  const file = png("board2.png", [[RED, BLUE]]);
  await rejectsWith(apply(studio, { op: "import", path: file, grid: { columns: 2, rows: 1 } }), "invalid_args", /frame op 'add'/);
  await rejectsWith(apply(studio, { op: "import", path: file, grid: { columns: 3, rows: 1, gap: 1 } }), "invalid_args", /does not fit/);
  await rejectsWith(apply(studio, { op: "import", path: file, grid: { rows: 1 } }), "invalid_args", /'grid.columns'/);
  assert.equal(sprite.layers.length, 1);
});

test("importing into an indexed sprite paints with its nearest palette entries", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1, colorMode: "indexed", palette: [rgba(0, 0, 0), RED, BLUE] });
  await apply(studio, { op: "import", path: png("idx.png", [[rgba(250, 5, 80), 0]]), fit: "none" });
  assert.deepEqual([...sprite.layers.at(-1)!.cels.get(1)!.image.pixels], [1, 0]);
});

test("sample_palette reports the source's most common colours with their share, importing nothing", async () => {
  const { studio, sprite } = setup();
  const file = png("sample.png", [[RED, RED, BLUE, 0]]);
  const reply = await apply(studio, { op: "sample_palette", path: file });
  assert.deepEqual(reply, {
    sprite: "Sprite",
    op: "sample_palette",
    palette: [
      { hex: "#ff004d", share: 0.667 },
      { hex: "#29adff", share: 0.333 },
    ],
    width: 4,
    height: 1,
  });
  assert.equal((await apply(studio, { op: "sample_palette", path: file, colors: 1 })).palette.length, 1);
  assert.equal(sprite.layers.length, 1);
  assert.equal(sprite.modified, false);
});

test("list names the imported reference layers, and remove deletes one", async () => {
  const { studio, sprite } = setup();
  const file = png("l.png", [[RED]]);
  await apply(studio, { op: "import", path: file });
  await apply(studio, { op: "import", path: file, name: "reference 2" });
  studio.addLayer(sprite, "ink");
  assert.deepEqual((await apply(studio, { op: "list" })).references, ["reference", "reference 2"]);
  await apply(studio, { op: "remove" });
  assert.deepEqual(sprite.layers.map((l) => l.name), ["Layer 1", "reference 2", "ink"]);
  await apply(studio, { op: "remove", name: "reference 2" });
  assert.deepEqual((await apply(studio, { op: "list" })).references, []);
});

test("list shows a reference imported under any name, and not a layer that merely starts with 'reference'", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "import", path: png("n.png", [[RED]]), name: "concept sheet" });
  studio.addLayer(sprite, "reference notes");
  assert.deepEqual((await apply(studio, { op: "list" })).references, ["concept sheet"]);
});

test("remove refuses a layer that is not a reference, pointing at list, and keeps it", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "ink");
  await rejectsWith(apply(studio, { op: "remove", name: "ink" }), "invalid_args", /'ink' is not a reference layer.*reference op="list"/);
  assert.deepEqual(sprite.layers.map((l) => l.name), ["Layer 1", "ink"]);
});

test("importing under a name a layer already has takes the next free ' 2', ' 3' and reports it", async () => {
  const { studio, sprite } = setup();
  const file = png("twice.png", [[RED]]);
  await apply(studio, { op: "import", path: file });
  assert.equal((await apply(studio, { op: "import", path: file })).layer, "reference 2");
  assert.equal((await apply(studio, { op: "import", path: file })).layer, "reference 3");
  assert.deepEqual(sprite.layers.map((l) => l.name), ["Layer 1", "reference", "reference 2", "reference 3"]);
});

test("a duplicated reference layer is still a reference", async () => {
  const { studio, sprite } = setup();
  await apply(studio, { op: "import", path: png("d.png", [[RED]]), name: "pose" });
  await studio.call("layer.apply", { op: "duplicate", name: "pose" });
  assert.deepEqual((await apply(studio, { op: "list" })).references, ["pose", "pose Copy"]);
  assert.equal(sprite.layers.length, 3);
});

test("an unreadable file is io_error, and import and sample_palette need a path", async () => {
  const { studio } = setup();
  await rejectsWith(apply(studio, { op: "import", path: path.join(scratch, "missing.png") }), "io_error", /missing\.png/);
  await rejectsWith(apply(studio, { op: "sample_palette" }), "invalid_args", /'path'/);
});

test("an unknown op answers unsupported_command and imports nothing", async () => {
  const { studio, sprite } = setup();
  await rejectsWith(apply(studio, { op: "trace", path: png("q.png", [[RED]]) }), "unsupported_command", /'trace'/);
  assert.equal(sprite.layers.length, 1);
  assert.equal(sprite.modified, false);
});
