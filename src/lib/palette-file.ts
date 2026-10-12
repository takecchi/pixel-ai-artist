/**
 * Palette files as Aseprite 1.3.15's `Palette{ fromFile = … }` reads them
 * (app/file/palette_file.cpp, load_palette). A file Aseprite would answer null
 * for comes back here as an empty list.
 */

import { ToolError } from "../doc/errors.js";
import { rgba, type Rgba } from "../doc/model.js";
import { decodeAse } from "./ase.js";
import { readImageDocument } from "./image-document.js";

export const PALETTE_EXTENSIONS = [".gpl", ".hex", ".pal", ".act", ".col", ".png", ".gif", ".jpg", ".jpeg", ".ase", ".aseprite"] as const;

const MAX_ACT_COLORS = 256;
const COL_PRO_MAGIC = 0xb123;

/** base::trim_string, including its habit of emptying a one-character string. */
function trim(s: string): string {
  const space = (c: string) => c === " " || (c >= "\t" && c <= "\r");
  let i = 0;
  while (i < s.length && space(s[i]!)) i++;
  let j = s.length - 1;
  while (j > i && space(s[j]!)) j--;
  return i < j ? s.slice(i, j + 1) : "";
}

/** std::getline over the whole file: a final newline does not start another line. */
function lines(bytes: Uint8Array): string[] {
  const all = Buffer.from(bytes).toString("latin1").split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

type Read = { ok: true; value: number } | { ok: false; atEnd: boolean };

/** `istringstream >> int`: skips blanks, takes an optionally signed run of digits. */
class IntStream {
  private pos = 0;
  failed = false;

  constructor(private readonly text: string) {}

  private skipBlanks(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
  }

  int(): Read {
    if (this.failed) return { ok: false, atEnd: false };
    this.skipBlanks();
    if (this.pos >= this.text.length) {
      this.failed = true;
      return { ok: false, atEnd: true };
    }
    const m = /^[+-]?\d+/.exec(this.text.slice(this.pos));
    if (!m) {
      this.failed = true;
      return { ok: false, atEnd: false };
    }
    this.pos += m[0].length;
    return { ok: true, value: Number(m[0]) };
  }

  /** `>> std::string`: a run of non-blank characters, or a failure. */
  word(): string | null {
    if (this.failed) return null;
    this.skipBlanks();
    const m = /^\S+/.exec(this.text.slice(this.pos));
    if (!m) {
      this.failed = true;
      return null;
    }
    this.pos += m[0].length;
    return m[0];
  }
}

// doc/file/gpl_file.cpp
function decodeGpl(bytes: Uint8Array): Rgba[] {
  const all = lines(bytes);
  if (all.length === 0 || trim(all[0]!) !== "GIMP Palette") return [];
  const out: Rgba[] = [];
  let hasAlpha = false;
  for (const raw of all.slice(1)) {
    const line = trim(raw);
    if (line === "" || line[0] === "#") continue;
    if (!(line[0]! >= "0" && line[0]! <= "9")) {
      const parts = line.split(":");
      if (parts.length === 2 && parts[0] === "Channels" && trim(parts[1]!) === "RGBA") hasAlpha = true;
      continue;
    }
    // An entry needs a name token: `lineIn >> entryName` fails at the end of a line without one.
    const s = new IntStream(line);
    const v = [s.int(), s.int(), s.int()];
    const a = hasAlpha ? s.int() : ({ ok: true, value: 255 } as Read);
    const name = s.word();
    if (name === null || s.failed || ![...v, a].every((r) => r.ok)) continue;
    const [r, g, b] = v.map((x) => (x as { value: number }).value) as [number, number, number];
    out.push(rgba(r, g, b, (a as { value: number }).value));
  }
  return out;
}

// doc/file/hex_file.cpp
function decodeHex(bytes: Uint8Array): Rgba[] {
  const out: Rgba[] = [];
  for (const raw of lines(bytes)) {
    const m = /[0-9a-fA-F]{6}/.exec(trim(raw));
    if (m) out.push(rgba(Number.parseInt(m[0].slice(0, 2), 16), Number.parseInt(m[0].slice(2, 4), 16), Number.parseInt(m[0].slice(4, 6), 16)));
  }
  return out;
}

// doc/file/pal_file.cpp
function decodeJascPal(bytes: Uint8Array): Rgba[] {
  const all = lines(bytes);
  if (all.length < 3 || trim(all[0]!) !== "JASC-PAL" || trim(all[1]!) !== "0100") return [];
  const out: Rgba[] = [];
  for (const raw of all.slice(3)) {
    const line = trim(raw);
    if (line === "") continue;
    // A line that stops early keeps the default alpha, and a non-number reads as 0.
    const values = [0, 0, 0, 255];
    const s = new IntStream(line);
    for (let i = 0; i < 4; i++) {
      const r = s.int();
      if (r.ok) values[i] = r.value;
      else {
        if (!r.atEnd) values[i] = 0;
        break;
      }
    }
    out.push(rgba(values[0]!, values[1]!, values[2]!, values[3]!));
  }
  return out;
}

// doc/file/act_file.cpp: the transparent index after the count is not read.
function decodeAct(bytes: Uint8Array): Rgba[] {
  let colors = MAX_ACT_COLORS;
  if (bytes.length >= 770) colors = Math.min((bytes[768]! << 8) | bytes[769]!, MAX_ACT_COLORS);
  const out: Rgba[] = [];
  for (let i = 0; i < colors; i++) out.push(rgba(bytes[i * 3] ?? 0, bytes[i * 3 + 1] ?? 0, bytes[i * 3 + 2] ?? 0));
  return out;
}

// doc/file/col_file.cpp
function decodeCol(bytes: Uint8Array): Rgba[] {
  const size = bytes.length;
  if (size === 0) return [];
  const out: Rgba[] = [];
  if (size === 768) {
    const scale = (v: number) => (Math.min(v, 63) << 2) | (Math.min(v, 63) >> 4);
    for (let c = 0; c < 256; c++) out.push(rgba(scale(bytes[c * 3]!), scale(bytes[c * 3 + 1]!), scale(bytes[c * 3 + 2]!)));
    return out;
  }
  if (size < 8 || (size - 8) % 3 !== 0) return [];
  const magic = bytes[4]! | (bytes[5]! << 8);
  const version = bytes[6]! | (bytes[7]! << 8);
  if (magic !== COL_PRO_MAGIC || version !== 0) return [];
  const count = Math.min((size - 8) / 3, 256);
  for (let c = 0; c < count; c++) out.push(rgba(bytes[8 + c * 3]!, bytes[9 + c * 3]!, bytes[10 + c * 3]!));
  return out;
}

/**
 * An image file's palette: the palette of the document Aseprite would open it
 * as. An RGB image of more than 256 colours, which Aseprite quantises with an
 * octree, is not read as a palette rather than reduced some other way.
 */
function decodeImagePalette(bytes: Uint8Array): Rgba[] {
  try {
    return readImageDocument(bytes).palette ?? [];
  } catch {
    return [];
  }
}

/** The first frame's palette, as Aseprite's load_palette reads an .aseprite document; empty when unreadable. */
function decodeAsePalette(bytes: Uint8Array): Rgba[] {
  let palette: Uint8Array;
  try {
    palette = decodeAse(bytes).palette;
  } catch {
    return [];
  }
  const out: Rgba[] = [];
  for (let i = 0; i < palette.length; i += 4) out.push(rgba(palette[i]!, palette[i + 1]!, palette[i + 2]!, palette[i + 3]!));
  return out;
}

function sniff(bytes: Uint8Array): "png" | "gif" | "jpeg" | "ase" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  const head = Buffer.from(bytes.subarray(0, 6)).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  if (bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) === 0xa5e0) return "ase";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return null;
}

/**
 * The colours of a palette file. Like Aseprite's dio::detect_format, an image
 * or .aseprite file is recognised by its first bytes before its extension is
 * looked at. An empty list means the file holds no palette Aseprite would read.
 */
export function decodePaletteFile(bytes: Uint8Array, ext: string): Rgba[] {
  const kind = sniff(bytes) ?? ext.toLowerCase().replace(/^\./, "");
  switch (kind) {
    case "gpl": return decodeGpl(bytes);
    case "hex": return decodeHex(bytes);
    case "pal": return decodeJascPal(bytes);
    case "act": return decodeAct(bytes);
    case "col": return decodeCol(bytes);
    case "png":
    case "gif":
    case "jpg":
    case "jpeg": return decodeImagePalette(bytes);
    case "ase":
    case "aseprite":
      return decodeAsePalette(bytes);
    default:
      throw new ToolError("unsupported_command", `Cannot read a palette from '${ext || "a file with no extension"}'.`, {
        supported: PALETTE_EXTENSIONS,
      });
  }
}
