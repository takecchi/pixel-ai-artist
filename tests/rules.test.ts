import { strict as assert } from "node:assert";
import { test } from "node:test";
import path from "node:path";
import { compileGrid } from "../dist/lib/grid.js";
import { loadRuleTemplates, templateProblems } from "../scripts/rule-templates.ts";

const rulesDir = path.resolve(import.meta.dirname, "..", "rules");

test("every pixel template in the rulebook is a grid `draw` would accept as written", () => {
  // Agents transcribe these straight into `draw` op `grid`; a ragged row or an
  // undeclared glyph there is an error mid-drawing, or a silently shifted limb.
  const templates = loadRuleTemplates(rulesDir);
  const problems = templates.flatMap(templateProblems);
  assert.deepEqual(problems, []);

  for (const t of templates) {
    const legend = Object.fromEntries(Object.entries(t.legend).map(([g, v]) => [g, v.hex]));
    const width = Array.from(t.rows[0]!).length;
    assert.doesNotThrow(
      () => compileGrid({ x: 0, y: 0, legend, rows: t.rows, transparent: "skip" }, { width, height: t.rows.length }),
      `${t.file}:${t.line} '${t.name}'`,
    );
  }
});

test("template names are unique, so a rule can point at one unambiguously", () => {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const t of loadRuleTemplates(rulesDir)) {
    const prior = seen.get(t.name);
    if (prior) clashes.push(`${t.name}: ${prior} and ${t.file}:${t.line}`);
    seen.set(t.name, `${t.file}:${t.line}`);
  }
  assert.deepEqual(clashes, []);
});
