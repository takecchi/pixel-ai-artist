import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rgbaToHex } from "../dist/doc/model.js";
import { decodeGif } from "../dist/lib/gif.js";
import { decodePng } from "../dist/lib/png.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const legend = { O: "#00e436", W: "#fff1e8", K: "#1d2b53", D: "#008751" };
const slime = [
  "....OOOO....",
  "..OOOOOOOO..",
  ".OOWOOOOWOO.",
  "OOOKOOOOKOOO",
  "OOOOOOOOOOOO",
  "OOOOOKKOOOOO",
  ".OOOOOOOOOO.",
  "..DDDDDDDD..",
];
const squash = [
  "............",
  "............",
  "...OOOOOO...",
  ".OOOOOOOOOO.",
  "OOWOOOOOOWOO",
  "OOKOOOOOOKOO",
  "OOOOOKKOOOOO",
  "DDDDDDDDDDDD",
];

test("over stdio, with no editor anywhere, a sprite goes from preflight to a saved PNG and a tagged, validated two-frame GIF", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pixel-ai-artist-stdio-"));
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "serve"], stderr: "ignore" }));
  // callTool also checks every result against the tool's declared output schema.
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
    return result as { content: { type: string; data?: string }[]; structuredContent: Record<string, unknown> };
  };
  try {
    const ready = await call("preflight", {});
    assert.equal(ready.structuredContent.ready, true);

    const created = await call("sprite_manage", { op: "new", width: 16, height: 16 });
    assert.equal(created.structuredContent.id, 1);

    // Every legend colour is a PICO-8 entry, so palette lock keeps them as written.
    await call("palette", { op: "preset", preset: "pico8", replace: true });

    const drawn = await call("draw", { ops: [{ kind: "grid", x: 2, y: 6, legend, rows: slime }] });
    assert.equal(drawn.structuredContent.pixelsChanged, 76, "the painted cells; a '.' on a clear canvas changes nothing");

    const preview = await call("look", { op: "preview" });
    const image = preview.content.find((c) => c.type === "image");
    assert.ok(image?.data, "preview carries an image");
    assert.equal(decodePng(Buffer.from(image.data, "base64")).width, 16 * Number(preview.structuredContent.scale));

    const ascii = await call("look", { op: "ascii", rulers: false });
    const rows = ascii.structuredContent.gridRows as string[];
    assert.equal(rows.length, 16);
    assert.equal(rows[6]!.slice(2, 14).replace(/[^.]/g, "O"), slime[0], "the crown row reads back where it was drawn");

    const pngPath = path.join(dir, "slime.png");
    await call("sprite_manage", { op: "save_as", path: pngPath });

    await call("frame", { op: "duplicate", frame: 1 });
    await call("draw", { frame: 2, ops: [{ kind: "grid", x: 2, y: 6, legend, rows: squash }] });
    await call("frame", { op: "set_duration", durations: [300, 300] });

    const errors = async () =>
      ((await call("validate", {})).structuredContent.findings as { check: string; severity: string }[])
        .filter((f) => f.severity === "error")
        .map((f) => f.check);
    assert.deepEqual(await errors(), ["animation"], "two frames and no tag is the one error");
    await call("tag", { op: "create", name: "idle", from: 1, to: 2 });
    assert.deepEqual(await errors(), []);

    const gifPath = path.join(dir, "slime.gif");
    await call("sprite_manage", { op: "save_as", path: gifPath });

    const png = decodePng(readFileSync(pngPath));
    assert.deepEqual([png.width, png.height], [16, 16]);
    const body = rgbaToHex(png.get(6, 6));
    assert.equal(body, legend.O);
    assert.equal(rgbaToHex(png.get(5, 8)), legend.W);
    assert.equal(rgbaToHex(png.get(5, 9)), legend.K);
    assert.equal(rgbaToHex(png.get(0, 0)), "#00000000");

    const gif = decodeGif(readFileSync(gifPath));
    assert.deepEqual(gif.frames.map((f) => f.durationMs), [300, 300]);
    assert.deepEqual([...gif.frames[0]!.image.pixels].map(rgbaToHex), [...png.pixels].map(rgbaToHex), "frame 1 is the PNG");
    assert.equal(rgbaToHex(gif.frames[1]!.image.get(5, 8)), body, "frame 2 is squashed: body where the eye was");
    assert.equal(rgbaToHex(gif.frames[1]!.image.get(6, 6)), "#00000000", "and empty where the crown was");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
