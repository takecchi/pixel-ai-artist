import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { encodePng } from "../dist/lib/png.js";

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

const load = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("palette.load", args);

async function newSprite(colorMode: "rgb" | "indexed" = "rgb") {
  const studio = createStudio();
  await studio.call("sprite.manage", { op: "new", width: 2, height: 1, colorMode });
  return { studio, sprite: studio.activeSprite()! };
}

const RED = rgba(255, 0, 0);
const BLUE = rgba(0, 0, 255);

test("palette.load replaces the whole palette with the file's colours and answers them as hex", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "two.hex");
    writeFileSync(file, "ff0000\n0000ff\n");
    const { studio, sprite } = await newSprite();
    const reply = await load(studio, { path: file });
    assert.deepEqual(reply, { sprite: "Sprite", colors: ["#ff0000", "#0000ff"], size: 2, path: file });
    assert.deepEqual(sprite.palette, [RED, BLUE]);
    assert.equal(sprite.modified, true);
  });
});

test("palette.load answers a colour with alpha as #rrggbbaa", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "alpha.gpl");
    writeFileSync(file, "GIMP Palette\nChannels: RGBA\n#\n255 0 0 128 Half\n");
    const { studio } = await newSprite();
    assert.deepEqual((await load(studio, { path: file })).colors, ["#ff000080"]);
  });
});

test("palette.load answers the path as it was given, relative or not", async () => {
  await inTempDir(async (dir) => {
    writeFileSync(path.join(dir, "p.hex"), "ff0000\n");
    const relative = path.relative(process.cwd(), path.join(dir, "p.hex"));
    const { studio } = await newSprite();
    assert.equal((await load(studio, { path: relative })).path, relative);
  });
});

test("palette.load keeps an indexed sprite's pixel indices, so its colours change", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "new.hex");
    writeFileSync(file, "00ff00\nffff00\n");
    const { studio, sprite } = await newSprite("indexed");
    const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
    cel.image = Image.from(2, 1, new Uint32Array([1, 0]));
    sprite.transparentIndex = 5;
    await load(studio, { path: file });
    assert.deepEqual([...cel.image.pixels], [1, 0]);
    assert.deepEqual(sprite.palette, [rgba(0, 255, 0), rgba(255, 255, 0)]);
  });
});

test("palette.load reads a png file's colours", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "ref.png");
    writeFileSync(file, encodePng(Image.from(2, 1, new Uint32Array([RED, BLUE]))));
    const { studio, sprite } = await newSprite();
    await load(studio, { path: file });
    assert.deepEqual(sprite.palette, [RED, BLUE]);
  });
});

test("palette.load works on the sprite it is told, not the active one", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "p.hex");
    writeFileSync(file, "ff0000\n");
    const { studio, sprite: first } = await newSprite();
    await studio.call("sprite.manage", { op: "new", width: 1, height: 1 });
    const second = studio.activeSprite()!;
    const secondBefore = [...second.palette];
    const reply = await load(studio, { path: file, sprite: `#${first.id}` });
    assert.equal(reply.size, 1);
    assert.deepEqual(first.palette, [RED]);
    assert.deepEqual(second.palette, secondBefore);
  });
});

test("palette.load without a path is invalid_args and leaves the palette", async () => {
  const { studio, sprite } = await newSprite();
  const before = [...sprite.palette];
  await rejectsWith(load(studio, {}), "invalid_args", /'path'/);
  assert.deepEqual(sprite.palette, before);
  assert.equal(sprite.modified, false);
});

test("palette.load of a missing file is io_error and leaves the palette", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await newSprite();
    const before = [...sprite.palette];
    await rejectsWith(load(studio, { path: path.join(dir, "absent.gpl") }), "io_error");
    assert.deepEqual(sprite.palette, before);
    assert.equal(sprite.modified, false);
  });
});

test("palette.load of a file with no readable colours is io_error with Aseprite's message, and leaves the palette", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await newSprite();
    const before = [...sprite.palette];
    for (const [name, content] of [["bad.gpl", "not a palette"], ["empty.hex", "nothing here\n"], ["bad.pal", "JASC-PAL\n0100\n"]] as const) {
      const file = path.join(dir, name);
      writeFileSync(file, content);
      await rejectsWith(load(studio, { path: file }), "io_error", new RegExp(`^Could not read a palette from '${file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}'\\.$`));
    }
    assert.deepEqual(sprite.palette, before);
    assert.equal(sprite.modified, false);
  });
});

test("palette.load of an .aseprite file takes the first frame's palette, alpha included, and ignores later palette changes", async () => {
  await inTempDir(async (dir) => {
    const chunk = (type: number, body: number[]) => [...u32(body.length + 6), type & 255, type >> 8, ...body];
    const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const palette = (colors: number[][]) =>
      chunk(0x2019, [...u32(colors.length), ...u32(0), ...u32(colors.length - 1), ...new Array(8).fill(0), ...colors.flatMap((c) => [0, 0, ...c])]);
    const frame = (chunks: number[][]) => {
      const body = chunks.flat();
      return [...u32(16 + body.length), 0xfa, 0xf1, chunks.length, 0, 100, 0, 0, 0, ...u32(chunks.length), ...body];
    };
    const frames = [frame([palette([[255, 0, 0, 255], [0, 255, 0, 128]])]), frame([palette([[1, 2, 3, 255]])])].flat();
    const header = [...u32(128 + frames.length), 0xe0, 0xa5, 2, 0, 1, 0, 1, 0, 32, 0, 1, 0, 0, 0, 100, 0, ...new Array(128 - 20).fill(0)];
    const file = path.join(dir, "p.aseprite");
    writeFileSync(file, Uint8Array.from([...header, ...frames]));
    const { studio, sprite } = await newSprite();
    const reply = await load(studio, { path: file });
    assert.deepEqual(reply.colors, ["#ff0000", "#00ff0080"]);
    assert.deepEqual(sprite.palette, [RED, rgba(0, 255, 0, 128)]);
  });
});

test("palette.load of a sprite saved as .aseprite gives back its palette", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await newSprite();
    sprite.palette = [RED, rgba(0, 255, 0, 128), BLUE];
    const file = path.join(dir, "saved.aseprite");
    await studio.call("sprite.manage", { op: "save_as", path: file });
    const other = await newSprite();
    await load(other.studio, { path: file });
    assert.deepEqual(other.sprite.palette, [RED, rgba(0, 255, 0, 128), BLUE]);
  });
});

test("palette.load of an unknown extension is unsupported_command and leaves the palette", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await newSprite();
    const before = [...sprite.palette];
    for (const name of ["a.txt", "a"]) {
      const file = path.join(dir, name);
      writeFileSync(file, "ff0000\n");
      await rejectsWith(load(studio, { path: file }), "unsupported_command");
    }
    assert.deepEqual(sprite.palette, before);
  });
});

test("palette.load without remapArt replaces the palette and leaves the art alone", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "p.hex");
    writeFileSync(file, "ff0000\n");
    const { studio, sprite } = await newSprite();
    const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
    cel.image = Image.from(2, 1, new Uint32Array([BLUE, BLUE]));
    await load(studio, { path: file });
    assert.deepEqual(sprite.palette, [RED]);
    assert.deepEqual([...cel.image.pixels], [BLUE, BLUE]);
  });
});

test("palette.load with replace false appends the file's colours to the palette", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "p.hex");
    writeFileSync(file, "ff0000\n0000ff\n");
    const { studio, sprite } = await newSprite();
    const before = [...sprite.palette];
    const reply = await load(studio, { path: file, replace: false });
    assert.deepEqual(sprite.palette, [...before, RED, BLUE]);
    assert.equal(reply.size, before.length + 2);
  });
});

test("palette.load with remapArt repaints the art to the nearest loaded colour, as palette.set does", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "p.hex");
    writeFileSync(file, "ff0000\n0000ff\n");
    const { studio, sprite } = await newSprite();
    const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
    cel.image = Image.from(2, 1, new Uint32Array([rgba(240, 20, 20), rgba(10, 10, 230, 128)]));
    await load(studio, { path: file, remapArt: true });
    assert.deepEqual([...cel.image.pixels], [RED, rgba(0, 0, 255, 128)]);
  });
});

test("palette.load refuses remapArt on an indexed sprite and leaves the palette alone", async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, "p.hex");
    writeFileSync(file, "ff0000\n");
    const { studio, sprite } = await newSprite("indexed");
    const before = [...sprite.palette];
    await rejectsWith(load(studio, { path: file, remapArt: true }), "invalid_args", /remapArt/);
    assert.deepEqual(sprite.palette, before);
  });
});
