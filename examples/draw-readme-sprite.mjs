// Draws the README's sprite through the server's own tools, the way an agent would,
// and writes docs/media/slime-idle.gif. Run from a built checkout:
//   npm run build && node examples/draw-readme-sprite.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "media", "slime-idle.gif");

// PICO-8: dark blue outline, green body, dark green shade, off-white highlight.
const legend = { K: "#1d2b53", O: "#00e436", D: "#008751", W: "#fff1e8" };

const rest = {
  x: 1,
  y: 5,
  rows: [
    ".....KKKK.....",
    "...KKOOOOKK...",
    "..KOOWWOOOOK..",
    ".KOOWOOOOOOOK.",
    ".KOOOOOOOOOOK.",
    "KOOOKOOOOKOOOK",
    "KOOOKOOOOKOOOK",
    "KOOOOOOOOOOOOK",
    "KDOOOOOOOOOODK",
    ".KDDDDDDDDDDK.",
    "..KKKKKKKKKK..",
  ],
};
const squash = {
  x: 0,
  y: 7,
  rows: [
    "......KKKK......",
    "...KKKOOOOKKK...",
    ".KKOOWWOOOOOOKK.",
    "KOOOWOOOOOOOOOOK",
    "KOOOOKOOOOKOOOOK",
    "KOOOOKOOOOKOOOOK",
    "KDOOOOOOOOOOOODK",
    ".KDDDDDDDDDDDDK.",
    "..KKKKKKKKKKKK..",
  ],
};
const stretch = {
  x: 2,
  y: 3,
  rows: [
    "....KKKK....",
    "...KOOOOK...",
    "..KOWWOOOK..",
    ".KOWOOOOOOK.",
    ".KOOOOOOOOK.",
    ".KOOOOOOOOK.",
    "KOOKOOOOKOOK",
    "KOOKOOOOKOOK",
    "KOOOOOOOOOOK",
    "KOOOOOOOOOOK",
    "KDOOOOOOOODK",
    ".KDDDDDDDDK.",
    "..KKKKKKKK..",
  ],
};
const frames = [rest, squash, rest, stretch];

const client = new Client({ name: "readme-sprite", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "cli.js"), "serve"] }));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");
  if (result.isError) throw new Error(`${name}: ${text}`);
  console.log(`${name}: ${text.split("\n")[0]}`);
  return result;
}

await call("sprite_manage", { op: "new", width: 16, height: 16 });
await call("palette", { op: "preset", preset: "pico8", replace: true });
await call("frame", { op: "add", count: frames.length - 1 });
for (const [i, f] of frames.entries()) {
  await call("draw", { frame: i + 1, ops: [{ kind: "grid", x: f.x, y: f.y, legend, rows: f.rows }] });
}
await call("frame", { op: "set_duration", durations: [260, 120, 160, 200] });
await call("tag", { op: "create", name: "idle", from: 1, to: frames.length });
await call("validate", {});
await call("export", { op: "gif", path: out, scale: 16 });
await client.close();
console.log(out);
