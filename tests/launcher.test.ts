import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-ignore — plain .mjs on purpose: the launcher must run before any build step exists.
import { buildSteps } from "../bin/launcher.mjs";

test("git-install bootstrap pins the lockfile and skips dependency scripts", () => {
  const steps = buildSteps();
  // npm ci, never npm install: a git install carries package-lock.json, and
  // `install` would happily resolve something the lockfile does not pin.
  assert.deepEqual(steps[0], ["ci", "--silent", "--no-audit", "--no-fund", "--ignore-scripts"]);
  assert.deepEqual(steps[1], ["run", "--silent", "build"]);
  for (const args of steps) {
    assert.ok(!args.includes("install"), `no install step: npm ${args.join(" ")}`);
  }
});
