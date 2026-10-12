import { Image } from "../doc/model.js";

const MAX_DIMENSION = 16384;

const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35,
  42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const UNSUPPORTED_SOF: Record<number, string> = {
  0xc3: "lossless JPEG",
  0xc5: "hierarchical JPEG (differential sequential DCT)",
  0xc6: "hierarchical JPEG (differential progressive DCT)",
  0xc7: "hierarchical JPEG (differential lossless)",
  0xc9: "arithmetic-coded JPEG (sequential)",
  0xca: "arithmetic-coded JPEG (progressive)",
  0xcb: "arithmetic-coded JPEG (lossless)",
  0xcd: "arithmetic-coded hierarchical JPEG",
  0xce: "arithmetic-coded hierarchical JPEG",
  0xcf: "arithmetic-coded hierarchical JPEG",
  0xcc: "arithmetic-coded JPEG (DAC segment)",
};

interface HuffmanTable {
  maxcode: Int32Array;
  mincode: Int32Array;
  valptr: Int32Array;
  values: Uint8Array;
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  width: number;
  height: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  coefs: Int16Array;
  quant: Int32Array | null;
  pred: number;
}

interface ScanComponent {
  c: Component;
  dc: HuffmanTable | null;
  ac: HuffmanTable | null;
}

interface Frame {
  progressive: boolean;
  width: number;
  height: number;
  hmax: number;
  vmax: number;
  mcusX: number;
  mcusY: number;
  components: Component[];
}

function truncated(): Error {
  return new Error("JPEG is truncated");
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): HuffmanTable {
  const maxcode = new Int32Array(17);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1]!;
    valptr[len] = k;
    mincode[len] = code;
    code += n;
    k += n;
    if (code > 1 << len) throw new Error("invalid Huffman table: code lengths over-subscribed");
    maxcode[len] = n > 0 ? code - 1 : -1;
    code <<= 1;
  }
  return { maxcode, mincode, valptr, values };
}

class BitReader {
  pos: number;
  private buf = 0;
  private count = 0;

  constructor(
    private readonly data: Uint8Array,
    pos: number,
  ) {
    this.pos = pos;
  }

  bit(): number {
    if (this.count === 0) {
      const d = this.data;
      if (this.pos >= d.length) throw truncated();
      const b = d[this.pos]!;
      if (b === 0xff) {
        const next = d[this.pos + 1];
        if (next === undefined) throw truncated();
        if (next !== 0) throw new Error(`JPEG scan data ends early at marker 0xFF${next.toString(16).toUpperCase()}`);
        this.pos += 2;
      } else {
        this.pos++;
      }
      this.buf = b;
      this.count = 8;
    }
    this.count--;
    return (this.buf >> this.count) & 1;
  }

  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  extend(n: number): number {
    const v = this.receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  huffman(t: HuffmanTable): number {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.bit();
      if (code <= t.maxcode[len]!) return t.values[t.valptr[len]! + code - t.mincode[len]!]!;
    }
    throw new Error("invalid Huffman code in JPEG scan data");
  }

  restart(index: number): void {
    this.count = 0;
    const d = this.data;
    if (this.pos + 1 >= d.length) throw truncated();
    if (d[this.pos] !== 0xff || d[this.pos + 1] !== 0xd0 + (index & 7)) {
      throw new Error(`missing restart marker RST${index & 7} at offset ${this.pos}`);
    }
    this.pos += 2;
  }
}

function decodeScan(
  frame: Frame,
  scan: ScanComponent[],
  ss: number,
  se: number,
  ah: number,
  al: number,
  restartInterval: number,
  data: Uint8Array,
  start: number,
): number {
  const bits = new BitReader(data, start);
  let eobrun = 0;

  const dcFirst = (s: ScanComponent, off: number): void => {
    const t = bits.huffman(s.dc!);
    s.c.pred += t === 0 ? 0 : bits.extend(t);
    s.c.coefs[off] = s.c.pred * (1 << al);
  };
  const dcRefine = (s: ScanComponent, off: number): void => {
    if (bits.bit()) s.c.coefs[off]! |= 1 << al;
  };
  const sequential = (s: ScanComponent, off: number): void => {
    const coefs = s.c.coefs;
    const t = bits.huffman(s.dc!);
    s.c.pred += t === 0 ? 0 : bits.extend(t);
    coefs[off] = s.c.pred;
    for (let k = 1; k < 64; ) {
      const rs = bits.huffman(s.ac!);
      const size = rs & 15;
      const run = rs >> 4;
      if (size === 0) {
        if (run < 15) break;
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) throw new Error("JPEG block has more than 64 coefficients");
      coefs[off + ZIGZAG[k]!] = bits.extend(size);
      k++;
    }
  };
  const acFirst = (s: ScanComponent, off: number): void => {
    if (eobrun > 0) {
      eobrun--;
      return;
    }
    const coefs = s.c.coefs;
    for (let k = ss; k <= se; k++) {
      const rs = bits.huffman(s.ac!);
      const size = rs & 15;
      const run = rs >> 4;
      if (size === 0) {
        if (run < 15) {
          eobrun = (1 << run) + bits.receive(run) - 1;
          break;
        }
        k += 15;
        continue;
      }
      k += run;
      if (k > se) throw new Error("JPEG block has more than 64 coefficients");
      coefs[off + ZIGZAG[k]!] = bits.extend(size) * (1 << al);
    }
  };
  const acRefine = (s: ScanComponent, off: number): void => {
    const coefs = s.c.coefs;
    const p1 = 1 << al;
    const m1 = -1 << al;
    const refine = (i: number): void => {
      const v = coefs[i]!;
      if (bits.bit() && (v & p1) === 0) coefs[i] = v + (v >= 0 ? p1 : m1);
    };
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = bits.huffman(s.ac!);
        let size = rs & 15;
        let run = rs >> 4;
        if (size !== 0) {
          if (size !== 1) throw new Error("invalid JPEG successive approximation coefficient");
          size = bits.bit() ? p1 : m1;
        } else if (run !== 15) {
          eobrun = (1 << run) + bits.receive(run);
          break;
        }
        while (k <= se) {
          const i = off + ZIGZAG[k]!;
          if (coefs[i] !== 0) {
            refine(i);
          } else if (--run < 0) {
            break;
          }
          k++;
        }
        if (size !== 0) {
          if (k > se) throw new Error("JPEG block has more than 64 coefficients");
          coefs[off + ZIGZAG[k]!] = size;
        }
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const i = off + ZIGZAG[k]!;
        if (coefs[i] !== 0) refine(i);
      }
      eobrun--;
    }
  };

  let decodeBlock: (s: ScanComponent, off: number) => void;
  if (!frame.progressive) decodeBlock = sequential;
  else if (ss === 0) decodeBlock = ah === 0 ? dcFirst : dcRefine;
  else decodeBlock = ah === 0 ? acFirst : acRefine;

  const interleaved = scan.length > 1;
  const first = scan[0]!.c;
  const blocksX = Math.ceil(first.width / 8);
  const blocksY = Math.ceil(first.height / 8);
  const total = interleaved ? frame.mcusX * frame.mcusY : blocksX * blocksY;

  for (let n = 0; n < total; n++) {
    if (restartInterval > 0 && n > 0 && n % restartInterval === 0) {
      bits.restart(n / restartInterval - 1);
      eobrun = 0;
      for (const s of scan) s.c.pred = 0;
    }
    if (interleaved) {
      const mx = n % frame.mcusX;
      const my = (n - mx) / frame.mcusX;
      for (const s of scan) {
        const c = s.c;
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            decodeBlock(s, ((my * c.v + by) * c.blocksPerLine + mx * c.h + bx) * 64);
          }
        }
      }
    } else {
      const x = n % blocksX;
      decodeBlock(scan[0]!, (((n - x) / blocksX) * first.blocksPerLine + x) * 64);
    }
  }
  return bits.pos;
}

const ws = new Int32Array(64);

function idctBlock(coefs: Int16Array, off: number, q: Int32Array, out: Uint8Array, outOff: number, stride: number): void {
  for (let c = 0; c < 8; c++) {
    const i = off + c;
    if (
      coefs[i + 8] === 0 &&
      coefs[i + 16] === 0 &&
      coefs[i + 24] === 0 &&
      coefs[i + 32] === 0 &&
      coefs[i + 40] === 0 &&
      coefs[i + 48] === 0 &&
      coefs[i + 56] === 0
    ) {
      const dc = (coefs[i]! * q[c]!) << 2;
      for (let r = 0; r < 8; r++) ws[c + r * 8] = dc;
      continue;
    }
    const v = (r: number): number => coefs[i + r * 8]! * q[c + r * 8]!;
    let z2 = v(2);
    let z3 = v(6);
    let z1 = (z2 + z3) * 4433;
    let tmp2 = z1 + z3 * -15137;
    let tmp3 = z1 + z2 * 6270;
    z2 = v(0);
    z3 = v(4);
    let tmp0 = (z2 + z3) << 13;
    let tmp1 = (z2 - z3) << 13;
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;
    tmp0 = v(7);
    tmp1 = v(5);
    tmp2 = v(3);
    tmp3 = v(1);
    z1 = tmp0 + tmp3;
    z2 = tmp1 + tmp2;
    z3 = tmp0 + tmp2;
    let z4 = tmp1 + tmp3;
    const z5 = (z3 + z4) * 9633;
    tmp0 *= 2446;
    tmp1 *= 16819;
    tmp2 *= 25172;
    tmp3 *= 12299;
    z1 *= -7373;
    z2 *= -20995;
    z3 = z3 * -16069 + z5;
    z4 = z4 * -3196 + z5;
    tmp0 += z1 + z3;
    tmp1 += z2 + z4;
    tmp2 += z2 + z3;
    tmp3 += z1 + z4;
    ws[c] = (tmp10 + tmp3 + 1024) >> 11;
    ws[c + 56] = (tmp10 - tmp3 + 1024) >> 11;
    ws[c + 8] = (tmp11 + tmp2 + 1024) >> 11;
    ws[c + 48] = (tmp11 - tmp2 + 1024) >> 11;
    ws[c + 16] = (tmp12 + tmp1 + 1024) >> 11;
    ws[c + 40] = (tmp12 - tmp1 + 1024) >> 11;
    ws[c + 24] = (tmp13 + tmp0 + 1024) >> 11;
    ws[c + 32] = (tmp13 - tmp0 + 1024) >> 11;
  }
  for (let r = 0; r < 8; r++) {
    const w = r * 8;
    const o = outOff + r * stride;
    let z2 = ws[w + 2]!;
    let z3 = ws[w + 6]!;
    let z1 = (z2 + z3) * 4433;
    let tmp2 = z1 + z3 * -15137;
    let tmp3 = z1 + z2 * 6270;
    z2 = ws[w]!;
    z3 = ws[w + 4]!;
    let tmp0 = (z2 + z3) << 13;
    let tmp1 = (z2 - z3) << 13;
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;
    tmp0 = ws[w + 7]!;
    tmp1 = ws[w + 5]!;
    tmp2 = ws[w + 3]!;
    tmp3 = ws[w + 1]!;
    z1 = tmp0 + tmp3;
    z2 = tmp1 + tmp2;
    z3 = tmp0 + tmp2;
    let z4 = tmp1 + tmp3;
    const z5 = (z3 + z4) * 9633;
    tmp0 *= 2446;
    tmp1 *= 16819;
    tmp2 *= 25172;
    tmp3 *= 12299;
    z1 *= -7373;
    z2 *= -20995;
    z3 = z3 * -16069 + z5;
    z4 = z4 * -3196 + z5;
    tmp0 += z1 + z3;
    tmp1 += z2 + z4;
    tmp2 += z2 + z3;
    tmp3 += z1 + z4;
    const s = 1 << 17;
    out[o] = clamp(((tmp10 + tmp3 + s) >> 18) + 128);
    out[o + 7] = clamp(((tmp10 - tmp3 + s) >> 18) + 128);
    out[o + 1] = clamp(((tmp11 + tmp2 + s) >> 18) + 128);
    out[o + 6] = clamp(((tmp11 - tmp2 + s) >> 18) + 128);
    out[o + 2] = clamp(((tmp12 + tmp1 + s) >> 18) + 128);
    out[o + 5] = clamp(((tmp12 - tmp1 + s) >> 18) + 128);
    out[o + 3] = clamp(((tmp13 + tmp0 + s) >> 18) + 128);
    out[o + 4] = clamp(((tmp13 - tmp0 + s) >> 18) + 128);
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

interface Plane {
  data: Uint8Array;
  stride: number;
}

function renderComponent(c: Component): Plane {
  const stride = c.blocksPerLine * 8;
  const data = new Uint8Array(stride * c.blocksPerColumn * 8);
  for (let by = 0; by < c.blocksPerColumn; by++) {
    for (let bx = 0; bx < c.blocksPerLine; bx++) {
      idctBlock(c.coefs, (by * c.blocksPerLine + bx) * 64, c.quant!, data, by * 8 * stride + bx * 8, stride);
    }
  }
  return { data, stride };
}

// Mirrors libjpeg's "fancy" triangle-filter upsampling, including its
// replication of the outermost real sample row/column at the image edge
// (not the padded block data), so results match libjpeg-turbo.
function upsample(plane: Plane, c: Component, fx: number, fy: number): Plane {
  const { data, stride } = plane;
  const dw = c.width;
  const dh = c.height;
  if (fx === 1 && fy === 1) return plane;
  const outStride = dw * fx;
  const out = new Uint8Array(outStride * dh * fy);

  if (fx === 2 && fy === 1 && dw > 2) {
    for (let y = 0; y < dh; y++) {
      const i = y * stride;
      const o = y * outStride;
      out[o] = data[i]!;
      out[o + 1] = (data[i]! * 3 + data[i + 1]! + 2) >> 2;
      for (let x = 1; x < dw - 1; x++) {
        const v = data[i + x]! * 3;
        out[o + 2 * x] = (v + data[i + x - 1]! + 1) >> 2;
        out[o + 2 * x + 1] = (v + data[i + x + 1]! + 2) >> 2;
      }
      const last = data[i + dw - 1]!;
      out[o + 2 * dw - 2] = (last * 3 + data[i + dw - 2]! + 1) >> 2;
      out[o + 2 * dw - 1] = last;
    }
  } else if (fx === 2 && fy === 2 && dw > 2) {
    const sums = new Int32Array(dw);
    for (let y = 0; y < dh; y++) {
      for (let v = 0; v < 2; v++) {
        const near = y * stride;
        const far = (v === 0 ? Math.max(y - 1, 0) : Math.min(y + 1, dh - 1)) * stride;
        for (let x = 0; x < dw; x++) sums[x] = data[near + x]! * 3 + data[far + x]!;
        const o = (y * 2 + v) * outStride;
        out[o] = (sums[0]! * 4 + 8) >> 4;
        out[o + 1] = (sums[0]! * 3 + sums[1]! + 7) >> 4;
        for (let x = 1; x < dw - 1; x++) {
          const s = sums[x]! * 3;
          out[o + 2 * x] = (s + sums[x - 1]! + 8) >> 4;
          out[o + 2 * x + 1] = (s + sums[x + 1]! + 7) >> 4;
        }
        const s = sums[dw - 1]!;
        out[o + 2 * dw - 2] = (s * 3 + sums[dw - 2]! + 8) >> 4;
        out[o + 2 * dw - 1] = (s * 4 + 7) >> 4;
      }
    }
  } else if (fx === 1 && fy === 2) {
    for (let y = 0; y < dh; y++) {
      for (let v = 0; v < 2; v++) {
        const near = y * stride;
        const far = (v === 0 ? Math.max(y - 1, 0) : Math.min(y + 1, dh - 1)) * stride;
        const o = (y * 2 + v) * outStride;
        for (let x = 0; x < dw; x++) out[o + x] = (data[near + x]! * 3 + data[far + x]! + (v === 0 ? 1 : 2)) >> 2;
      }
    }
  } else {
    for (let y = 0; y < dh * fy; y++) {
      const i = Math.floor(y / fy) * stride;
      const o = y * outStride;
      for (let x = 0; x < outStride; x++) out[o + x] = data[i + Math.floor(x / fx)]!;
    }
  }
  return { data: out, stride: outStride };
}

const FIX = (x: number): number => Math.floor(x * 65536 + 0.5);
const CR_R = new Int32Array(256);
const CB_B = new Int32Array(256);
const CR_G = new Int32Array(256);
const CB_G = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const x = i - 128;
  CR_R[i] = (FIX(1.402) * x + 32768) >> 16;
  CB_B[i] = (FIX(1.772) * x + 32768) >> 16;
  CR_G[i] = -FIX(0.71414) * x;
  CB_G[i] = -FIX(0.34414) * x + 32768;
}

function readMarkerSegment(data: Uint8Array, pos: number): Uint8Array {
  if (pos + 2 > data.length) throw truncated();
  const length = (data[pos]! << 8) | data[pos + 1]!;
  if (length < 2) throw new Error(`invalid JPEG segment length ${length} at offset ${pos}`);
  if (pos + length > data.length) throw truncated();
  return data.subarray(pos + 2, pos + length);
}

export function decodeJpeg(bytes: Uint8Array): Image {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG: missing SOI marker");
  const quantTables: (Int32Array | null)[] = [null, null, null, null];
  const dcTables: (HuffmanTable | null)[] = [null, null, null, null];
  const acTables: (HuffmanTable | null)[] = [null, null, null, null];
  let frame: Frame | null = null;
  let restartInterval = 0;
  let sawJfif = false;
  let adobeTransform = -1;
  let scans = 0;
  let pos = 2;

  for (;;) {
    // libjpeg accepts a file that stops after a complete scan; so do we.
    if (pos >= bytes.length && scans > 0) break;
    if (pos >= bytes.length) throw truncated();
    if (bytes[pos] !== 0xff) throw new Error(`invalid JPEG marker at offset ${pos}`);
    while (bytes[pos + 1] === 0xff) pos++;
    const marker = bytes[pos + 1];
    if (marker === undefined) throw truncated();
    pos += 2;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      throw new Error(`unexpected JPEG marker 0xFF${marker.toString(16).toUpperCase()} at offset ${pos - 2}`);
    }
    const seg = readMarkerSegment(bytes, pos);
    let next = pos + seg.length + 2;

    if (UNSUPPORTED_SOF[marker]) {
      throw new Error(`unsupported JPEG: ${UNSUPPORTED_SOF[marker]}`);
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame) throw new Error("JPEG has more than one frame header");
      if (seg.length < 6) throw new Error("invalid JPEG frame header");
      const precision = seg[0]!;
      if (precision !== 8) throw new Error(`unsupported JPEG: ${precision}-bit sample precision (only 8-bit is supported)`);
      const height = (seg[1]! << 8) | seg[2]!;
      const width = (seg[3]! << 8) | seg[4]!;
      const count = seg[5]!;
      if (width === 0 || height === 0) throw new Error(`invalid image size ${width}x${height}`);
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new RangeError(`image size ${width}x${height} exceeds the ${MAX_DIMENSION} pixel limit`);
      }
      if (count === 4) throw new Error("unsupported JPEG: 4 components (CMYK/YCCK)");
      if (count !== 1 && count !== 3) throw new Error(`unsupported JPEG: ${count} components (only 1 or 3 are supported)`);
      if (seg.length !== 6 + count * 3) throw new Error("invalid JPEG frame header length");
      const specs = [];
      let hmax = 1;
      let vmax = 1;
      for (let i = 0; i < count; i++) {
        const id = seg[6 + i * 3]!;
        const h = seg[7 + i * 3]! >> 4;
        const v = seg[7 + i * 3]! & 15;
        const tq = seg[8 + i * 3]!;
        if (h < 1 || h > 4 || v < 1 || v > 4) throw new Error(`invalid sampling factors ${h}x${v}`);
        if (tq > 3) throw new Error(`invalid quantization table index ${tq}`);
        hmax = Math.max(hmax, h);
        vmax = Math.max(vmax, v);
        specs.push({ id, h, v, tq });
      }
      const mcusX = Math.ceil(width / (8 * hmax));
      const mcusY = Math.ceil(height / (8 * vmax));
      const components = specs.map(({ id, h, v, tq }): Component => {
        if (hmax % h !== 0 || vmax % v !== 0) {
          throw new Error(`unsupported JPEG: fractional sampling ratio ${hmax}/${h} x ${vmax}/${v}`);
        }
        const blocksPerLine = mcusX * h;
        const blocksPerColumn = mcusY * v;
        return {
          id,
          h,
          v,
          tq,
          width: Math.ceil((width * h) / hmax),
          height: Math.ceil((height * v) / vmax),
          blocksPerLine,
          blocksPerColumn,
          coefs: new Int16Array(blocksPerLine * blocksPerColumn * 64),
          quant: null,
          pred: 0,
        };
      });
      frame = { progressive: marker === 0xc2, width, height, hmax, vmax, mcusX, mcusY, components };
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < seg.length) {
        if (p + 17 > seg.length) throw new Error("invalid JPEG Huffman table segment");
        const cls = seg[p]! >> 4;
        const id = seg[p]! & 15;
        if (cls > 1 || id > 3) throw new Error("invalid JPEG Huffman table class or index");
        const counts = seg.subarray(p + 1, p + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        if (total > 256 || p + 17 + total > seg.length) throw new Error("invalid JPEG Huffman table segment");
        const table = buildHuffman(counts, seg.subarray(p + 17, p + 17 + total));
        (cls === 0 ? dcTables : acTables)[id] = table;
        p += 17 + total;
      }
    } else if (marker === 0xdb) {
      let p = 0;
      while (p < seg.length) {
        const wide = seg[p]! >> 4;
        const id = seg[p]! & 15;
        if (wide > 1 || id > 3) throw new Error("invalid JPEG quantization table precision or index");
        const size = wide ? 128 : 64;
        if (p + 1 + size > seg.length) throw new Error("invalid JPEG quantization table segment");
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]!] = wide ? (seg[p + 1 + i * 2]! << 8) | seg[p + 2 + i * 2]! : seg[p + 1 + i]!;
        }
        quantTables[id] = table;
        p += 1 + size;
      }
    } else if (marker === 0xdd) {
      if (seg.length !== 2) throw new Error("invalid JPEG restart interval segment");
      restartInterval = (seg[0]! << 8) | seg[1]!;
    } else if (marker === 0xe0) {
      if (seg.length >= 5 && String.fromCharCode(...seg.subarray(0, 4)) === "JFIF" && seg[4] === 0) sawJfif = true;
    } else if (marker === 0xee) {
      if (seg.length >= 12 && String.fromCharCode(...seg.subarray(0, 5)) === "Adobe") adobeTransform = seg[11]!;
    } else if (marker === 0xda) {
      if (!frame) throw new Error("JPEG scan appears before the frame header");
      const count = seg[0];
      if (count === undefined || count < 1 || count > frame.components.length || seg.length !== 4 + count * 2) {
        throw new Error("invalid JPEG scan header");
      }
      const scan: ScanComponent[] = [];
      for (let i = 0; i < count; i++) {
        const c = frame.components.find((x) => x.id === seg[1 + i * 2]);
        if (!c) throw new Error(`JPEG scan refers to unknown component ${seg[1 + i * 2]}`);
        if (scan.some((s) => s.c === c)) throw new Error("JPEG scan lists a component twice");
        const tables = seg[2 + i * 2]!;
        const dc = dcTables[tables >> 4] ?? null;
        const ac = acTables[tables & 15] ?? null;
        if (!c.quant) {
          c.quant = quantTables[c.tq] ?? null;
          if (!c.quant) throw new Error(`JPEG scan uses undefined quantization table ${c.tq}`);
        }
        scan.push({ c, dc, ac });
      }
      let ss = seg[1 + count * 2]!;
      let se = seg[2 + count * 2]!;
      const approx = seg[3 + count * 2]!;
      const ah = approx >> 4;
      const al = approx & 15;
      if (frame.progressive) {
        if (ss > se || se > 63 || al > 13 || (ss === 0 && se !== 0) || (ss > 0 && count !== 1)) {
          throw new Error("invalid JPEG progressive scan parameters");
        }
      } else {
        ss = 0;
        se = 63;
      }
      const needDc = !frame.progressive || (ss === 0 && ah === 0);
      const needAc = !frame.progressive || ss > 0;
      for (const s of scan) {
        if ((needDc && !s.dc) || (needAc && !s.ac)) throw new Error("JPEG scan uses an undefined Huffman table");
        s.c.pred = 0;
      }
      next = decodeScan(frame, scan, ss, se, ah, al, restartInterval, bytes, next);
      scans++;
      while (next < bytes.length) {
        const m = bytes[next + 1];
        if (bytes[next] === 0xff && m !== undefined && m !== 0 && !(m >= 0xd0 && m <= 0xd7)) break;
        next++;
      }
    }
    pos = next;
  }

  if (!frame || scans === 0) throw new Error("JPEG has no image data");
  const { width, height } = frame;
  const planes = frame.components.map((c) => upsample(renderComponent(c), c, frame!.hmax / c.h, frame!.vmax / c.v));
  const pixels = new Uint32Array(width * height);
  const rgb =
    frame.components.length === 3 &&
    (adobeTransform === 0 ||
      (adobeTransform < 0 && !sawJfif && frame.components.map((c) => String.fromCharCode(c.id)).join("") === "RGB"));

  const p0 = planes[0]!;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = p0.data[y * p0.stride + x]!;
      let r = a;
      let g = a;
      let b = a;
      if (planes.length === 3) {
        const p1 = planes[1]!;
        const p2 = planes[2]!;
        const u = p1.data[y * p1.stride + x]!;
        const v = p2.data[y * p2.stride + x]!;
        if (rgb) {
          g = u;
          b = v;
        } else {
          r = clamp(a + CR_R[v]!);
          g = clamp(a + ((CB_G[u]! + CR_G[v]!) >> 16));
          b = clamp(a + CB_B[u]!);
        }
      }
      pixels[y * width + x] = ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
    }
  }
  return Image.from(width, height, pixels);
}
