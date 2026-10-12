import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { bin: Record<string, string>; files: string[]; scripts: Record<string, string> };

test("installing from git (npx github:…) builds the file the bin points at, and ships it", () => {
  // npm runs `prepare` after installing a git dependency's devDependencies.
  assert.equal(pkg.scripts.prepare, "npm run build");
  assert.match(pkg.scripts.build!, /^tsc /);
  assert.equal(pkg.bin["pixel-ai-artist"], "dist/cli.js");
  assert.ok(pkg.files.includes("dist"));
});
