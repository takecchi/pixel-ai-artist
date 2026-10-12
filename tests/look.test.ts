import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Image, ToolError, createStudio, rgba } from "../dist/doc/index.js";
import { decodePng } from "../dist/lib/png.js";
import { createServer } from "../dist/server.js";

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
const GREY = rgba(64, 64, 72);

function png(reply: Reply) {
  return decodePng(reply.png);
}

/** A 2x1 sprite: red, clear. */
function setup() {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1 });
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image = Image.from(2, 1, new Uint32Array([RED, 0]));
  return { studio, sprite };
}

test("preview renders the frame as a PNG at the scale it reports, upscaled nearest-neighbour", async () => {
  const { studio } = setup();
  const reply = await studio.call<Reply>("look.preview", { scale: 3 });
  assert.deepEqual(
    [reply.sprite, reply.sourceWidth, reply.sourceHeight, reply.width, reply.height, reply.scale],
    ["Sprite", 2, 1, 6, 3, 3],
  );
  const img = png(reply);
  assert.deepEqual([img.width, img.height], [6, 3]);
  assert.equal(img.get(2, 2), RED);
  assert.equal(img.get(3, 0), 0);
});

test("without a scale a small sprite is blown up toward 1024px, and never past 2048px", async () => {
  const { studio } = setup();
  assert.equal((await studio.call<Reply>("look.preview")).scale, 512);
  assert.equal((await studio.call<Reply>("look.preview", { scale: 5000 })).scale, 1024);
});

test("preview with a region shows only that rectangle", async () => {
  const { studio } = setup();
  const reply = await studio.call<Reply>("look.preview", { region: { x: 1, y: 0, width: 1, height: 1 }, scale: 1 });
  assert.deepEqual([reply.sourceWidth, reply.sourceHeight], [1, 1]);
  assert.equal(png(reply).get(0, 0), 0);
});

test("preview of a layer shows that layer's cel alone", async () => {
  const { studio, sprite } = setup();
  studio.ensureCel(sprite, studio.addLayer(sprite, "top"), 1).image.set(1, 0, BLUE);
  const img = png(await studio.call<Reply>("look.preview", { layer: "top", scale: 1 }));
  assert.deepEqual([img.get(0, 0), img.get(1, 0)], [0, BLUE]);
});

test("an indexed sprite previews in its palette colours", async () => {
  const studio = createStudio();
  const sprite = studio.addSprite({ width: 2, height: 1, colorMode: "indexed", palette: [rgba(0, 0, 0), RED] });
  studio.ensureCel(sprite, sprite.layers[0]!, 1).image.pixels.set([0, 1]);
  const img = png(await studio.call<Reply>("look.preview", { scale: 1 }));
  assert.deepEqual([img.get(0, 0), img.get(1, 0)], [0, RED]);
});

test("filmstrip lays frames out row by row in a near-square grid, with a 1px grey gap", async () => {
  const { studio, sprite } = setup();
  sprite.frames.push({ durationMs: 100 }, { durationMs: 100 });
  studio.ensureCel(sprite, sprite.layers[0]!, 3).image.set(1, 0, BLUE);
  const reply = await studio.call<Reply>("look.filmstrip", { scale: 1 });
  // 3 frames → 2 columns × 2 rows of 2x1 cells, 1px apart: 5x3.
  assert.deepEqual([reply.frames, reply.width, reply.height, reply.scale], [3, 5, 3, 1]);
  const img = png(reply);
  assert.equal(img.get(0, 0), RED, "frame 1 top left");
  assert.equal(img.get(2, 0), GREY, "the gap between columns");
  assert.equal(img.get(1, 0), GREY, "clear pixels show the grey behind them");
  assert.equal(img.get(1, 2), BLUE, "frame 3 starts the second row");
  assert.equal(img.get(4, 2), GREY, "the unused fourth slot stays grey");
});

test("onion skin lays the neighbours under the target at ghostOpacity and reports the frames used", async () => {
  const { studio, sprite } = setup();
  sprite.frames.push({ durationMs: 100 }, { durationMs: 100 });
  const layer = sprite.layers[0]!;
  layer.cels.delete(1);
  studio.ensureCel(sprite, layer, 1).image.set(0, 0, BLUE);
  studio.ensureCel(sprite, layer, 2).image.set(1, 0, RED);
  studio.ensureCel(sprite, layer, 3).image.set(0, 0, RED);
  const reply = await studio.call<Reply>("look.onion", { frame: 2, ghostOpacity: 255, scale: 1 });
  assert.deepEqual([reply.frame, reply.frames], [2, [1, 2, 3]]);
  const img = png(reply);
  assert.equal(img.get(0, 0), RED, "the later ghost lies over the earlier one");
  assert.equal(img.get(1, 0), RED, "the target");
  const faint = png(await studio.call<Reply>("look.onion", { frame: 2, framesAfter: 0, ghostOpacity: 51, scale: 1 }));
  assert.equal(faint.get(0, 0) & 255, 51, "a ghost is faded to ghostOpacity");
});

test("onion skin stops at the first and last frame, and refuses out-of-range settings", async () => {
  const { studio } = setup();
  const reply = await studio.call<Reply>("look.onion", { framesBefore: 8, framesAfter: 8, scale: 1 });
  assert.deepEqual(reply.frames, [1]);
  await rejectsWith(studio.call("look.onion", { framesBefore: 9 }), "invalid_args", /framesBefore/);
  await rejectsWith(studio.call("look.onion", { framesAfter: -1 }), "invalid_args", /framesAfter/);
  await rejectsWith(studio.call("look.onion", { ghostOpacity: 256 }), "invalid_args", /ghostOpacity/);
});

test("compare shows the reference at full opacity on the left and the art without any reference layer on the right", async () => {
  const { studio, sprite } = setup();
  const ref = studio.addLayer(sprite, "reference");
  ref.opacity = 60;
  studio.ensureCel(sprite, ref, 1).image.set(1, 0, BLUE);
  const imported = studio.addLayer(sprite, "concept sheet");
  imported.reference = true;
  studio.ensureCel(sprite, imported, 1).image.set(1, 0, BLUE);
  const reply = await studio.call<Reply>("look.compare", { scale: 1 });
  assert.deepEqual([reply.frame, reply.reference, reply.sourceWidth, reply.width], [1, "reference", 2, 5]);
  const img = png(reply);
  assert.deepEqual([img.get(0, 0), img.get(1, 0)], [0, BLUE], "left: the reference alone, opaque, clear stays clear");
  assert.equal(img.get(2, 0), GREY, "the gap");
  assert.deepEqual([img.get(3, 0), img.get(4, 0)], [RED, 0], "right: the art alone");
});

test("compare refuses a reference with no cel on the frame, naming how to import one", async () => {
  const { studio, sprite } = setup();
  studio.addLayer(sprite, "reference");
  await rejectsWith(studio.call("look.compare"), "invalid_args", /'reference' has no cel on frame 1.*import/);
  await rejectsWith(studio.call("look.compare", { reference: "nope" }), "invalid_args", /No layer named 'nope'/);
});

test("looking does not change the document", async () => {
  const { studio, sprite } = setup();
  const ref = studio.addLayer(sprite, "reference");
  ref.opacity = 60;
  studio.ensureCel(sprite, ref, 1);
  sprite.modified = false;
  for (const cmd of ["look.preview", "look.filmstrip", "look.onion", "look.compare"]) await studio.call(cmd, { scale: 1 });
  assert.equal(sprite.modified, false);
  assert.equal(ref.opacity, 60);
  assert.deepEqual([...sprite.layers[0]!.cels.get(1)!.image.pixels], [RED, 0]);
});

test("the look tool hands the rendered PNG to the agent as an image and keeps the bytes out of its structured result", async () => {
  const { server, studio } = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  try {
    const sprite = studio.addSprite({ width: 2, height: 1 });
    studio.ensureCel(sprite, sprite.layers[0]!, 1).image.set(0, 0, RED);
    for (const op of ["preview", "filmstrip", "onion"]) {
      const result = await mcp.callTool({ name: "look", arguments: { op, scale: 2 } });
      assert.notEqual(result.isError, true, `${op}: ${JSON.stringify(result.content)}`);
      const image = (result.content as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === "image");
      assert.equal(image?.mimeType, "image/png", op);
      const decoded = decodePng(Buffer.from(image!.data!, "base64"));
      assert.equal(decoded.get(0, 0), RED, op);
      assert.equal((result.structuredContent as Reply).scale, 2, op);
      assert.equal("png" in (result.structuredContent as Reply), false, `${op} keeps the bytes out of the structured result`);
    }
  } finally {
    await server.close();
  }
});
