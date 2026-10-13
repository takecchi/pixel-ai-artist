import { parseHex, snapToPalette, toHex, type Rgb } from "./color.js";
import { fromRgbaBytes, type AnimationFrame } from "./image.js";

export interface EncodeGifOptions {
  /** Colours opaque pixels snap to by ΔE. Without it the table holds the colours the frames use. */
  palette?: readonly string[];
  loop?: number | false;
}

export interface DecodedGif {
  width: number;
  height: number;
  loop: number | null;
  frames: AnimationFrame[];
  /** The global colour table as opaque 0xRRGGBBAA, null when there is none. */
  globalPalette: number[] | null;
  /** The logical screen's background colour index. */
  backgroundIndex: number;
  /** The first frame's transparent colour index, -1 when it has none. */
  transparentIndex: number;
  /** Whether any frame carries its own colour table. */
  localColorTables: boolean;
}

const MAX_DIMENSION = 16384;

class Truncated extends Error {
  constructor() {
    super("GIF data ends unexpectedly");
  }
}

function lzwEncode(indices: Uint8Array, minCode: number): number[] {
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  const put = (code: number, size: number): void => {
    acc |= code << accBits;
    accBits += size;
    while (accBits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  };
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let dict = new Map<number, number>();
  let next = eoi + 1;
  let size = minCode + 1;
  put(clear, size);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix, size);
    dict.set(key, next);
    if (next === 1 << size) size++;
    next++;
    if (next === 4096) {
      put(clear, size);
      dict = new Map();
      next = eoi + 1;
      size = minCode + 1;
    }
    prefix = k;
  }
  put(prefix, size);
  put(eoi, size);
  if (accBits > 0) out.push(acc & 0xff);
  return out;
}

function opaqueRgb(rgb: number): Rgb {
  return { r: rgb >>> 16, g: (rgb >>> 8) & 255, b: rgb & 255, a: 255 };
}

export function encodeGif(frames: AnimationFrame[], opts: EncodeGifOptions = {}): Uint8Array {
  if (frames.length === 0) throw new RangeError("a GIF needs at least one frame");
  const first = frames[0]!.image;
  for (const f of frames) {
    if (f.image.width !== first.width || f.image.height !== first.height) {
      throw new RangeError("all frames must have the same dimensions");
    }
  }
  const { width, height } = first;
  if (width > 0xffff || height > 0xffff) throw new RangeError(`image ${width}x${height} is too large for GIF`);
  const loop = opts.loop === undefined ? 0 : opts.loop;
  if (loop !== false && (!Number.isInteger(loop) || loop < 0 || loop > 0xffff)) {
    throw new RangeError(`loop must be false or an integer in 0..65535, got ${loop}`);
  }

  let table: string[];
  let lookup: (rgb: number) => number;
  if (opts.palette) {
    table = opts.palette.filter((hex) => parseHex(hex).a === 255);
    if (table.length === 0) throw new RangeError("palette has no opaque colour to map pixels to");
    if (table.length > 256) throw new RangeError(`a GIF holds at most 256 colours, the palette has ${table.length} opaque`);
    const opaque = table;
    lookup = (rgb) => snapToPalette(opaqueRgb(rgb), opaque).index;
  } else {
    table = [];
    const seen = new Map<number, number>();
    for (const f of frames) {
      for (const v of f.image.pixels) {
        if ((v & 255) < 128) continue;
        const rgb = v >>> 8;
        if (!seen.has(rgb)) {
          seen.set(rgb, table.length);
          table.push(toHex(opaqueRgb(rgb)));
        }
      }
    }
    if (table.length > 256) throw new RangeError(`a GIF holds at most 256 colours, the frames use ${table.length}`);
    lookup = (rgb) => seen.get(rgb)!;
  }
  const colorCount = table.length;

  const cache = new Map<number, number>();
  let anyTransparent = false;
  const used = new Uint8Array(256);
  const mapped = frames.map((f) => {
    const src = f.image.pixels;
    const idx = new Uint8Array(width * height);
    for (let p = 0; p < idx.length; p++) {
      const v = src[p]!;
      if ((v & 255) < 128) {
        anyTransparent = true;
        continue;
      }
      const rgb = v >>> 8;
      let i = cache.get(rgb);
      if (i === undefined) {
        i = lookup(rgb);
        cache.set(rgb, i);
      }
      idx[p] = i;
      used[i] = 1;
    }
    return idx;
  });

  let tableCount = Math.max(colorCount, 1);
  let transparentIndex = -1;
  if (anyTransparent) {
    if (colorCount < 256) {
      transparentIndex = colorCount;
      tableCount = colorCount + 1;
    } else {
      transparentIndex = used.indexOf(0);
      if (transparentIndex < 0) {
        if (!opts.palette) throw new RangeError("a GIF holds at most 256 colours, the frames use 256 and transparency");
        transparentIndex = 255;
        const rest = table.slice(0, 255);
        const second = new Map<number, number>();
        frames.forEach((f, fi) => {
          const src = f.image.pixels;
          const idx = mapped[fi]!;
          for (let p = 0; p < idx.length; p++) {
            if ((src[p]! & 255) < 128 || idx[p] !== 255) continue;
            const rgb = src[p]! >>> 8;
            let i = second.get(rgb);
            if (i === undefined) {
              i = snapToPalette(opaqueRgb(rgb), rest).index;
              second.set(rgb, i);
            }
            idx[p] = i;
          }
        });
      }
    }
    frames.forEach((f, fi) => {
      const src = f.image.pixels;
      const idx = mapped[fi]!;
      for (let p = 0; p < idx.length; p++) if ((src[p]! & 255) < 128) idx[p] = transparentIndex;
    });
  }
  const rgbTable = table.map(parseHex);

  let tableBits = 1;
  while (1 << tableBits < tableCount) tableBits++;
  const minCode = Math.max(2, tableBits);

  const out: number[] = [];
  const u16 = (v: number): void => {
    out.push(v & 0xff, (v >> 8) & 0xff);
  };
  for (const c of "GIF89a") out.push(c.charCodeAt(0));
  u16(width);
  u16(height);
  out.push(0x80 | (7 << 4) | (tableBits - 1), 0, 0);
  for (let i = 0; i < 1 << tableBits; i++) {
    const c = rgbTable[i];
    if (c) out.push(c.r, c.g, c.b);
    else out.push(0, 0, 0);
  }
  if (loop !== false) {
    out.push(0x21, 0xff, 11);
    for (const c of "NETSCAPE2.0") out.push(c.charCodeAt(0));
    out.push(3, 1);
    u16(loop);
    out.push(0);
  }
  frames.forEach((f, fi) => {
    const delay = Math.min(0xffff, Math.max(1, Math.round(f.durationMs / 10)));
    const disposal = anyTransparent ? 2 : 1;
    out.push(0x21, 0xf9, 4, (disposal << 2) | (anyTransparent ? 1 : 0));
    u16(delay);
    out.push(anyTransparent ? transparentIndex : 0, 0);
    out.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    out.push(0, minCode);
    const data = lzwEncode(mapped[fi]!, minCode);
    for (let o = 0; o < data.length; o += 255) {
      const n = Math.min(255, data.length - o);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(data[o + j]!);
    }
    out.push(0);
  });
  out.push(0x3b);
  return Uint8Array.from(out);
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Truncated();
    return this.bytes[this.pos++]!;
  }
  u16(): number {
    const lo = this.u8();
    return lo | (this.u8() << 8);
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Truncated();
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  subBlocks(): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const n = this.u8();
      if (n === 0) break;
      const b = this.take(n);
      parts.push(b);
      total += n;
    }
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    return all;
  }
}

function lzwDecode(data: Uint8Array, minCode: number, out: Uint8Array): void {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let next = eoi + 1;
  let size = minCode + 1;
  let prev = -1;
  let acc = 0;
  let accBits = 0;
  let pos = 0;
  let count = 0;
  while (count < out.length) {
    while (accBits < size && pos < data.length) {
      acc |= data[pos++]! << accBits;
      accBits += 8;
    }
    if (accBits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    accBits -= size;
    if (code === clear) {
      next = eoi + 1;
      size = minCode + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    let sp = 0;
    let c: number;
    if (prev === -1) {
      if (code >= clear) throw new Error("invalid LZW stream");
      stack[sp++] = code;
      c = code;
    } else {
      if (code > next || (code === next && next >= 4096)) throw new Error("invalid LZW stream");
      let root = prev;
      while (root >= clear) root = prefix[root]!;
      if (code === next) {
        stack[sp++] = root;
        c = prev;
      } else {
        c = code;
      }
      while (c >= clear) {
        stack[sp++] = suffix[c]!;
        c = prefix[c]!;
      }
      stack[sp++] = c;
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = code === next ? root : c;
        next++;
        if (next === 1 << size && size < 12) size++;
      }
    }
    while (sp > 0 && count < out.length) out[count++] = stack[--sp]!;
    prev = code;
  }
}

const INTERLACE_PASSES: ReadonlyArray<readonly [number, number]> = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
];

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const r = new Reader(bytes);
  let sig = "";
  try {
    sig = String.fromCharCode(...r.take(6));
  } catch {
    throw new Error("not a GIF: file is too short");
  }
  if (sig !== "GIF87a" && sig !== "GIF89a") throw new Error("not a GIF: bad signature");
  let width: number;
  let height: number;
  let globalTable: Uint8Array = new Uint8Array(0);
  let hasGlobalTable = false;
  let backgroundIndex = 0;
  let transparentIndex = -1;
  let localColorTables = false;
  try {
    width = r.u16();
    height = r.u16();
    const packed = r.u8();
    backgroundIndex = r.u8();
    r.u8();
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new RangeError(`GIF ${width}x${height} exceeds ${MAX_DIMENSION}`);
    }
    if (packed & 0x80) {
      globalTable = r.take(3 * (2 << (packed & 7)));
      hasGlobalTable = true;
    }
  } catch (e) {
    if (e instanceof Truncated) throw new Error("GIF header is truncated");
    throw e;
  }
  if (width < 1 || height < 1) throw new Error("GIF has an empty screen");

  const canvas = new Uint8Array(width * height * 4);
  const frames: AnimationFrame[] = [];
  let loop: number | null = null;
  let gce: { disposal: number; delay: number; transparent: number } | null = null;

  try {
    for (;;) {
      const tag = r.u8();
      if (tag === 0x3b) break;
      if (tag === 0x21) {
        const label = r.u8();
        if (label === 0xf9) {
          const block = r.subBlocks();
          if (block.length >= 4) {
            gce = {
              disposal: (block[0]! >> 2) & 7,
              delay: block[1]! | (block[2]! << 8),
              transparent: block[0]! & 1 ? block[3]! : -1,
            };
          }
        } else if (label === 0xff) {
          const n = r.u8();
          const id = n === 0 ? new Uint8Array(0) : r.take(n);
          const name = String.fromCharCode(...id);
          const rest: Uint8Array[] = [];
          for (;;) {
            const m = r.u8();
            if (m === 0) break;
            rest.push(r.take(m));
          }
          if ((name === "NETSCAPE2.0" || name === "ANIMEXTS1.0") && loop === null) {
            const sub = rest[0];
            if (sub && sub.length >= 3 && sub[0] === 1) loop = sub[1]! | (sub[2]! << 8);
          }
        } else {
          r.subBlocks();
        }
        continue;
      }
      if (tag !== 0x2c) {
        if (frames.length === 0) throw new Error(`unexpected block 0x${tag.toString(16)}`);
        break;
      }
      const left = r.u16();
      const top = r.u16();
      const fw = r.u16();
      const fh = r.u16();
      const packed = r.u8();
      if (packed & 0x80) localColorTables = true;
      const table = packed & 0x80 ? r.take(3 * (2 << (packed & 7))) : globalTable;
      const minCode = r.u8();
      if (minCode < 1 || minCode > 8) throw new Error(`invalid LZW minimum code size ${minCode}`);
      const data = r.subBlocks();
      const pixels = new Uint8Array(fw * fh);
      lzwDecode(data, minCode, pixels);

      const disposal = gce?.disposal ?? 0;
      const transparent = gce?.transparent ?? -1;
      if (frames.length === 0) transparentIndex = transparent;
      const saved = disposal === 3 ? canvas.slice() : null;
      const interlaced = (packed & 0x40) !== 0;
      const rowOrder: number[] = [];
      if (interlaced) {
        for (const [start, step] of INTERLACE_PASSES) for (let y = start; y < fh; y += step) rowOrder.push(y);
      } else {
        for (let y = 0; y < fh; y++) rowOrder.push(y);
      }
      for (let i = 0; i < rowOrder.length; i++) {
        const y = top + rowOrder[i]!;
        if (y >= height) continue;
        for (let x = 0; x < fw; x++) {
          const cx = left + x;
          if (cx >= width) break;
          const v = pixels[i * fw + x]!;
          if (v === transparent) continue;
          const o = (y * width + cx) * 4;
          if (v * 3 + 2 < table.length) {
            canvas[o] = table[v * 3]!;
            canvas[o + 1] = table[v * 3 + 1]!;
            canvas[o + 2] = table[v * 3 + 2]!;
          } else {
            canvas[o] = canvas[o + 1] = canvas[o + 2] = 0;
          }
          canvas[o + 3] = 255;
        }
      }
      frames.push({
        image: fromRgbaBytes(width, height, canvas),
        // Aseprite gives a frame with no graphic control extension a delay of one centisecond.
        durationMs: (gce ? gce.delay : 1) * 10,
      });
      if (disposal === 2) {
        for (let y = top; y < Math.min(height, top + fh); y++) {
          const x1 = Math.min(width, left + fw);
          if (left < x1) canvas.fill(0, (y * width + left) * 4, (y * width + x1) * 4);
        }
      } else if (saved) {
        canvas.set(saved);
      }
      gce = null;
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  if (frames.length === 0) throw new Error("GIF contains no readable frame");
  const globalPalette: number[] | null = [];
  for (let i = 0; i + 2 < globalTable.length; i += 3) {
    globalPalette.push(((globalTable[i]! << 24) | (globalTable[i + 1]! << 16) | (globalTable[i + 2]! << 8) | 255) >>> 0);
  }
  return {
    width,
    height,
    loop,
    frames,
    globalPalette: hasGlobalTable ? globalPalette : null,
    backgroundIndex,
    transparentIndex,
    localColorTables,
  };
}
