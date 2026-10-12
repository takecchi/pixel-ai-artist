import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { encodeGif, decodeGif } from "../dist/lib/gif.js";
import { decodePng, encodePng } from "../dist/lib/png.js";

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

const manage = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("sprite.manage", args);

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

const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);

function writePng(file: string, image: Image) {
  writeFileSync(file, encodePng(image));
  return file;
}

/** A new 2x1 RGB sprite whose only cel holds `pixels`, in a studio of its own. */
async function drawn(pixels: number[], width = 2, height = 1) {
  const studio = createStudio();
  await manage(studio, { op: "new", width, height });
  const sprite = studio.activeSprite()!;
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = img(width, height, pixels);
  return { studio, sprite };
}

// ── open ────────────────────────────────────────────────────────────────

test("open reads a PNG as an unmodified one-layer, one-frame RGB sprite and makes it active", async () => {
  await inTempDir(async (dir) => {
    const file = writePng(path.join(dir, "hero.png"), img(2, 2, [RED, GREEN, BLUE, rgba(9, 8, 7, 128)]));
    const studio = createStudio();
    await manage(studio, { op: "new", width: 1, height: 1 });
    const opened = await manage(studio, { op: "open", path: file });
    assert.deepEqual(opened, { sprite: "hero.png", id: opened.id, width: 2, height: 2 });
    const sprite = studio.activeSprite()!;
    assert.equal(sprite.id, opened.id);
    assert.equal(studio.sprites().length, 2);
    assert.deepEqual([sprite.colorMode, sprite.layers.length, sprite.frames.length], ["rgb", 1, 1]);
    assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [RED, GREEN, BLUE, rgba(9, 8, 7, 128)]);
    assert.equal(sprite.modified, false);
    const info = await studio.call<Reply>("sprite.info");
    assert.equal(info.filename, file);
    assert.ok(path.isAbsolute(info.filename));
  });
});

test("open answers the file's pixels through pixels.read", async () => {
  await inTempDir(async (dir) => {
    const file = writePng(path.join(dir, "px.png"), img(2, 1, [RED, BLUE]));
    const studio = createStudio();
    await manage(studio, { op: "open", path: file });
    const read = await studio.call<Reply>("pixels.read", { x: 1, y: 0 });
    assert.match(JSON.stringify(read).toLowerCase(), /0000ff/);
  });
});

test("open resolves a relative path against the working directory and reports it absolute", async () => {
  await inTempDir(async (dir) => {
    const file = writePng(path.join(dir, "rel.png"), img(1, 1, [RED]));
    const relative = path.relative(process.cwd(), file);
    const studio = createStudio();
    await manage(studio, { op: "open", path: relative });
    assert.equal(studio.activeSprite()!.filename, file);
  });
});

test("open keeps an animated GIF's frame count and durations, and gives a zero delay 100 ms", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "walk.gif");
    const bytes = encodeGif([
      { image: img(2, 1, [RED, BLUE]), durationMs: 40 },
      { image: img(2, 1, [BLUE, RED]), durationMs: 100 },
      { image: img(2, 1, [GREEN, GREEN]), durationMs: 250 },
    ]);
    // encodeGif rounds a zero delay up to 10 ms, so the second frame's delay is zeroed in the bytes.
    const controls = [...bytes.keys()].filter((i) => bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4);
    assert.equal(controls.length, 3);
    bytes[controls[1]! + 4] = 0;
    bytes[controls[1]! + 5] = 0;
    writeFileSync(file, bytes);
    const studio = createStudio();
    const opened = await manage(studio, { op: "open", path: file });
    assert.equal(opened.sprite, "walk.gif");
    const sprite = studio.activeSprite()!;
    assert.deepEqual(sprite.frames.map((f) => f.durationMs), [40, 100, 250]);
    const cels = sprite.layers[0]!.cels;
    assert.deepEqual([...cels.keys()], [1, 2, 3]);
    assert.deepEqual([...cels.get(2)!.image.pixels], [BLUE, RED]);
    assert.deepEqual((await studio.call<Reply>("sprite.info")).frames.map((f: Reply) => f.durationMs), [40, 100, 250]);
  });
});

test("open reads a JPEG as an RGB sprite", async () => {
  const studio = createStudio();
  const jpg = fileURLPath("./fixtures/jpeg/baseline-444.jpg");
  const expected = readPng(fileURLPath("./fixtures/jpeg/baseline-444.png"));
  const opened = await manage(studio, { op: "open", path: jpg });
  assert.equal(opened.sprite, "baseline-444.jpg");
  assert.deepEqual([opened.width, opened.height], [expected.width, expected.height]);
  const sprite = studio.activeSprite()!;
  assert.deepEqual([sprite.colorMode, sprite.layers.length, sprite.frames.length], ["rgb", 1, 1]);
});

function fileURLPath(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

test("open tells the format by content, not by extension", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "really-a-png.gif");
    writeFileSync(file, encodePng(img(1, 2, [RED, GREEN])));
    const studio = createStudio();
    const opened = await manage(studio, { op: "open", path: file });
    assert.deepEqual([opened.width, opened.height], [1, 2]);
    assert.deepEqual([...studio.activeSprite()!.layers[0]!.cels.get(1)!.image.pixels], [RED, GREEN]);
  });
});

test("open takes the image's opaque colours as the palette, in order of first appearance, at full alpha", async () => {
  await inTempDir(async (dir) => {
    const file = writePng(
      path.join(dir, "few.png"),
      img(3, 2, [BLUE, 0, RED, BLUE, rgba(0, 255, 0, 90), RED]),
    );
    const studio = createStudio();
    await manage(studio, { op: "open", path: file });
    // A translucent pixel counts by its colour, with the alpha set to 255.
    assert.deepEqual(studio.activeSprite()!.palette, [BLUE, RED, GREEN]);
  });
});

test("open keeps the DawnBringer 32 palette for an image of more than 256 colours", async () => {
  await inTempDir(async (dir) => {
    const colours = Array.from({ length: 257 }, (_, i) => rgba(i >> 4, i & 15, 7));
    const many = writePng(path.join(dir, "many.png"), img(257, 1, colours));
    const exactly256 = writePng(path.join(dir, "exact.png"), img(256, 1, colours.slice(0, 256)));
    const studio = createStudio();
    await manage(studio, { op: "open", path: many });
    const info = await studio.call<Reply>("sprite.info");
    assert.equal(info.palette.length, 32);
    assert.deepEqual(info.palette.slice(0, 3), ["#000000", "#222034", "#45283c"]);
    await manage(studio, { op: "open", path: exactly256 });
    assert.deepEqual(studio.activeSprite()!.palette, colours.slice(0, 256));
  });
});

test("open gives a fully transparent image the DawnBringer 32 palette", async () => {
  await inTempDir(async (dir) => {
    const file = writePng(path.join(dir, "empty.png"), img(2, 2, [0, 0, 0, 0]));
    const studio = createStudio();
    await manage(studio, { op: "open", path: file });
    const info = await studio.call<Reply>("sprite.info");
    assert.equal(info.palette.length, 32);
    assert.deepEqual(info.palette.slice(0, 3), ["#000000", "#222034", "#45283c"]);
  });
});

test("open answers io_error for a missing file or one that is not an image, and opens nothing", async () => {
  await inTempDir(async (dir) => {
    const text = path.join(dir, "notes.png");
    writeFileSync(text, "this is not an image");
    const studio = createStudio();
    await rejectsWith(manage(studio, { op: "open", path: path.join(dir, "absent.png") }), "io_error");
    await rejectsWith(manage(studio, { op: "open", path: text }), "io_error");
    assert.equal(studio.sprites().length, 0);
  });
});

test("open answers unsupported_command for an .aseprite file, whatever its name, and opens nothing", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "art.png");
    const header = new Uint8Array(128);
    header[4] = 0xe0;
    header[5] = 0xa5;
    writeFileSync(file, header);
    const studio = createStudio();
    await rejectsWith(manage(studio, { op: "open", path: file }), "unsupported_command", /aseprite/i);
    assert.equal(studio.sprites().length, 0);
  });
});

test("open and save_as without a path are invalid_args", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 1, height: 1 });
  await rejectsWith(manage(studio, { op: "open" }), "invalid_args", /'path'/);
  await rejectsWith(manage(studio, { op: "save_as" }), "invalid_args", /'path'/);
  assert.equal(studio.sprites().length, 1);
});

// ── save_as ─────────────────────────────────────────────────────────────

test("save_as .png writes the visible layers composited as RGBA and leaves the hidden ones out", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([RED, 0]);
    const top = studio.addLayer(sprite, "Top");
    studio.ensureCel(sprite, top, 1).image = img(2, 1, [0, rgba(0, 0, 255, 255)]);
    const hidden = studio.addLayer(sprite, "Hidden");
    hidden.visible = false;
    studio.ensureCel(sprite, hidden, 1).image = img(2, 1, [GREEN, GREEN]);
    const file = path.join(dir, "out.png");
    const reply = await manage(studio, { op: "save_as", path: file });
    assert.deepEqual(reply, { sprite: "out.png", id: sprite.id, path: file });
    const written = readPng(file);
    assert.deepEqual([written.width, written.height], [2, 1]);
    assert.deepEqual([...written.pixels], [RED, BLUE]);
    assert.equal(sprite.filename, file);
    assert.equal(sprite.modified, false);
  });
});

test("save_as answers an absolute path for a relative one", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([RED, GREEN]);
    const file = path.join(dir, "rel.png");
    const reply = await manage(studio, { op: "save_as", path: path.relative(process.cwd(), file) });
    assert.equal(reply.path, file);
    assert.equal(sprite.filename, file);
    assert.ok(existsSync(file));
  });
});

test("save_as .png of a three-frame sprite writes one numbered file per frame, as Aseprite names them", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([RED, RED]);
    sprite.frames = [{ durationMs: 100 }, { durationMs: 100 }, { durationMs: 100 }];
    const cels = sprite.layers[0]!.cels;
    cels.set(2, { x: 0, y: 0, image: img(2, 1, [GREEN, GREEN]), opacity: 255 });
    cels.set(3, { x: 0, y: 0, image: img(2, 1, [BLUE, BLUE]), opacity: 255 });

    await manage(studio, { op: "save_as", path: path.join(dir, "walk.png") });
    assert.equal(existsSync(path.join(dir, "walk.png")), false);
    const numbered = [1, 2, 3].map((n) => readPng(path.join(dir, `walk${n}.png`)).get(0, 0));
    assert.deepEqual(numbered, [RED, GREEN, BLUE]);

    await manage(studio, { op: "save_as", path: path.join(dir, "run_{frame}.png") });
    const zeroBased = [0, 1, 2].map((n) => readPng(path.join(dir, `run_${n}.png`)).get(0, 0));
    assert.deepEqual(zeroBased, [RED, GREEN, BLUE]);
  });
});

test("save_as .gif writes every frame with its duration", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([RED, BLUE]);
    sprite.palette = [RED, GREEN, BLUE];
    sprite.frames = [{ durationMs: 60 }, { durationMs: 200 }];
    sprite.layers[0]!.cels.set(2, { x: 0, y: 0, image: img(2, 1, [BLUE, RED]), opacity: 255 });
    const file = path.join(dir, "anim.gif");
    const reply = await manage(studio, { op: "save_as", path: file });
    assert.deepEqual(reply, { sprite: "anim.gif", id: sprite.id, path: file });
    const gif = readGif(file);
    assert.deepEqual(gif.frames.map((f) => f.durationMs), [60, 200]);
    assert.deepEqual(gif.frames.map((f) => [...f.image.pixels]), [[RED, BLUE], [BLUE, RED]]);
    assert.equal(sprite.filename, file);
    assert.equal(sprite.modified, false);
  });
});

test("save_as .gif moves a colour that is not in the sprite's palette to the nearest palette colour", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([rgba(250, 10, 10), rgba(20, 20, 240)]);
    sprite.palette = [rgba(0, 0, 0), rgba(255, 0, 0), rgba(0, 0, 255)];
    const file = path.join(dir, "snap.gif");
    await manage(studio, { op: "save_as", path: file });
    assert.deepEqual([...readGif(file).frames[0]!.image.pixels], [RED, BLUE]);
  });
});

test("save_as creates the missing directories of the path", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await drawn([RED, GREEN]);
    const file = path.join(dir, "a", "b", "deep.png");
    await manage(studio, { op: "save_as", path: file });
    assert.deepEqual([...readPng(file).pixels], [RED, GREEN]);
  });
});

test("save_as of .jpg, .aseprite or no extension answers unsupported_command, writes nothing and keeps the filename", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([RED, GREEN]);
    for (const name of ["x.jpg", "x.aseprite", "x"]) {
      await rejectsWith(manage(studio, { op: "save_as", path: path.join(dir, name) }), "unsupported_command");
      assert.equal(existsSync(path.join(dir, name)), false, name);
      assert.equal(sprite.filename, null, name);
    }
    const kept = path.join(dir, "kept.png");
    await manage(studio, { op: "save_as", path: kept });
    await rejectsWith(manage(studio, { op: "save_as", path: path.join(dir, "x.jpg") }), "unsupported_command");
    assert.equal(sprite.filename, kept);
  });
});

// ── save ────────────────────────────────────────────────────────────────

test("save of a sprite that was never saved is invalid_args and points at save_as", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 1, height: 1 });
  await rejectsWith(manage(studio, { op: "save" }), "invalid_args", /save_as/);
});

test("save writes an opened sprite's new pixels back over its file and clears modified", async () => {
  await inTempDir(async (dir) => {
    const file = writePng(path.join(dir, "edit.png"), img(2, 1, [RED, GREEN]));
    const studio = createStudio();
    await manage(studio, { op: "open", path: file });
    const sprite = studio.activeSprite()!;
    sprite.layers[0]!.cels.get(1)!.image.set(1, 0, BLUE);
    sprite.modified = true;
    const reply = await manage(studio, { op: "save" });
    assert.deepEqual(reply, { sprite: "edit.png", id: sprite.id, path: file });
    assert.deepEqual([...readPng(file).pixels], [RED, BLUE]);
    assert.equal(sprite.modified, false);
  });
});

test("save after save_as overwrites that file with what was drawn since", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await drawn([RED, GREEN]);
    const file = path.join(dir, "again.png");
    await manage(studio, { op: "save_as", path: file });
    sprite.layers[0]!.cels.get(1)!.image.set(0, 0, BLUE);
    sprite.modified = true;
    const reply = await manage(studio, { op: "save" });
    assert.equal(reply.path, file);
    assert.deepEqual([...readPng(file).pixels], [BLUE, GREEN]);
    assert.equal(sprite.modified, false);
  });
});
