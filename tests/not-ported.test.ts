import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

type Args = Record<string, unknown>;

async function connected() {
  const { server, studio } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  studio.addSprite({ width: 4, height: 4 });
  const raw = (name: string, args: Args) => client.callTool({ name, arguments: args });
  const text = (r: { content?: unknown }) =>
    (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  /** Everything an agent can observe of the sprite: layers, frames, pixels' modified flag. */
  const snapshot = async () => {
    const info = await raw("sprite_info", {});
    assert.notEqual(info.isError, true, text(info));
    return JSON.stringify(info.structuredContent);
  };
  return { client, raw, text, snapshot, close: async () => { await server.close(); } };
}

const pixels = { kind: "pixels", color: "#ff0000", points: [{ x: 0, y: 0 }] };

/** Each row: a call carrying one refused value, and the argument name the refusal must name. */
const refused: { name: string; tool: string; args: Args; argument: string }[] = [
  { name: "draw label", tool: "draw", args: { ops: [pixels], label: "step" }, argument: "label" },
  { name: "draw label of empty string", tool: "draw", args: { ops: [pixels], label: "" }, argument: "label" },
  { name: "transform allowLossy true", tool: "transform", args: { op: "rotate", angle: 90, allowLossy: true }, argument: "allowLossy" },
  { name: "preflight mode", tool: "preflight", args: { mode: "headless" }, argument: "mode" },
  { name: "sprite_info includeSlices true", tool: "sprite_info", args: { includeSlices: true }, argument: "includeSlices" },
  { name: "layer parent", tool: "layer", args: { op: "create", name: "a", parent: "group" }, argument: "parent" },
  { name: "layer blendMode", tool: "layer", args: { op: "create", name: "a", blendMode: "multiply" }, argument: "blendMode" },
  { name: "layer names", tool: "layer", args: { op: "merge", names: ["a", "b"] }, argument: "names" },
  { name: "frame linkCels true", tool: "frame", args: { op: "duplicate", linkCels: true }, argument: "linkCels" },
  { name: "cel frames", tool: "cel", args: { op: "list", frames: [1, 2] }, argument: "frames" },
];

for (const row of refused) {
  test(`${row.name} is refused as invalid_args naming the argument, and changes nothing`, async () => {
    const { raw, text, snapshot, close } = await connected();
    try {
      const before = await snapshot();
      const result = await raw(row.tool, row.args);
      assert.equal(result.isError, true, text(result));
      const message = text(result);
      assert.ok(message.startsWith("invalid_args:"), message);
      assert.ok(message.includes(`\`${row.argument}\` is not ported in this version.`), message);
      assert.equal(await snapshot(), before);
    } finally {
      await close();
    }
  });
}

/** Values the original accepted and that this port can honour, so they must pass. */
const accepted: { name: string; tool: string; args: Args }[] = [
  { name: "draw without label", tool: "draw", args: { ops: [pixels] } },
  { name: "transform allowLossy false", tool: "transform", args: { op: "rotate", angle: 90, allowLossy: false } },
  { name: "preflight without mode", tool: "preflight", args: {} },
  { name: "sprite_info includeSlices false", tool: "sprite_info", args: { includeSlices: false } },
  { name: "layer parent of empty string", tool: "layer", args: { op: "create", name: "a", parent: "" } },
  { name: "layer blendMode normal", tool: "layer", args: { op: "create", name: "a", blendMode: "normal" } },
  { name: "layer names of empty list", tool: "layer", args: { op: "create", name: "a", names: [] } },
  { name: "frame linkCels false", tool: "frame", args: { op: "duplicate", linkCels: false } },
  { name: "cel frames of empty list", tool: "cel", args: { op: "list", frames: [] } },
  { name: "draw with an unknown key", tool: "draw", args: { ops: [pixels], extraKey: 1 } },
  { name: "layer with an unknown key", tool: "layer", args: { op: "create", name: "a", extraKey: 1 } },
  { name: "frame with an unknown key", tool: "frame", args: { op: "add", extraKey: 1 } },
  { name: "cel with an unknown key", tool: "cel", args: { op: "list", extraKey: 1 } },
  { name: "preflight with an unknown key", tool: "preflight", args: { extraKey: 1 } },
  { name: "layer batch item with the accepted values", tool: "layer", args: { batch: [{ op: "create", name: "a", parent: "", blendMode: "normal", names: [], extraKey: 1 }] } },
];

for (const row of accepted) {
  test(`${row.name} is not refused`, async () => {
    const { raw, text, close } = await connected();
    try {
      // transform needs a cel with ink to act on
      assert.notEqual((await raw("draw", { ops: [pixels] })).isError, true);
      const result = await raw(row.tool, row.args);
      assert.notEqual(result.isError, true, text(result));
    } finally {
      await close();
    }
  });
}

test("a layer batch item carrying a refused value is refused by its position, for every dropped argument", async () => {
  for (const [argument, value] of [["parent", "group"], ["blendMode", "multiply"], ["names", ["a"]]] as const) {
    const { raw, text, close } = await connected();
    try {
      const result = await raw("layer", {
        batch: [{ op: "create", name: "a" }, { op: "create", name: "b", [argument]: value }],
      });
      assert.equal(result.isError, true, text(result));
      assert.ok(text(result).startsWith("invalid_args:"), text(result));
      assert.ok(text(result).includes(`\`batch[1].${argument}\` is not ported in this version.`), text(result));
    } finally {
      await close();
    }
  }
});

test("a refused batch item leaves the items before it unapplied", async () => {
  const { raw, text, snapshot, close } = await connected();
  try {
    const before = await snapshot();
    const result = await raw("layer", {
      batch: [
        { op: "create", name: "first" },
        { op: "create", name: "second" },
        { op: "create", name: "third", blendMode: "screen" },
      ],
    });
    assert.equal(result.isError, true, text(result));
    assert.ok(text(result).includes("`batch[2].blendMode`"), text(result));
    assert.equal(await snapshot(), before);
    const listed = await raw("layer", { op: "list" });
    const names = (listed.structuredContent as { layers: { name: string }[] }).layers.map((l) => l.name);
    assert.ok(!names.includes("first") && !names.includes("second"), names.join(", "));
  } finally {
    await close();
  }
});

const refusedOps: { name: string; tool: string; args: Args; op: string }[] = [
  { name: "cel link", tool: "cel", args: { op: "link", layer: "Layer 1", frame: 1 }, op: "link" },
  { name: "cel unlink", tool: "cel", args: { op: "unlink", layer: "Layer 1", frame: 1 }, op: "unlink" },
  { name: "sprite_manage slice_create", tool: "sprite_manage", args: { op: "slice_create", name: "s" }, op: "slice_create" },
  { name: "sprite_manage slice_update", tool: "sprite_manage", args: { op: "slice_update", name: "s" }, op: "slice_update" },
  { name: "sprite_manage slice_delete", tool: "sprite_manage", args: { op: "slice_delete", name: "s" }, op: "slice_delete" },
];

for (const row of refusedOps) {
  test(`${row.name} answers unsupported_command saying it is not ported, and changes nothing`, async () => {
    const { raw, text, snapshot, close } = await connected();
    try {
      const before = await snapshot();
      const result = await raw(row.tool, row.args);
      assert.equal(result.isError, true, text(result));
      const message = text(result);
      assert.ok(message.startsWith("unsupported_command:"), message);
      assert.ok(message.includes(`'${row.op}' is not ported in this version.`), message);
      assert.equal(await snapshot(), before);
    } finally {
      await close();
    }
  });
}
