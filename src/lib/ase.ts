import { deflateSync, inflateSync } from "node:zlib";

export type AseColorMode = "rgba" | "grayscale" | "indexed";
export type AseTagDirection = "forward" | "reverse" | "pingpong" | "pingpong_reverse";
/** The user data chunk that follows an object. `properties` is the whole properties block, size DWORD included, as stored. */
export interface AseUserData {
  text?: string;
  color?: [number, number, number, number];
  properties?: Uint8Array;
}
export interface AseLayer {
  name: string;
  type: "image" | "group" | "tilemap";
  childLevel: number;
  visible: boolean;
  editable: boolean;
  background: boolean;
  lockMovement: boolean;
  preferLinkedCels: boolean;
  collapsed: boolean;
  reference: boolean;
  blendMode: number;
  opacity: number;
  /** Layer flag bits other than the seven named above (128 and up), kept so they are written back. */
  /** Flag bits above the seven named ones, kept to write back; 0 when absent. */
  otherFlags?: number;
  userData?: AseUserData;
}
export interface AseCelImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}
export interface AseCel {
  layer: number;
  x: number;
  y: number;
  opacity: number;
  zIndex: number;
  image?: AseCelImage;
  linkedFrame?: number;
  userData?: AseUserData;
  /** The body of the cel extra chunk (0x2006) that follows the cel, written back as is. */
  extra?: Uint8Array;
  /** Decoded only: a tilemap cel, whose tiles are not read. */
  tilemap?: true;
}
export interface AseFrame {
  durationMs: number;
  cels: AseCel[];
}
export interface AseTag {
  name: string;
  from: number;
  to: number;
  direction: AseTagDirection;
  repeat: number;
  /** The tag's color; it is written as the color of the tag's user data, so userData.color is not used. */
  color: [number, number, number, number];
  userData?: AseUserData;
}
export interface AseFile {
  width: number;
  height: number;
  colorMode: AseColorMode;
  transparentIndex: number;
  palette: Uint8Array;
  layers: AseLayer[];
  frames: AseFrame[];
  tags: AseTag[];
  /** Pixel width:height; 1:1 when absent. */
  pixelRatio?: { w: number; h: number };
  /** The header's grid bounds; written as zeros when absent, and read only when any of the four is not zero. */
  grid?: { x: number; y: number; w: number; h: number };
  /** The sprite's user data. */
  userData?: AseUserData;
  /** The body of the color profile chunk (0x2007). */
  colorProfile?: Uint8Array;
  /** The body of the external files chunk (0x2008); properties keys refer to its entries. */
  externalFiles?: Uint8Array;
}
/** What the file holds that AseFile cannot represent; all zero means nothing was dropped. */
export interface AseFeatures {
  slices: number;
  tilesets: number;
  tilemapCels: number;
  zIndexCels: number;
  /** Palette chunks after the first frame; the decoded palette is the first frame's. */
  paletteChanges: number;
  /** Layers whose UUID was skipped. */
  layerUuids: number;
  /** Chunks of a type this reader does not know, skipped. */
  unknownChunks: number;
  /** Cels left out: a link to a cel that is not in an earlier frame, or a second cel on the same layer and frame. */
  droppedCels: number;
  /** Bytes left in frames after the counted chunks. */
  unreadFrameBytes: number;
}
export type AseDecoded = AseFile & { pixelRatio: { w: number; h: number }; features: AseFeatures };

const BYTES_PER_PIXEL: Record<AseColorMode, number> = { rgba: 4, grayscale: 2, indexed: 1 };
const DEPTH_OF: Record<AseColorMode, number> = { rgba: 32, grayscale: 16, indexed: 8 };
const MODE_OF_DEPTH: Record<number, AseColorMode> = { 32: "rgba", 16: "grayscale", 8: "indexed" };
const DIRECTIONS: AseTagDirection[] = ["forward", "reverse", "pingpong", "pingpong_reverse"];
const LAYER_TYPES: AseLayer["type"][] = ["image", "group", "tilemap"];

const HEADER_SIZE = 128;
const FRAME_HEADER_SIZE = 16;
const FILE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
// 1: layer opacity is valid, 2: blend mode and opacity are valid for groups too, 4: layers have a UUID.
const HEADER_FLAGS = 1 | 2;
const MAX_ENCODE_SIZE = 65535;
const MAX_DECODE_SIZE = 16384;
/** Pixels in all cel images together, so a small file cannot claim gigabytes once inflated. */
const MAX_CEL_PIXELS = 4096 * 4096;
const NAMED_LAYER_FLAGS = 1 | 2 | 4 | 8 | 16 | 32 | 64;
const MAX_PALETTE = 65535;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): this {
    this.reserve(1);
    this.buf[this.length++] = v;
    return this;
  }
  u16(v: number): this {
    this.reserve(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }
  i16(v: number): this {
    this.reserve(2);
    this.view.setInt16(this.length, v, true);
    this.length += 2;
    return this;
  }
  u32(v: number): this {
    this.reserve(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
    return this;
  }
  zeros(n: number): this {
    this.reserve(n);
    this.length += n;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  str(s: string): this {
    const b = textEncoder.encode(s);
    return this.u16(b.length).bytes(b);
  }
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v, true);
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

class Reader {
  pos: number;
  readonly end: number;
  private readonly view: DataView;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array, pos = 0, end = data.length) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = pos;
    this.end = end;
  }
  private need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new Error("ase: unexpected end of data");
  }
  u8(): number {
    this.need(1);
    return this.data[this.pos++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  str(): string {
    return textDecoder.decode(this.bytes(this.u16()));
  }
  rest(): Uint8Array {
    return this.bytes(this.end - this.pos);
  }
}

function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${v}`);
  }
}

function checkString(name: string, s: string): void {
  if (textEncoder.encode(s).length > 0xffff) throw new RangeError(`${name} is longer than 65535 bytes`);
}

function checkUserData(name: string, u: AseUserData | undefined): void {
  if (u === undefined) return;
  if (u.text !== undefined) checkString(`${name} text`, u.text);
  if (u.color !== undefined) {
    if (u.color.length !== 4) throw new RangeError(`${name} color must have 4 components`);
    for (const c of u.color) checkInt(`${name} color`, c, 0, 255);
  }
  if (u.properties !== undefined) {
    const p = u.properties;
    const size = p.length >= 4 ? new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true) : -1;
    if (p.length < 8 || size !== p.length) {
      throw new RangeError(`${name} properties must be at least 8 bytes and start with their own size`);
    }
  }
}

function validate(file: AseFile): void {
  let celPixels = 0;
  checkInt("width", file.width, 1, MAX_ENCODE_SIZE);
  if (file.pixelRatio) {
    checkInt("pixelRatio.w", file.pixelRatio.w, 1, 255);
    checkInt("pixelRatio.h", file.pixelRatio.h, 1, 255);
  }
  checkInt("height", file.height, 1, MAX_ENCODE_SIZE);
  if (file.grid) {
    checkInt("grid.x", file.grid.x, -32768, 32767);
    checkInt("grid.y", file.grid.y, -32768, 32767);
    checkInt("grid.w", file.grid.w, 0, 0xffff);
    checkInt("grid.h", file.grid.h, 0, 0xffff);
  }
  const bpp = BYTES_PER_PIXEL[file.colorMode];
  if (bpp === undefined) throw new RangeError(`unknown color mode ${String(file.colorMode)}`);
  if (file.palette.length % 4 !== 0) throw new RangeError("palette length must be a multiple of 4");
  const colors = file.palette.length / 4;
  if (colors > MAX_PALETTE) throw new RangeError(`palette has more than ${MAX_PALETTE} colors`);
  checkInt("transparentIndex", file.transparentIndex, 0, 255);
  checkUserData("sprite user data", file.userData);  checkInt("layer count", file.layers.length, 0, 0xffff);
  checkInt("frame count", file.frames.length, 1, 0xffff);
  file.layers.forEach((l, i) => {
    if (!LAYER_TYPES.includes(l.type)) throw new RangeError(`layer ${i}: unknown type`);
    // A tilemap layer needs a tileset chunk and tilemap cels, which this writer has no way to give it.
    if (l.type === "tilemap") throw new RangeError(`layer ${i}: tilemap layers cannot be written`);
    checkString(`layer ${i} name`, l.name);
    checkUserData(`layer ${i} user data`, l.userData);
    checkInt(`layer ${i} otherFlags`, l.otherFlags ?? 0, 0, 0xffff);
    if (((l.otherFlags ?? 0) & NAMED_LAYER_FLAGS) !== 0) throw new RangeError(`layer ${i} otherFlags must not use the named flag bits`);
    checkInt(`layer ${i} childLevel`, l.childLevel, 0, 0xffff);
    checkInt(`layer ${i} blendMode`, l.blendMode, 0, 0xffff);
    checkInt(`layer ${i} opacity`, l.opacity, 0, 255);
  });
  file.frames.forEach((frame, fi) => {
    // 0 would read back as the header speed, so it cannot round trip.
    checkInt(`frame ${fi} durationMs`, frame.durationMs, 1, 0xffff);
    const seen = new Set<number>();
    for (const cel of frame.cels) {
      checkInt(`frame ${fi} cel layer`, cel.layer, 0, file.layers.length - 1);
      if (seen.has(cel.layer)) throw new RangeError(`frame ${fi} has two cels on layer ${cel.layer}`);
      seen.add(cel.layer);
      checkInt(`frame ${fi} cel x`, cel.x, -32768, 32767);
      checkInt(`frame ${fi} cel y`, cel.y, -32768, 32767);
      checkInt(`frame ${fi} cel opacity`, cel.opacity, 0, 255);
      checkInt(`frame ${fi} cel zIndex`, cel.zIndex, -32768, 32767);
      if (cel.tilemap || (cel.image === undefined) === (cel.linkedFrame === undefined)) {
        throw new RangeError(`frame ${fi} cel on layer ${cel.layer} needs exactly one of image and linkedFrame`);
      }
      if (cel.linkedFrame !== undefined) {
        checkInt(`frame ${fi} cel linkedFrame`, cel.linkedFrame, 0, fi - 1);
      }
      checkUserData(`frame ${fi} cel on layer ${cel.layer} user data`, cel.userData);
      if (cel.image !== undefined) {
        // The decoder refuses an empty image or more than MAX_CEL_PIXELS in all, so such a file would not read back.
        checkInt(`frame ${fi} cel image width`, cel.image.width, 1, 0xffff);
        checkInt(`frame ${fi} cel image height`, cel.image.height, 1, 0xffff);
        celPixels += cel.image.width * cel.image.height;
        if (celPixels > MAX_CEL_PIXELS) {
          throw new RangeError(`cel images hold more than ${MAX_CEL_PIXELS} pixels in all`);
        }
        if (cel.image.pixels.length !== cel.image.width * cel.image.height * bpp) {
          throw new RangeError(`frame ${fi} cel image pixels length does not match its size and color mode`);
        }
      }
    }
  });
  file.tags.forEach((t, i) => {
    checkString(`tag ${i} name`, t.name);
    checkInt(`tag ${i} from`, t.from, 0, file.frames.length - 1);
    checkInt(`tag ${i} to`, t.to, t.from, file.frames.length - 1);
    if (!DIRECTIONS.includes(t.direction)) throw new RangeError(`tag ${i}: unknown direction`);
    checkInt(`tag ${i} repeat`, t.repeat, 0, 0xffff);
    if (t.color.length !== 4) throw new RangeError(`tag ${i}: color must have 4 components`);
    for (const c of t.color) checkInt(`tag ${i} color`, c, 0, 255);
    checkUserData(`tag ${i} user data`, t.userData);
  });
  checkInt("tag count", file.tags.length, 0, 0xffff);
}

function chunk(type: number, body: Writer): Uint8Array {
  const b = body.done();
  return new Writer().u32(b.length + 6).u16(type).bytes(b).done();
}

function oldPaletteChunk(palette: Uint8Array): Uint8Array {
  const n = palette.length / 4;
  const w = new Writer().u16(n > 0 ? 1 : 0);
  if (n > 0) {
    w.u8(0).u8(n & 0xff);
    for (let i = 0; i < n; i++) w.u8(palette[i * 4]!).u8(palette[i * 4 + 1]!).u8(palette[i * 4 + 2]!);
  }
  return chunk(0x0004, w);
}

function newPaletteChunk(palette: Uint8Array): Uint8Array {
  const n = palette.length / 4;
  // An empty palette has no valid [first,last] range; first > last means zero entries.
  const w = new Writer().u32(n).u32(n > 0 ? 0 : 1).u32(n > 0 ? n - 1 : 0).zeros(8);
  for (let i = 0; i < n; i++) {
    w.u16(0).u8(palette[i * 4]!).u8(palette[i * 4 + 1]!).u8(palette[i * 4 + 2]!).u8(palette[i * 4 + 3]!);
  }
  return chunk(0x2019, w);
}

function layerChunk(l: AseLayer): Uint8Array {
  const flags =
    (l.visible ? 1 : 0) |
    (l.editable ? 2 : 0) |
    (l.lockMovement ? 4 : 0) |
    (l.background ? 8 : 0) |
    (l.preferLinkedCels ? 16 : 0) |
    (l.collapsed ? 32 : 0) |
    (l.reference ? 64 : 0) |
    (l.otherFlags ?? 0);
  const w = new Writer()
    .u16(flags)
    .u16(LAYER_TYPES.indexOf(l.type))
    .u16(l.childLevel)
    .u16(0)
    .u16(0)
    .u16(l.blendMode)
    .u8(l.opacity)
    .zeros(3)
    .str(l.name);
  return chunk(0x2004, w);
}

function celChunk(cel: AseCel): Uint8Array {
  const w = new Writer()
    .u16(cel.layer)
    .i16(cel.x)
    .i16(cel.y)
    .u8(cel.opacity)
    .u16(cel.linkedFrame !== undefined ? 1 : 2)
    .i16(cel.zIndex)
    .zeros(5);
  if (cel.linkedFrame !== undefined) {
    w.u16(cel.linkedFrame);
  } else {
    const img = cel.image!;
    w.u16(img.width).u16(img.height).bytes(deflateSync(img.pixels));
  }
  return chunk(0x2005, w);
}

/** A user data chunk; undefined for one with nothing in it, which Aseprite does not write. */
function userDataChunk(u: AseUserData | undefined, always = false): Uint8Array | undefined {
  // An empty text is kept because it only exists in the model when the file's flag 1 was set; Aseprite itself never writes one.
  const hasText = u?.text !== undefined;
  const hasColor = u?.color !== undefined && u.color[3] !== 0;
  const hasProps = u?.properties !== undefined;
  if (!always && !hasText && !hasColor && !hasProps) return undefined;
  const w = new Writer().u32((hasText ? 1 : 0) | (hasColor ? 2 : 0) | (hasProps ? 4 : 0));
  if (hasText) w.str(u!.text!);
  if (hasColor) w.u8(u!.color![0]).u8(u!.color![1]).u8(u!.color![2]).u8(u!.color![3]);
  if (hasProps) w.bytes(u!.properties!);
  return chunk(0x2020, w);
}

function tagChunks(tags: AseTag[]): Uint8Array[] {
  const w = new Writer().u16(tags.length).zeros(8);
  for (const t of tags) {
    w.u16(t.from)
      .u16(t.to)
      .u8(DIRECTIONS.indexOf(t.direction))
      .u16(t.repeat)
      .zeros(6)
      .u8(t.color[0])
      .u8(t.color[1])
      .u8(t.color[2])
      .u8(0)
      .str(t.name);
  }
  const out = [chunk(0x2018, w)];
  for (const t of tags) {
    out.push(userDataChunk({ ...t.userData, color: t.color }, true)!);
  }
  return out;
}

export function encodeAse(file: AseFile): Uint8Array {
  validate(file);
  const colors = file.palette.length / 4;
  const out = new Writer();
  out.u32(0).u16(FILE_MAGIC).u16(file.frames.length).u16(file.width).u16(file.height);
  out.u16(DEPTH_OF[file.colorMode]).u32(HEADER_FLAGS).u16(file.frames[0]!.durationMs).u32(0).u32(0);
  const ratio = file.pixelRatio ?? { w: 1, h: 1 };
  const grid = file.grid ?? { x: 0, y: 0, w: 0, h: 0 };
  out.u8(file.transparentIndex).zeros(3).u16(colors).u8(ratio.w).u8(ratio.h).i16(grid.x).i16(grid.y).u16(grid.w).u16(grid.h);
  out.zeros(HEADER_SIZE - out.length);

  file.frames.forEach((frame, fi) => {
    const chunks: Uint8Array[] = [];
    if (fi === 0) {
      if (file.externalFiles) chunks.push(chunk(0x2008, new Writer().bytes(file.externalFiles)));
      if (file.colorProfile) chunks.push(chunk(0x2007, new Writer().bytes(file.colorProfile)));
      let opaque = true;
      for (let i = 3; i < file.palette.length; i += 4) if (file.palette[i] !== 255) opaque = false;
      if (opaque && colors <= 256) chunks.push(oldPaletteChunk(file.palette));
      chunks.push(newPaletteChunk(file.palette));
      const sprite = userDataChunk(file.userData);
      if (sprite) chunks.push(sprite);
      if (file.tags.length > 0) chunks.push(...tagChunks(file.tags));
      for (const l of file.layers) {
        chunks.push(layerChunk(l));
        const ud = userDataChunk(l.userData);
        if (ud) chunks.push(ud);
      }
    }
    for (const cel of frame.cels) {
      chunks.push(celChunk(cel));
      if (cel.extra) chunks.push(chunk(0x2006, new Writer().bytes(cel.extra)));
      const ud = userDataChunk(cel.userData);
      if (ud) chunks.push(ud);
    }
    const size = FRAME_HEADER_SIZE + chunks.reduce((n, c) => n + c.length, 0);
    out.u32(size).u16(FRAME_MAGIC).u16(Math.min(chunks.length, 0xffff)).u16(frame.durationMs).zeros(2).u32(chunks.length);
    for (const c of chunks) out.bytes(c);
  });
  out.patchU32(0, out.length);
  return out.done();
}

function expand6(v: number): number {
  return (v << 2) | (v >> 4);
}

function readOldPalette(r: Reader, sixBit: boolean, into: Uint8Array): Uint8Array {
  let palette = into;
  const packets = r.u16();
  let index = 0;
  for (let p = 0; p < packets; p++) {
    index += r.u8();
    const count = r.u8() || 256;
    for (let i = 0; i < count; i++, index++) {
      const red = r.u8();
      const green = r.u8();
      const blue = r.u8();
      if (index >= 256) throw new Error("ase: old palette index exceeds 255");
      if ((index + 1) * 4 > palette.length) {
        const grown = new Uint8Array((index + 1) * 4);
        grown.set(palette);
        for (let k = palette.length; k < grown.length; k += 4) grown[k + 3] = 255;
        palette = grown;
      }
      palette[index * 4] = sixBit ? expand6(red & 63) : red;
      palette[index * 4 + 1] = sixBit ? expand6(green & 63) : green;
      palette[index * 4 + 2] = sixBit ? expand6(blue & 63) : blue;
      palette[index * 4 + 3] = 255;
    }
  }
  return palette;
}

function readNewPalette(r: Reader, into: Uint8Array): Uint8Array {
  const size = r.u32();
  const first = r.u32();
  const last = r.u32();
  r.skip(8);
  if (size > MAX_PALETTE) throw new Error("ase: palette is too large");
  let palette = into;
  if (palette.length !== size * 4) {
    const resized = new Uint8Array(size * 4);
    resized.set(palette.subarray(0, Math.min(palette.length, resized.length)));
    palette = resized;
  }
  if (first > last) return palette;
  if (last >= size) throw new Error("ase: palette range exceeds palette size");
  for (let i = first; i <= last; i++) {
    const flags = r.u16();
    palette[i * 4] = r.u8();
    palette[i * 4 + 1] = r.u8();
    palette[i * 4 + 2] = r.u8();
    palette[i * 4 + 3] = r.u8();
    if (flags & 1) r.skip(r.u16());
  }
  return palette;
}

function readImage(
  r: Reader,
  compressed: boolean,
  bpp: number,
  budget: { pixels: number },
): AseCelImage {
  const width = r.u16();
  const height = r.u16();
  if (width === 0 || height === 0) throw new Error("ase: cel image is empty");
  budget.pixels -= width * height;
  if (width > MAX_DECODE_SIZE || height > MAX_DECODE_SIZE || budget.pixels < 0) {
    throw new RangeError(`ase: cel images hold more than ${MAX_CEL_PIXELS} pixels in all`);
  }
  const expected = width * height * bpp;
  let pixels: Uint8Array;
  if (compressed) {
    try {
      pixels = new Uint8Array(inflateSync(r.rest(), { maxOutputLength: Math.max(1, expected) }));
    } catch {
      throw new Error("ase: cel image data is not valid zlib data of the expected size");
    }
  } else {
    pixels = r.bytes(expected).slice();
  }
  if (pixels.length !== expected) throw new Error("ase: cel image data has the wrong length");
  return { width, height, pixels };
}

function readUserData(r: Reader): AseUserData {
  const flags = r.u32();
  const u: AseUserData = {};
  if (flags & 1) u.text = r.str();
  if (flags & 2) u.color = [r.u8(), r.u8(), r.u8(), r.u8()];
  if (flags & 4) {
    const at = r.pos;
    const size = r.u32();
    if (size < 8) throw new Error("ase: properties block is smaller than its own header");
    r.pos = at;
    u.properties = Uint8Array.from(r.bytes(size));
  }
  return u;
}

const KNOWN_CHUNKS = new Set([
  0x0004, 0x0011, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2016, 0x2017, 0x2018, 0x2019, 0x2020, 0x2021, 0x2022, 0x2023,
]);

/** What the next user data chunk belongs to, as Aseprite's last_object_with_user_data. */
type UserTarget =
  | { kind: "sprite" }
  | { kind: "layer"; layer: AseLayer }
  | { kind: "cel"; cel: AseCel }
  | { kind: "tag"; index: number }
  | undefined;

/**
 * The cel that holds the image `cel` shows, found by following links back to a cel that is not a link, as Aseprite
 * shares the data of the linked cel. Throws when a link points at this frame or a later one, or at a layer with no cel
 * there, or the end of the chain has no image.
 */
export function celSource(frames: readonly AseFrame[], frameIndex: number, cel: AseCel): AseCel {
  let current = cel;
  let at = frameIndex;
  while (current.linkedFrame !== undefined) {
    if (current.linkedFrame >= at) throw new Error(`ase: cel on layer ${cel.layer} in frame ${at} links to frame ${current.linkedFrame}, which is not before it`);
    at = current.linkedFrame;
    const next: AseCel | undefined = frames[at]?.cels.find((c) => c.layer === cel.layer);
    if (!next) throw new Error(`ase: cel on layer ${cel.layer} links to frame ${at}, which has no cel on that layer`);
    current = next;
  }
  if (current.image === undefined && !current.tilemap) throw new Error(`ase: cel on layer ${cel.layer} in frame ${at} has no image`);
  return current;
}

export function decodeAse(bytes: Uint8Array): AseDecoded {
  const budget = { pixels: MAX_CEL_PIXELS };
  if (bytes.length < HEADER_SIZE) throw new Error("ase: file is shorter than the 128-byte header");
  const h = new Reader(bytes, 0, HEADER_SIZE);
  h.skip(4);
  if (h.u16() !== FILE_MAGIC) throw new Error("ase: bad file magic");
  const frameCount = h.u16();
  const width = h.u16();
  const height = h.u16();
  const depth = h.u16();
  const headerFlags = h.u32();
  const speed = h.u16();
  h.skip(8);
  const headerTransparent = h.u8();
  h.skip(5);
  const pixelW = h.u8();
  const pixelH = h.u8();
  const gridBounds = { x: h.i16(), y: h.i16(), w: h.u16(), h: h.u16() };
  const hasGrid = gridBounds.x !== 0 || gridBounds.y !== 0 || gridBounds.w !== 0 || gridBounds.h !== 0;
  // The spec reads a zero in either field as 1:1.
  const pixelRatio = pixelW === 0 || pixelH === 0 ? { w: 1, h: 1 } : { w: pixelW, h: pixelH };
  const colorMode = MODE_OF_DEPTH[depth];
  if (colorMode === undefined) throw new Error(`ase: unsupported color depth ${depth}`);
  if (width < 1 || height < 1 || width > MAX_DECODE_SIZE || height > MAX_DECODE_SIZE) {
    throw new Error(`ase: unsupported sprite size ${width}x${height}`);
  }
  if (frameCount === 0) throw new Error("ase: file has no frames");
  const bpp = BYTES_PER_PIXEL[colorMode];
  const transparentIndex = colorMode === "indexed" ? headerTransparent : 0;

  const features: AseFeatures = {
    slices: 0,
    tilesets: 0,
    tilemapCels: 0,
    zIndexCels: 0,
    paletteChanges: 0,
    layerUuids: 0,
    unknownChunks: 0,
    droppedCels: 0,
    unreadFrameBytes: 0,
  };

  const layers: AseLayer[] = [];
  const frames: AseFrame[] = [];
  const tags: AseTag[] = [];
  let oldPalette: Uint8Array = new Uint8Array(0);
  let newPalette: Uint8Array | undefined;
  let userData: AseUserData | undefined;
  let colorProfile: Uint8Array | undefined;
  let externalFiles: Uint8Array | undefined;
  let target: UserTarget = { kind: "sprite" };
  // Aseprite keeps the last cel it accepted, so a cel extra after a dropped cel lands on an older one.
  let lastCel: AseCel | undefined;

  let pos = HEADER_SIZE;
  for (let fi = 0; fi < frameCount; fi++) {
    if (pos + FRAME_HEADER_SIZE > bytes.length) throw new Error("ase: file ends inside a frame header");
    const fr = new Reader(bytes, pos, bytes.length);
    const frameSize = fr.u32();
    if (fr.u16() !== FRAME_MAGIC) throw new Error("ase: bad frame magic");
    const oldCount = fr.u16();
    const duration = fr.u16();
    fr.skip(2);
    const newCount = fr.u32();
    const chunkCount = oldCount === 0xffff && oldCount < newCount ? newCount : oldCount;
    const frameEnd = pos + frameSize;
    if (frameSize < FRAME_HEADER_SIZE || frameEnd > bytes.length) throw new Error("ase: frame size is out of range");

    const frame: AseFrame = { durationMs: duration === 0 ? speed || 1 : duration, cels: [] };
    const celLayers = new Set<number>();
    let cp = pos + FRAME_HEADER_SIZE;
    for (let ci = 0; ci < chunkCount; ci++) {
      if (cp + 6 > frameEnd) throw new Error("ase: chunk header is outside its frame");
      const cr = new Reader(bytes, cp, frameEnd);
      const chunkSize = cr.u32();
      const type = cr.u16();
      if (chunkSize < 6 || cp + chunkSize > frameEnd) throw new Error("ase: chunk size is out of range");
      const body = new Reader(bytes, cp + 6, cp + chunkSize);
      cp += chunkSize;

      const isPalette = type === 0x0004 || type === 0x0011 || type === 0x2019;
      if (fi > 0 && isPalette) {
        // The palette is the first frame's, as Aseprite's load_palette reads it; later ones are only counted.
        features.paletteChanges++;
        continue;
      }
      switch (type) {
        case 0x0004:
          oldPalette = readOldPalette(body, false, oldPalette);
          break;
        case 0x0011:
          oldPalette = readOldPalette(body, true, oldPalette);
          break;
        case 0x2019:
          newPalette = readNewPalette(body, newPalette ?? new Uint8Array(0));
          break;
        case 0x2004: {
          const flags = body.u16();
          const layerType = body.u16();
          const childLevel = body.u16();
          body.skip(4);
          const blendMode = body.u16();
          const opacity = body.u8();
          body.skip(3);
          const name = body.str();
          const kind = LAYER_TYPES[layerType];
          if (kind === undefined) throw new Error(`ase: unknown layer type ${layerType}`);
          if (kind === "tilemap") body.skip(4);
          if (headerFlags & 4) {
            body.skip(16);
            features.layerUuids++;
          }
          // NOTE.6: opacity needs header flag 1, and a group's blend mode and opacity need flag 2.
          // Aseprite also ignores both on a background layer.
          const blendValid = (kind !== "group" || (headerFlags & 2) !== 0) && (flags & 8) === 0;
          const layer: AseLayer = {
            name,
            type: kind,
            childLevel,
            visible: (flags & 1) !== 0,
            editable: (flags & 2) !== 0,
            background: (flags & 8) !== 0,
            lockMovement: (flags & 4) !== 0,
            preferLinkedCels: (flags & 16) !== 0,
            collapsed: (flags & 32) !== 0,
            reference: (flags & 64) !== 0,
            blendMode: blendValid ? blendMode : 0,
            opacity: blendValid && headerFlags & 1 ? opacity : 255,
            otherFlags: flags & ~NAMED_LAYER_FLAGS,
          };
          layers.push(layer);
          target = { kind: "layer", layer };
          break;
        }
        case 0x2005: {
          const layer = body.u16();
          if (layer >= layers.length) throw new Error(`ase: cel on layer ${layer}, but there are ${layers.length} layers`);
          const x = body.i16();
          const y = body.i16();
          const opacity = body.u8();
          const celType = body.u16();
          const zIndex = body.i16();
          body.skip(5);
          const cel: AseCel = { layer, x, y, opacity, zIndex };
          if (zIndex !== 0) features.zIndexCels++;
          if (celType === 0 || celType === 2) {
            cel.image = readImage(body, celType === 2, bpp, budget);
          } else if (celType === 1) {
            cel.linkedFrame = body.u16();
          } else if (celType === 3) {
            cel.tilemap = true;
            features.tilemapCels++;
          } else {
            throw new Error(`ase: unknown cel type ${celType}`);
          }
          // Aseprite's layer->cel(link_frame) finds only cels already added, so a link to this frame or a later one,
          // or to a cel that was itself dropped, finds nothing and the cel is dropped.
          const linkTarget =
            cel.linkedFrame === undefined
              ? undefined
              : cel.linkedFrame < fi && frames[cel.linkedFrame]!.cels.some((c) => c.layer === layer);
          if (linkTarget === false || celLayers.has(layer)) {
            features.droppedCels++;
            target = undefined;
            break;
          }
          // Every accepted cel has a root, so a chain is never broken here; resolving checks it anyway.
          if (linkTarget === true && celSource(frames, fi, cel).tilemap) {
            cel.tilemap = true;
            features.tilemapCels++;
          }
          celLayers.add(layer);
          frame.cels.push(cel);
          lastCel = cel;
          target = { kind: "cel", cel };
          break;
        }
        case 0x2006:
          if (lastCel) lastCel.extra = Uint8Array.from(body.rest());
          break;
        case 0x2007:
          colorProfile = Uint8Array.from(body.rest());
          break;
        case 0x2008:
          externalFiles = Uint8Array.from(body.rest());
          break;
        case 0x2018: {
          const n = body.u16();
          body.skip(8);
          for (let i = 0; i < n; i++) {
            const from = body.u16();
            const to = body.u16();
            const dir = body.u8();
            const repeat = body.u16();
            body.skip(6);
            const r = body.u8();
            const g = body.u8();
            const b = body.u8();
            body.skip(1);
            const name = body.str();
            const direction = DIRECTIONS[dir];
            if (direction === undefined) throw new Error(`ase: unknown tag direction ${dir}`);
            if (from > to || to >= frameCount) throw new Error(`ase: tag "${name}" covers frames ${from}..${to} of ${frameCount}`);
            tags.push({ name, from, to, direction, repeat, color: [r, g, b, 255] });
          }
          // Aseprite starts again from its first tag, even when an earlier tags chunk added others.
          target = tags.length > 0 ? { kind: "tag", index: 0 } : undefined;
          break;
        }
        case 0x2020: {
          const u = readUserData(body);
          if (target?.kind === "sprite") userData = u;
          else if (target?.kind === "layer") target.layer.userData = u;
          else if (target?.kind === "cel") target.cel.userData = u;
          else if (target?.kind === "tag") {
            // A tag's user data replaces what the tags chunk said, so no color means no color.
            const tag = tags[target.index]!;
            tag.color = u.color ?? [0, 0, 0, 0];
            delete tag.userData;
            if (u.text !== undefined || u.properties !== undefined) {
              tag.userData = {};
              if (u.text !== undefined) tag.userData.text = u.text;
              if (u.properties !== undefined) tag.userData.properties = u.properties;
            }
            const following: number = target.index + 1;
            target = following < tags.length ? { kind: "tag", index: following } : undefined;
          }
          break;
        }
        case 0x2022:
          features.slices++;
          target = undefined;
          break;
        case 0x2023:
          features.tilesets++;
          target = undefined;
          break;
        default:
          if (!KNOWN_CHUNKS.has(type)) features.unknownChunks++;
          break;
      }
    }
    features.unreadFrameBytes += frameEnd - cp;
    frames.push(frame);
    pos = frameEnd;
  }

  const palette = newPalette ?? oldPalette;
  if (colorMode === "indexed" && transparentIndex >= palette.length / 4) {
    throw new Error("ase: transparent index is outside the palette");
  }
  return {
    width,
    height,
    colorMode,
    transparentIndex,
    palette,
    layers,
    frames,
    tags,
    pixelRatio,
    features,
    ...(hasGrid ? { grid: gridBounds } : {}),
    ...(userData ? { userData } : {}),
    ...(colorProfile ? { colorProfile } : {}),
    ...(externalFiles ? { externalFiles } : {}),
  };
}
