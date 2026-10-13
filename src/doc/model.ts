/**
 * The in-process document model every tool draws into.
 *
 * Pixels hold the raw value of the sprite's colour mode, as Aseprite's do, so
 * the Lua handlers port line for line:
 *  - rgb: a packed 0xRRGGBBAA colour;
 *  - grayscale: the same packing with r = g = b;
 *  - indexed: a palette index — changing a palette entry recolours every pixel
 *    that uses it, and `transparentIndex` is the one that means "no paint".
 * Read and write them through `pixelToRgba` / `rgbaToPixel` rather than
 * assuming a mode. Frames are 1-based everywhere, as on the tool surface.
 * Layers are ordered bottom to top.
 */

import { deltaE, rgbToLab } from "../lib/color.js";
import type { AseUserData } from "../lib/ase.js";
import { presets } from "../lib/palettes.js";
import { ToolError } from "./errors.js";

/** A colour packed as 0xRRGGBBAA, unsigned. */
export type Rgba = number;

export const TRANSPARENT: Rgba = 0;

export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return ((r & 255) * 0x1000000 + ((g & 255) << 16) + ((b & 255) << 8) + (a & 255)) >>> 0;
}

export function channels(c: Rgba): [r: number, g: number, b: number, a: number] {
  return [(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255];
}

/** `#rrggbb`, or `#rrggbbaa` when `withAlpha` and the colour is not opaque. */
export function rgbaToHex(c: Rgba, withAlpha = true): string {
  const hex = (c >>> 0).toString(16).padStart(8, "0");
  return `#${withAlpha && (c & 255) !== 255 ? hex : hex.slice(0, 6)}`;
}

export function hexToRgba(hex: string): Rgba {
  if (typeof hex !== "string") throw new ToolError("invalid_args", "Colour must be a string.");
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h)) {
    throw new ToolError("invalid_args", `Colour '${hex}' must be #rrggbb or #rrggbbaa.`);
  }
  return Number.parseInt(h.length === 6 ? `${h}ff` : h, 16) >>> 0;
}

/** Aseprite gives every new sprite its default palette, DawnBringer 32. */
export function defaultPalette(): Rgba[] {
  return presets()["dawnbringer-32"]!.colors.map(hexToRgba);
}

export class Image {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height` raw pixel values. */
  readonly pixels: Uint32Array;

  constructor(width: number, height: number, fill: number = 0) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new ToolError("invalid_args", `Image size must be positive integers, got ${width}x${height}.`);
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint32Array(width * height);
    if (fill !== 0) this.pixels.fill(fill >>> 0);
  }

  static from(width: number, height: number, pixels: Uint32Array): Image {
    if (pixels.length !== width * height) {
      throw new ToolError("internal_error", `Expected ${width * height} pixels, got ${pixels.length}.`);
    }
    const image = new Image(width, height);
    image.pixels.set(pixels);
    return image;
  }

  contains(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Out of bounds reads as 0. */
  get(x: number, y: number): number {
    return this.contains(x, y) ? this.pixels[y * this.width + x]! : 0;
  }

  /** Out of bounds writes are dropped. */
  set(x: number, y: number, value: number): void {
    if (this.contains(x, y)) this.pixels[y * this.width + x] = value >>> 0;
  }

  clone(): Image {
    return Image.from(this.width, this.height, this.pixels);
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Cel {
  /** Canvas position of the image's top-left pixel. */
  x: number;
  y: number;
  image: Image;
  /** 0–255. */
  opacity: number;
  /** What an opened .aseprite carried for this cel and the model does not use, written back on save. */
  aseprite?: { userData?: AseUserData; extra?: Uint8Array };
}

export interface Layer {
  /** Unique within its sprite; never reused. */
  readonly id: number;
  name: string;
  visible: boolean;
  editable: boolean;
  /** 0–255. */
  opacity: number;
  /** Set on layers made by reference op 'import'; the name says nothing, since import takes any. */
  reference?: true;
  /**
   * Aseprite's Background layer: composited before the other layers, an
   * indexed sprite's transparent index shows as its palette colour on it, and
   * while it is visible a saved PNG or GIF has no transparency.
   */
  background?: true;
  /**
   * What an opened .aseprite carried for this layer and the model does not
   * use, written back on save. `referenceFlag` is Aseprite's own reference
   * layer flag; the user data text here never holds the reference mark.
   */
  aseprite?: {
    lockMovement?: boolean;
    preferLinkedCels?: boolean;
    collapsed?: boolean;
    referenceFlag?: boolean;
    /** How the reference mark line ended in the file, and what separated it from the line before when it was last; kept to write it back the same. */
    markLineEnds?: { end: string; sep: string };
    otherFlags?: number;
    userData?: AseUserData;
  };
  /** Keyed by 1-based frame number. */
  cels: Map<number, Cel>;
}

export interface Frame {
  durationMs: number;
}

export type TagDirection = "forward" | "reverse" | "pingpong" | "pingpong_reverse";

export interface Tag {
  name: string;
  /** 1-based, inclusive. */
  from: number;
  to: number;
  direction: TagDirection;
  /** 0 = forever. */
  repeats: number;
  color: Rgba;
  /** An opened .aseprite tag's user data text and properties, written back on save. */
  aseprite?: { userData?: AseUserData };
}

/** One byte per canvas pixel, non-zero = selected. */
export interface Selection {
  mask: Uint8Array;
  bounds: Rect;
}

export type ColorMode = "rgb" | "grayscale" | "indexed";

export interface Sprite {
  /** Stable for the life of the server; what tools hand back as '#<id>'. */
  readonly id: number;
  /** Where it was last opened from or saved to; null until then. */
  filename: string | null;
  width: number;
  height: number;
  colorMode: ColorMode;
  /** Indexed only: the palette entry that means transparent. */
  transparentIndex: number;
  palette: Rgba[];
  /** Bottom to top. */
  layers: Layer[];
  frames: Frame[];
  tags: Tag[];
  selection: Selection | null;
  pixelRatio: { w: number; h: number };
  modified: boolean;
  /** The layer and frame tools use when they are not told one. */
  activeLayerId: number | null;
  activeFrame: number;
  /** Next value for `Layer.id`. */
  nextLayerId: number;
  /** What an opened .aseprite carried for the whole sprite and the model does not use, written back on save. */
  aseprite?: {
    userData?: AseUserData;
    colorProfile?: Uint8Array;
    externalFiles?: Uint8Array;
    grid?: { x: number; y: number; w: number; h: number };
  };
}

/** What results call a sprite: its file's base name, "Sprite" until it has one. */
export function displayName(s: Sprite): string {
  if (!s.filename) return "Sprite";
  return s.filename.split(/[\\/]/).at(-1) || "Sprite";
}

/** The raw value that means "no paint" in this sprite. */
export function transparentPixel(s: Sprite): number {
  return s.colorMode === "indexed" ? s.transparentIndex : TRANSPARENT;
}

/**
 * What a raw pixel looks like. An indexed pixel is its palette colour, always
 * opaque — the alpha in a palette entry does not reach indexed pixels, and an
 * index past the palette's end is no paint. On an indexed Background `layer`
 * the transparent index is paint too, its palette colour, as Aseprite renders
 * it. This is the only place that rule lives.
 */
export function pixelToRgba(s: Sprite, value: number, layer?: Layer): Rgba {
  if (s.colorMode !== "indexed") return value >>> 0;
  if (value >= s.palette.length) return TRANSPARENT;
  if (value === s.transparentIndex && !layer?.background) return TRANSPARENT;
  return ((s.palette[value]! & 0xffffff00) | 255) >>> 0;
}

/** `pixelToRgba` as hex; null where there is no paint. Grayscale never shows its alpha. */
export function pixelToHex(s: Sprite, value: number, layer?: Layer): string | null {
  const c = pixelToRgba(s, value, layer);
  if ((c & 255) === 0) return null;
  return rgbaToHex(c, s.colorMode === "rgb");
}

export function isOpaque(s: Sprite, value: number, layer?: Layer): boolean {
  return (pixelToRgba(s, value, layer) & 255) !== 0;
}

/**
 * The raw value that paints `c` into this sprite. Indexed picks the
 * RGB-nearest palette entry (as Aseprite's `Color` → index does — use
 * `snapToPalette` for perceptual matching); grayscale keeps luma and alpha.
 */
export function rgbaToPixel(s: Sprite, c: Rgba): number {
  const [r, g, b, a] = channels(c);
  if (s.colorMode === "indexed") {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    s.palette.forEach((p, i) => {
      const [pr, pg, pb] = channels(p);
      const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  }
  if (s.colorMode === "grayscale") {
    const v = Math.floor(0.299 * r + 0.587 * g + 0.114 * b + 0.5);
    return rgba(v, v, v, a);
  }
  return c >>> 0;
}

/**
 * The perceptually nearest palette colour (CIELAB ΔE), keeping `c`'s alpha.
 * Entries with no alpha are skipped; an empty palette leaves `c` as it is.
 */
export function snapToPalette(s: Sprite, c: Rgba): { color: Rgba; distance: number } {
  const [r, g, b, a] = channels(c);
  const target = rgbToLab({ r, g, b, a });
  let best: Rgba | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of s.palette) {
    const [pr, pg, pb, pa] = channels(p);
    if (pa === 0) continue;
    const d = deltaE(target, rgbToLab({ r: pr, g: pg, b: pb, a: pa }));
    if (d < bestD) [best, bestD] = [p, d];
  }
  if (best === null) return { color: c >>> 0, distance: 0 };
  return { color: ((best & 0xffffff00) | a) >>> 0, distance: bestD };
}
