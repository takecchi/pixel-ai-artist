import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { Image } from "../doc/model.js";
import { fromRgbaBytes, toRgbaBytes } from "./image.js";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_DIMENSION = 16384;

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function assemble(width: number, height: number, colorType: number, chunks: Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr), ...chunks, chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function filterRows(pixels: Uint8Array, rowBytes: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * height);
  const candidate = new Uint8Array(rowBytes);
  const best = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? pixels.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    let bestType = 0;
    let bestSum = Infinity;
    for (let type = 0; type < 5; type++) {
      let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev ? prev[i]! : 0;
        const c = prev && i >= bpp ? prev[i - bpp]! : 0;
        let pred = 0;
        if (type === 1) pred = a;
        else if (type === 2) pred = b;
        else if (type === 3) pred = (a + b) >> 1;
        else if (type === 4) pred = paeth(a, b, c);
        const v = (row[i]! - pred) & 255;
        candidate[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        best.set(candidate);
      }
    }
    out[y * (rowBytes + 1)] = bestType;
    out.set(best, y * (rowBytes + 1) + 1);
  }
  return out;
}

export function encodePng(img: Image): Uint8Array {
  const idat = deflateSync(filterRows(toRgbaBytes(img), img.width * 4, img.height, 4));
  return assemble(img.width, img.height, 6, [chunk("IDAT", idat)]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function unfilter(data: Uint8Array, pos: number, rowBytes: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const type = data[pos++]!;
    if (type > 4) throw new Error(`invalid PNG scanline filter type ${type} at row ${y}`);
    const base = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[base + i - bpp]! : 0;
      const b = y > 0 ? out[base - rowBytes + i]! : 0;
      const c = y > 0 && i >= bpp ? out[base - rowBytes + i - bpp]! : 0;
      let pred = 0;
      if (type === 1) pred = a;
      else if (type === 2) pred = b;
      else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) pred = paeth(a, b, c);
      out[base + i] = (data[pos + i]! + pred) & 255;
    }
    pos += rowBytes;
  }
  return out;
}

export function decodePng(bytes: Uint8Array): Image {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) {
    throw new Error("not a PNG: bad signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawEnd = false;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idats: Uint8Array[] = [];
  let sawIdat = false;
  let idatEnded = false;
  let index = 0;

  while (!sawEnd) {
    if (pos + 8 > bytes.length) throw new Error("PNG is truncated: missing IEND chunk");
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`invalid chunk type at offset ${pos + 4}`);
    if (pos + 12 + length > bytes.length) throw new Error(`PNG is truncated inside the ${type} chunk`);
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    const stored = view.getUint32(pos + 8 + length);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== stored) {
      throw new Error(`CRC mismatch in ${type} chunk`);
    }
    pos += 12 + length;

    if (index === 0 && type !== "IHDR") throw new Error("first chunk must be IHDR");
    index++;
    if (type === "IHDR") {
      if (sawHeader) throw new Error("duplicate IHDR chunk");
      if (length !== 13) throw new Error(`IHDR must be 13 bytes, got ${length}`);
      const bv = new DataView(body.buffer, body.byteOffset, 13);
      width = bv.getUint32(0);
      height = bv.getUint32(4);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
      if (width === 0 || height === 0) throw new Error(`invalid image size ${width}x${height}`);
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new RangeError(`image size ${width}x${height} exceeds the ${MAX_DIMENSION} pixel limit`);
      }
      const depths = VALID_DEPTHS[colorType];
      if (!depths) throw new Error(`invalid color type ${colorType}`);
      if (!depths.includes(depth)) throw new Error(`bit depth ${depth} is not allowed for color type ${colorType}`);
      if (body[10] !== 0) throw new Error(`unknown compression method ${body[10]}`);
      if (body[11] !== 0) throw new Error(`unknown filter method ${body[11]}`);
      if (interlace > 1) throw new Error(`unknown interlace method ${interlace}`);
      sawHeader = true;
    } else if (type === "IDAT") {
      if (idatEnded) throw new Error("IDAT chunks are not contiguous");
      if (colorType === 3 && !plte) throw new Error("palette image has no PLTE chunk before IDAT");
      sawIdat = true;
      idats.push(body);
    } else {
      if (sawIdat) idatEnded = true;
      if (type === "IEND") {
        if (length !== 0) throw new Error("IEND chunk must be empty");
        sawEnd = true;
      } else if (type === "PLTE") {
        if (plte) throw new Error("duplicate PLTE chunk");
        if (sawIdat) throw new Error("PLTE chunk after IDAT");
        if (length === 0 || length % 3 !== 0 || length > 768) throw new Error(`invalid PLTE length ${length}`);
        if (colorType === 0 || colorType === 4) throw new Error(`PLTE is not allowed for color type ${colorType}`);
        if (colorType === 3 && length / 3 > 1 << depth) throw new Error("PLTE has more colors than the bit depth allows");
        plte = body;
      } else if (type === "tRNS") {
        if (sawIdat) throw new Error("tRNS chunk after IDAT");
        trns = body;
      } else if (type.charCodeAt(0) < 97) {
        throw new Error(`unknown critical chunk ${type}`);
      }
    }
  }
  if (pos !== bytes.length) throw new Error("unexpected data after IEND chunk");
  if (!sawIdat) throw new Error("PNG has no IDAT chunk");

  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
  const dims = passes.map(([x0, y0, dx, dy]) => {
    const pw = Math.floor((width - x0! + dx! - 1) / dx!);
    const ph = Math.floor((height - y0! + dy! - 1) / dy!);
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    return { pw, ph, rowBytes, size: pw > 0 && ph > 0 ? (rowBytes + 1) * ph : 0 };
  });
  const expected = dims.reduce((n, d) => n + d.size, 0);

  const compressed = new Uint8Array(idats.reduce((n, p) => n + p.length, 0));
  let cp = 0;
  for (const p of idats) {
    compressed.set(p, cp);
    cp += p.length;
  }
  let raw: Uint8Array;
  try {
    raw = inflateSync(compressed, { maxOutputLength: Math.max(expected, 1) });
  } catch (e) {
    throw new Error(`cannot inflate image data: ${(e as Error).message}`);
  }
  if (raw.length !== expected) throw new Error(`image data holds ${raw.length} bytes, expected ${expected}`);

  const palette = new Uint8Array(colorType === 3 ? (plte!.length / 3) * 4 : 0);
  if (colorType === 3) {
    for (let i = 0; i < palette.length / 4; i++) {
      palette[i * 4] = plte![i * 3]!;
      palette[i * 4 + 1] = plte![i * 3 + 1]!;
      palette[i * 4 + 2] = plte![i * 3 + 2]!;
      palette[i * 4 + 3] = trns && i < trns.length ? trns[i]! : 255;
    }
  }
  let keyGray = -1;
  let keyRgb: number[] | null = null;
  if (trns && colorType === 0) {
    if (trns.length !== 2) throw new Error("tRNS for grayscale must be 2 bytes");
    keyGray = (trns[0]! << 8) | trns[1]!;
  } else if (trns && colorType === 2) {
    if (trns.length !== 6) throw new Error("tRNS for truecolor must be 6 bytes");
    keyRgb = [0, 1, 2].map((i) => (trns![i * 2]! << 8) | trns![i * 2 + 1]!);
  } else if (trns && colorType === 3 && trns.length > palette.length / 4) {
    throw new Error("tRNS has more entries than the palette");
  }

  const data = new Uint8Array(width * height * 4);
  const maxSample = (1 << depth) - 1;
  let rawPos = 0;
  for (let p = 0; p < passes.length; p++) {
    const [x0, y0, dx, dy] = passes[p]!;
    const { pw, ph, rowBytes, size } = dims[p]!;
    if (size === 0) continue;
    const px = unfilter(raw, rawPos, rowBytes, ph, bpp);
    rawPos += size;

    const sample = (row: number, n: number): number => {
      const base = row * rowBytes;
      if (depth === 8) return px[base + n]!;
      if (depth === 16) return (px[base + n * 2]! << 8) | px[base + n * 2 + 1]!;
      const bit = n * depth;
      return (px[base + (bit >> 3)]! >> (8 - depth - (bit & 7))) & maxSample;
    };
    const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxSample));

    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const o = ((y0! + y * dy!) * width + x0! + x * dx!) * 4;
        const n = x * channels;
        if (colorType === 3) {
          const v = sample(y, n);
          if (v * 4 >= palette.length) throw new Error(`palette index ${v} is outside the ${palette.length / 4}-color palette`);
          data.set(palette.subarray(v * 4, v * 4 + 4), o);
        } else if (colorType === 0 || colorType === 4) {
          const v = sample(y, n);
          const g = to8(v);
          data[o] = data[o + 1] = data[o + 2] = g;
          data[o + 3] = colorType === 4 ? to8(sample(y, n + 1)) : v === keyGray ? 0 : 255;
        } else {
          const r = sample(y, n);
          const g = sample(y, n + 1);
          const b = sample(y, n + 2);
          data[o] = to8(r);
          data[o + 1] = to8(g);
          data[o + 2] = to8(b);
          data[o + 3] =
            colorType === 6 ? to8(sample(y, n + 3)) : keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255;
        }
      }
    }
  }

  return fromRgbaBytes(width, height, data);
}
