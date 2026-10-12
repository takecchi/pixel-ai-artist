/**
 * Pixel templates in `rules/*.md` are fenced ```grid blocks written in the
 * exact shape the `draw` op `grid` takes, so an agent can transcribe one onto
 * the canvas instead of re-deriving it from prose:
 *
 *     ```grid hand-16-open
 *     O = outline      #2b1d2e
 *     L = skin         #f2b48a
 *     ---
 *     .OO.
 *     OLLO
 *     ```
 *
 * Each legend line is `<glyph> = <role> <example hex>`. The role is what an
 * agent maps onto its own palette; the hex is only there so the template can
 * be rendered. `.` is always transparent.
 *
 * Run directly to render every template to PNG for eyeballing:
 *     node --experimental-strip-types scripts/rule-templates.ts [outDir]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

export interface RuleTemplate {
  file: string;
  /** 1-based line of the opening fence, for error messages. */
  line: number;
  name: string;
  legend: Record<string, { role: string; hex: string }>;
  rows: string[];
}

const OPEN = /^```grid(?:\s+(\S+))?\s*$/;
const LEGEND = /^(\S)\s*=\s*(.+?)\s+(#[0-9a-fA-F]{6})\s*$/;

/** Parses every grid block; throws with file:line on a malformed one. */
export function parseTemplates(file: string, text: string): RuleTemplate[] {
  const lines = text.split(/\r?\n/);
  const out: RuleTemplate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i]!);
    if (!open) continue;
    const where = `${file}:${i + 1}`;
    if (!open[1]) throw new Error(`${where}: grid block has no name`);
    const tpl: RuleTemplate = { file, line: i + 1, name: open[1], legend: {}, rows: [] };
    let j = i + 1;
    for (; j < lines.length && lines[j] !== "---"; j++) {
      const m = LEGEND.exec(lines[j]!);
      if (!m) throw new Error(`${file}:${j + 1}: legend line must be '<glyph> = <role> #rrggbb', got '${lines[j]}'`);
      tpl.legend[m[1]!] = { role: m[2]!, hex: m[3]!.toLowerCase() };
    }
    for (j++; j < lines.length && !lines[j]!.startsWith("```"); j++) tpl.rows.push(lines[j]!);
    if (j >= lines.length) throw new Error(`${where}: grid block '${tpl.name}' is not closed`);
    out.push(tpl);
    i = j;
  }
  return out;
}

/** Problems with a template that would make `draw` op `grid` refuse it or paint it wrong. */
export function templateProblems(t: RuleTemplate): string[] {
  const where = `${t.file}:${t.line} '${t.name}'`;
  const problems: string[] = [];
  if (t.rows.length === 0) return [`${where}: no rows`];
  const width = Array.from(t.rows[0]!).length;
  t.rows.forEach((row, r) => {
    const cells = Array.from(row);
    if (cells.length !== width) problems.push(`${where}: row ${r} has ${cells.length} cells, row 0 has ${width}`);
    cells.forEach((g, c) => {
      if (g !== "." && !t.legend[g]) problems.push(`${where}: row ${r} col ${c} uses '${g}', not in the legend`);
    });
  });
  for (const glyph of Object.keys(t.legend)) {
    if (!t.rows.some((row) => row.includes(glyph))) problems.push(`${where}: legend glyph '${glyph}' is never used`);
  }
  return problems;
}

export function loadRuleTemplates(rulesDir: string): RuleTemplate[] {
  return readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => parseTemplates(path.join("rules", f), readFileSync(path.join(rulesDir, f), "utf8")));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Nearest-neighbour PNG, transparent cells as a checkerboard so gaps stay visible. */
export function renderTemplatePng(t: RuleTemplate, scale = 12): Buffer {
  const cells = t.rows.map((r) => Array.from(r));
  const w = cells[0]!.length * scale;
  const h = cells.length * scale;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const g = cells[Math.floor(y / scale)]![Math.floor(x / scale)]!;
      const hex = t.legend[g]?.hex;
      const checker = ((Math.floor(x / 6) + Math.floor(y / 6)) & 1) === 0 ? 0xe6 : 0xcc;
      const o = rowStart + 1 + x * 3;
      raw[o] = hex ? parseInt(hex.slice(1, 3), 16) : checker;
      raw[o + 1] = hex ? parseInt(hex.slice(3, 5), 16) : checker;
      raw[o + 2] = hex ? parseInt(hex.slice(5, 7), 16) : checker;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..");
  const outDir = path.resolve(process.argv[2] ?? path.join(root, ".turbo", "rule-templates"));
  const only = process.argv[3];
  mkdirSync(outDir, { recursive: true });
  let bad = 0;
  for (const t of loadRuleTemplates(path.join(root, "rules"))) {
    if (only && !t.file.includes(only)) continue;
    const problems = templateProblems(t);
    problems.forEach((p) => console.error(p));
    bad += problems.length;
    const file = path.join(outDir, `${path.basename(t.file, ".md")}--${t.name}.png`);
    if (problems.length === 0) writeFileSync(file, renderTemplatePng(t));
    console.log(file);
  }
  process.exitCode = bad > 0 ? 1 : 0;
}
