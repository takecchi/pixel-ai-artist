import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { presets, searchPresets } from "../dist/lib/palettes.js";

test("every preset key the palette tool's description names as an example exists", () => {
  const source = readFileSync(new URL("../src/tools/palette.ts", import.meta.url), "utf8");
  const lists = source.match(/the classics \(([^)]*)\) and the most-downloaded on Lospec \(([^)]*)\)/);
  assert.ok(lists, "the description still lists example keys");
  const keys = [lists[1], lists[2]].flatMap((l) => l!.replace(/…/g, "").split(",").map((k) => k.trim()).filter(Boolean));
  const table = presets();
  assert.deepEqual(keys.filter((k) => !(k in table)), []);
});

test("every bundled preset is a loadable palette", () => {
  const table = presets();
  assert.ok(Object.keys(table).length > 1000, "the catalogue lost its Lospec palettes");
  // The hand-written classics lead; an all-digit key would jump ahead of them in object order.
  assert.equal(Object.keys(table)[0], "pico8");
  for (const [key, preset] of Object.entries(table)) {
    // Keys are what an agent types and what the site puts in a URL.
    assert.match(key, /^[a-z0-9][a-z0-9-]*$/, `${key}: key is not a slug`);
    assert.doesNotMatch(key, /^\d+$/, `${key}: an all-digit key reorders the catalogue`);
    assert.ok(preset.name.trim(), `${key}: no name`);
    assert.ok(preset.colors.length > 0 && preset.colors.length <= 256, `${key}: ${preset.colors.length} colours`);
    assert.equal(preset.size, preset.colors.length, `${key}: size says ${preset.size}`);
    for (const color of preset.colors) assert.match(color, /^#[0-9a-f]{6}$/, `${key}: ${color}`);
  }
});

test("an unknown preset name finds the palettes it means", () => {
  const keys = searchPresets("endesga").map((hit) => hit.key);
  assert.ok(keys.includes("endesga-32"), `endesga-32 missing from ${keys.join(", ")}`);
  assert.ok(searchPresets("sweetie 16").some((hit) => hit.key === "sweetie-16"));
  // Every word must match, so a second word narrows rather than widens.
  assert.ok(searchPresets("endesga 64").every((hit) => /64/.test(hit.key + hit.preset.name)));
  assert.equal(searchPresets("").length, 0);
  assert.ok(searchPresets("e").length <= 20, "results are capped");
});
