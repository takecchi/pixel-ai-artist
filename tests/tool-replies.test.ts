import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

async function connect() {
  const { server, studio } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    return { text, data: result.structuredContent as Record<string, any> };
  };
  return { server, studio, call };
}

test("sprite_manage list says how many sprites are open, their names and ids, which is active and which has unsaved changes", async () => {
  const { server, studio, call } = await connect();
  try {
    assert.equal((await call("sprite_manage", { op: "list" })).text, "list: no sprite is open.");
    const a = studio.addSprite({ width: 2, height: 2, filename: "/tmp/knight.png" });
    a.modified = true;
    studio.addSprite({ width: 2, height: 2 });
    const { text, data } = await call("sprite_manage", { op: "list" });
    assert.equal(text, "list: 2 open — 'knight.png' #1 (unsaved changes), 'Sprite' #2 (active).");
    assert.equal(data.sprites.length, 2, "the structured result is unchanged");
  } finally {
    await server.close();
  }
});

test("tag replies name every tag with its frame range, direction, frame count and duration", async () => {
  const { server, studio, call } = await connect();
  try {
    const sprite = studio.addSprite({ width: 2, height: 2 });
    sprite.frames = [{ durationMs: 140 }, { durationMs: 100 }, { durationMs: 140 }, { durationMs: 100 }];
    const created = await call("tag", { op: "create", name: "walk", from: 1, to: 4 });
    assert.equal(created.text, "1 tag(s): 'walk' frames 1–4 (forward, 4 frame(s), 480ms).");
    assert.deepEqual(created.data.tags, [{ name: "walk", from: 1, to: 4, direction: "forward", frames: 4, durationMs: 480 }]);
    await call("tag", { op: "delete", name: "walk" });
    assert.equal((await call("tag", { op: "list" })).text, "No tags.");
  } finally {
    await server.close();
  }
});

test("cel move and set say where the cel is now and its opacity, with the structured result unchanged", async () => {
  const { server, studio, call } = await connect();
  try {
    const sprite = studio.addSprite({ width: 8, height: 8 });
    sprite.frames.push({ durationMs: 100 });
    const layer = studio.addLayer(sprite, "arm");
    layer.cels.set(2, { x: 3, y: 4, image: studio.newImage(sprite, 1, 1), opacity: 255 });
    const moved = await call("cel", { op: "move", layer: "arm", frame: 2, dx: 2, dy: -1 });
    assert.equal(moved.text, "move: the cel on 'arm' frame 2 is now at (5,3), opacity 255.");
    assert.deepEqual(JSON.parse(JSON.stringify(moved.data)), { sprite: "Sprite", applied: 1 });
    sprite.activeFrame = 2;
    const set = await call("cel", { op: "set", opacity: 90 });
    assert.equal(set.text, "set: the cel on 'arm' frame 2 is now at (5,3), opacity 90.");
  } finally {
    await server.close();
  }
});
