import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Image, createStudio, rgba } from "../dist/doc/index.js";
import { createServer } from "../dist/server.js";

type Reply = Record<string, any>;
type Studio = ReturnType<typeof createStudio>;

async function inTempDir(body: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-ai-artist-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const manage = (studio: Studio, args: Record<string, unknown>) => studio.call<Reply>("sprite.manage", args);
const RED = rgba(255, 0, 0);

/** A 2x1 sprite with two layers, three frames and one tag. */
async function layered(colorMode: "rgb" | "indexed" = "rgb") {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 1, colorMode });
  const sprite = studio.activeSprite()!;
  sprite.frames = [{ durationMs: 100 }, { durationMs: 100 }, { durationMs: 100 }];
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(2, 1, new Uint32Array(colorMode === "indexed" ? [1, 2] : [RED, RED]));
  studio.addLayer(sprite, "Top");
  sprite.tags = [{ name: "walk", from: 1, to: 3, direction: "forward", repeats: 0, color: 0 }];
  return { studio, sprite };
}

test("save_as .png reports the layers, frames and tags a flat PNG cannot keep", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await layered();
    const reply = await manage(studio, { op: "save_as", path: path.join(dir, "flat.png") });
    assert.deepEqual(reply.lostOnSave, { layers: 2, frames: 3, tags: 1 });
  });
});

test("save_as .png of an indexed sprite also reports its palette, which the PNG cannot keep", async () => {
  await inTempDir(async (dir) => {
    const { studio, sprite } = await layered("indexed");
    const reply = await manage(studio, { op: "save_as", path: path.join(dir, "flat.png") });
    assert.deepEqual(reply.lostOnSave, { layers: 2, frames: 3, tags: 1, palette: sprite.palette.length });
  });
});

test("save_as .gif keeps frames and an indexed palette, and reports the layers and tags it cannot", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await layered("indexed");
    const gif = await manage(studio, { op: "save_as", path: path.join(dir, "anim.gif") });
    assert.deepEqual(gif.lostOnSave, { layers: 2, tags: 1 });
  });
});

test("save to .png reports the same losses as save_as", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await layered();
    await manage(studio, { op: "save_as", path: path.join(dir, "first.png") });
    assert.deepEqual((await manage(studio, { op: "save" })).lostOnSave, { layers: 2, frames: 3, tags: 1 });
  });
});

test("saving a one-layer, one-frame RGB sprite with no tags as .png reports no losses, its editing palette included", async () => {
  await inTempDir(async (dir) => {
    const studio = createStudio();
    await manage(studio, { op: "new", width: 2, height: 1 });
    const reply = await manage(studio, { op: "save_as", path: path.join(dir, "plain.png") });
    assert.equal("lostOnSave" in reply, false);
  });
});

test("saving as .aseprite reports no losses for layers, frames or tags", async () => {
  await inTempDir(async (dir) => {
    const { studio } = await layered("indexed");
    const reply = await manage(studio, { op: "save_as", path: path.join(dir, "full.aseprite") });
    assert.equal("lostOnSave" in reply, false);
  });
});

test("sprite.info marks a Background layer with background: true and leaves the key off other layers", async () => {
  const studio = createStudio();
  await manage(studio, { op: "new", width: 2, height: 1 });
  const sprite = studio.activeSprite()!;
  sprite.layers[0]!.name = "Background";
  sprite.layers[0]!.background = true;
  studio.addLayer(sprite, "Ink");
  const info = await studio.call<Reply>("sprite.info");
  assert.deepEqual(info.layers.map((l: Reply) => [l.name, l.background]), [["Background", true], ["Ink", undefined]]);
  assert.equal("background" in info.layers[1], false);
});

async function connected() {
  const { server } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => server.close() };
}

const textOf = (result: { content?: unknown }): string => (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";

test("the sprite_manage tool's save_as text says what a flat file could not keep, and sprite_info carries background", async () => {
  await inTempDir(async (dir) => {
    const { client, close } = await connected();
    await client.callTool({ name: "sprite_manage", arguments: { op: "new", width: 2, height: 1 } });
    await client.callTool({ name: "layer", arguments: { op: "create", name: "Top" } });
    const res = await client.callTool({ name: "sprite_manage", arguments: { op: "save_as", path: path.join(dir, "flat.png") } });
    assert.ok(!res.isError, textOf(res));
    assert.match(textOf(res), /could not keep: layers 2 \(lostOnSave\)/);
    // A JPEG has no transparency, so it opens as a Background, as in Aseprite.
    const opaque = fileURLToPath(new URL("./fixtures/jpeg/baseline-444.jpg", import.meta.url));
    await client.callTool({ name: "sprite_manage", arguments: { op: "open", path: opaque } });
    const info = await client.callTool({ name: "sprite_info", arguments: {} });
    assert.ok(!info.isError, textOf(info));
    assert.equal((info.structuredContent as Reply).layers[0].background, true);
    await close();
  });
});
