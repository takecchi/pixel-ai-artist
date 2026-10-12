import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Image, ToolError, createStudio, pixelToHex, rgba, type Studio } from "../dist/doc/index.js";

type Reply = Record<string, any>;

const RED = rgba(255, 0, 0);
const GREEN = rgba(0, 255, 0);
const BLUE = rgba(0, 0, 255);

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ToolError, `expected a ToolError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

function sketch(studio: Studio, width: number, height: number, pixels: [number, number, number][], opts = {}) {
  const sprite = studio.addSprite({ width, height, ...opts });
  const cel = studio.ensureCel(sprite, sprite.layers[0]!, 1);
  for (const [x, y, v] of pixels) cel.image.set(x, y, v);
  return { sprite, cel };
}

const hexes = (sprite: Parameters<typeof pixelToHex>[0], image: Image) =>
  [...image.pixels].map((v) => pixelToHex(sprite, v));

test("replace swaps one exact colour and reports the move with its pixel count", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 4, 1, [[0, 0, RED], [1, 0, RED], [2, 0, BLUE]]);
  const r = await studio.call<Reply>("recolor.apply", {
    op: "replace", from: "#FF0000", to: "#00ff00", clampToPalette: false,
  });
  assert.deepEqual(hexes(sprite, cel.image), ["#00ff00", "#00ff00", "#0000ff", null]);
  assert.deepEqual(r, {
    sprite: "Sprite",
    op: "replace",
    pixelsChanged: 2,
    mapping: [{ from: "#ff0000", to: "#00ff00", pixels: 2 }],
  });
  assert.equal(sprite.modified, true);
});

test("by default the result is snapped to the palette, so replace can land on a neighbour of the colour asked for", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 1, 1, [[0, 0, RED]], { palette: [RED, rgba(0, 204, 0)] });
  const r = await studio.call<Reply>("recolor.apply", { op: "replace", from: "#ff0000", to: "#00ff00" });
  assert.deepEqual(hexes(sprite, cel.image), ["#00cc00"]);
  assert.deepEqual(r.mapping, [{ from: "#ff0000", to: "#00cc00", pixels: 1 }]);
});

test("shade darkens pure red to #ca0212: hue turned 5 degrees toward blue, lightness 0.4, saturation 0.984", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 1, 1, [[0, 0, RED]]);
  const r = await studio.call<Reply>("recolor.apply", { op: "shade", clampToPalette: false });
  assert.deepEqual(hexes(sprite, cel.image), ["#ca0212"]);
  assert.deepEqual(r.mapping, [{ from: "#ff0000", to: "#ca0212", pixels: 1 }]);
});

test("hue_shift rotates the hue and defaults to 30 degrees", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 1, 1, [[0, 0, RED]]);
  await studio.call("recolor.apply", { op: "hue_shift", degrees: 120, clampToPalette: false });
  assert.deepEqual(hexes(sprite, cel.image), ["#00ff00"]);

  const yellow = createStudio();
  const y = sketch(yellow, 1, 1, [[0, 0, RED]]);
  await yellow.call("recolor.apply", { op: "hue_shift", degrees: 60, clampToPalette: false });
  assert.deepEqual(hexes(y.sprite, y.cel.image), ["#ffff00"]);

  const other = createStudio();
  const b = sketch(other, 1, 1, [[0, 0, RED]]);
  await other.call("recolor.apply", { op: "hue_shift", clampToPalette: false });
  // Hue 30 is orange; its green channel is 127.5, which float error may land either side of.
  assert.match(String(hexes(b.sprite, b.cel.image)[0]), /^#ff(7f|80)00$/);
});

test("desaturate scales saturation by 1 - strength, fully grey at strength 1", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 1, [[0, 0, RED], [1, 0, RED]]);
  await studio.call("recolor.apply", { op: "desaturate", strength: 0.5, clampToPalette: false });
  assert.deepEqual(hexes(sprite, cel.image), ["#bf4040", "#bf4040"]);

  const other = createStudio();
  const b = sketch(other, 1, 1, [[0, 0, RED]]);
  await other.call("recolor.apply", { op: "desaturate", clampToPalette: false });
  assert.deepEqual(hexes(b.sprite, b.cel.image), ["#808080"]);
});

test("snap pulls off-palette colours to the nearest palette entry, keeps alpha, and leaves palette colours alone", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(
    studio, 4, 1,
    [[0, 0, rgba(0x20, 0x20, 0x20)], [1, 0, rgba(0xe0, 0xe0, 0xe0)], [2, 0, rgba(0, 0, 0)], [3, 0, rgba(0x20, 0x20, 0x20, 128)]],
    { palette: [rgba(0, 0, 0), rgba(255, 255, 255)] },
  );
  const r = await studio.call<Reply>("recolor.apply", { op: "snap" });
  assert.deepEqual(hexes(sprite, cel.image), ["#000000", "#ffffff", "#000000", "#00000080"]);
  assert.equal(r.pixelsChanged, 3);
  assert.deepEqual(r.mapping, [
    { from: "#202020", to: "#000000", pixels: 1 },
    { from: "#e0e0e0", to: "#ffffff", pixels: 1 },
    { from: "#202020", to: "#000000", pixels: 1 },
  ]);
});

test("a region limits the change to canvas coordinates, whatever the cel's own offset", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 6, 1, []);
  cel.image = studio.newImage(sprite, 2, 1);
  cel.image.set(0, 0, RED);
  cel.image.set(1, 0, RED);
  cel.x = 2;
  const r = await studio.call<Reply>("recolor.apply", {
    op: "replace", from: "#ff0000", to: "#0000ff", clampToPalette: false,
    region: { x: 3, y: 0, width: 5, height: 5 },
  });
  assert.deepEqual(hexes(sprite, cel.image), ["#ff0000", "#0000ff"]);
  assert.equal(r.pixelsChanged, 1);
  assert.deepEqual(r.mapping, [{ from: "#ff0000", to: "#0000ff", pixels: 1 }]);
});

test("a region wholly off the canvas is invalid_args", async () => {
  const studio = createStudio();
  sketch(studio, 3, 1, [[0, 0, RED]]);
  await rejectsWith(
    studio.call("recolor.apply", { op: "desaturate", region: { x: 5, y: 0, width: 2, height: 2 } }),
    "invalid_args",
    /^Region is empty after clamping to the 3x1 canvas\.$/,
  );
});

test("selectionOnly recolours only the selected pixels", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 3, 1, [[0, 0, RED], [1, 0, RED], [2, 0, RED]]);
  sprite.selection = { mask: Uint8Array.from([0, 1, 0]), bounds: { x: 1, y: 0, width: 1, height: 1 } };
  const r = await studio.call<Reply>("recolor.apply", {
    op: "replace", from: "#ff0000", to: "#0000ff", clampToPalette: false, selectionOnly: true,
  });
  assert.deepEqual(hexes(sprite, cel.image), ["#ff0000", "#0000ff", "#ff0000"]);
  assert.equal(r.pixelsChanged, 1);
  assert.deepEqual(r.mapping, [{ from: "#ff0000", to: "#0000ff", pixels: 1 }]);
});

test("selectionOnly with nothing selected refuses instead of recolouring the whole cel", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 1, [[0, 0, RED]]);
  await rejectsWith(
    studio.call("recolor.apply", { op: "desaturate", selectionOnly: true }),
    "invalid_args",
    /^selectionOnly was set but nothing is selected\. Recolouring the whole cel instead would change far more than you asked for, so this refuses\. Select a region first, or pass a `region`, or drop selectionOnly\.$/,
  );
  sprite.selection = { mask: new Uint8Array(2), bounds: { x: 0, y: 0, width: 0, height: 0 } };
  await rejectsWith(studio.call("recolor.apply", { op: "desaturate", selectionOnly: true }), "invalid_args", /nothing is selected/);
  assert.deepEqual(hexes(sprite, cel.image), ["#ff0000", null]);
});

test("replace needs both colours, and an unknown op is unsupported_command", async () => {
  const studio = createStudio();
  sketch(studio, 2, 1, [[0, 0, RED]]);
  await rejectsWith(studio.call("recolor.apply", { op: "replace", to: "#00ff00" }), "invalid_args", /^Missing required argument 'from'\.$/);
  await rejectsWith(studio.call("recolor.apply", { op: "replace", from: "#ff0000" }), "invalid_args", /^Missing required argument 'to'\.$/);
  await rejectsWith(studio.call("recolor.apply", { op: "bogus" }), "unsupported_command", /^recolor op 'bogus' is not supported\.$/);
  await rejectsWith(studio.call("recolor.apply", {}), "invalid_args", /^Missing required argument 'op'\.$/);
});

test("recolour on a layer or frame with no cel is invalid_args", async () => {
  const studio = createStudio();
  studio.addSprite({ width: 2, height: 2 });
  await rejectsWith(studio.call("recolor.apply", { op: "snap" }), "invalid_args", /^No cel on 'Layer 1' frame 1\.$/);
});

test("in an indexed sprite replace picks the RGB-nearest palette index and does not snap again", async () => {
  const studio = createStudio();
  const { sprite, cel } = sketch(studio, 2, 1, [], {
    colorMode: "indexed", palette: [rgba(0, 0, 0, 0), RED, BLUE, GREEN],
  });
  cel.image.set(0, 0, 1);
  const r = await studio.call<Reply>("recolor.apply", { op: "replace", from: "#ff0000", to: "#0000ff" });
  assert.deepEqual([...cel.image.pixels], [2, 0]);
  assert.equal(r.pixelsChanged, 1);
  assert.deepEqual(r.mapping, [{ from: "#ff0000", to: "#0000ff", pixels: 1 }]);
  assert.equal(pixelToHex(sprite, 2), "#0000ff");
});

test("a recolour that changes nothing reports an empty mapping", async () => {
  const studio = createStudio();
  sketch(studio, 2, 1, [[0, 0, RED]], { palette: [RED] });
  const r = await studio.call<Reply>("recolor.apply", { op: "snap" });
  assert.deepEqual(r, { sprite: "Sprite", op: "snap", pixelsChanged: 0, mapping: [] });
});

test("the recolor tool runs over MCP", async () => {
  const { server, studio } = createServer();
  const { cel, sprite } = sketch(studio, 2, 1, [[0, 0, RED]]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({
    name: "recolor",
    arguments: { op: "replace", from: "#ff0000", to: "#00ff00", clampToPalette: false },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    sprite: "Sprite",
    op: "replace",
    pixelsChanged: 1,
    mapping: [{ from: "#ff0000", to: "#00ff00", pixels: 1 }],
  });
  assert.equal(cel.image.get(0, 0), GREEN);
  assert.equal(sprite.modified, true);
  await server.close();
});

test("a shade the palette absorbs says why nothing changed and what to try; a real change or a snap says nothing extra", async () => {
  const { server, studio } = createServer();
  sketch(studio, 2, 1, [[0, 0, RED]], { palette: [RED] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const text = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "recolor", arguments: args });
    assert.notEqual(r.isError, true);
    return (r.content as { type: string; text: string }[]).map((c) => c.text).join(" ");
  };

  const absorbed = await text({ op: "shade" });
  assert.match(absorbed, /^0 pixel\(s\) recoloured\. Nothing changed: .*clampToPalette.*clampToPalette: false/);
  assert.match(await text({ op: "desaturate" }), /Nothing changed/);
  assert.doesNotMatch(await text({ op: "snap" }), /Nothing changed/);
  assert.doesNotMatch(await text({ op: "shade", clampToPalette: false }), /Nothing changed/);
  await server.close();
});
