/**
 * Documents to and from the .aseprite format. The model holds a subset of
 * what the format can: no groups, tilemaps, blend modes, z-index, slices or
 * palette changes over time. A file that uses any of them
 * is refused rather than opened with them dropped, because the picture or the
 * file saved back would silently differ.
 */

import { celSource, type AseCel, type AseDecoded, type AseFile, type AseLayer, type AseUserData } from "../lib/ase.js";
import { ToolError } from "./errors.js";
import { Image, rgba, type Cel, type ColorMode, type Layer, type Sprite } from "./model.js";
import type { Studio } from "./studio.js";

/**
 * How a reference layer is marked in a saved file: a line of the layer's user
 * data text. Aseprite's reference flag would make it a reference layer there
 * too, which the Lua handler's import never did. The whole line has to match,
 * so a note that merely mentions the mark does not make a reference layer.
 */
export const REFERENCE_MARK = "pixel-ai-artist:reference";

const isMarkLine = (line: string) => line.replace(/\r?\n$/, "").replace(/\r$/, "") === REFERENCE_MARK;

function splitMark(text: string | undefined): { marked: boolean; rest: string | undefined; ends?: { end: string; sep: string } } {
  if (text === undefined) return { marked: false, rest: undefined };
  // Lines keep their own terminator, so what stays is byte for byte as it was, whether it used \r\n or \n.
  const lines = text.split(/(?<=\n)/);
  if (text.endsWith("\n")) lines.push("");
  if (!lines.some(isMarkLine)) return { marked: false, rest: text };
  const markLine = lines.find(isMarkLine)!;
  const end = /\r?\n$/.exec(markLine)?.[0] ?? "";
  const kept = lines.filter((line) => !isMarkLine(line));
  if (kept.length === 0) return { marked: true, rest: undefined, ends: { end, sep: "" } };
  let rest = kept.join("");
  let sep = "";
  // The mark was the last line, so the terminator of the line before it ended nothing.
  if (!lines.at(-1)!.endsWith("\n") && isMarkLine(lines.at(-1)!)) {
    sep = /\r?\n$/.exec(rest)?.[0] ?? "";
    rest = rest.slice(0, rest.length - sep.length);
  }
  return { marked: true, rest, ends: { end, sep } };
}

const MODE_FROM_ASE: Record<AseDecoded["colorMode"], ColorMode> = { rgba: "rgb", grayscale: "grayscale", indexed: "indexed" };
const MODE_TO_ASE: Record<ColorMode, AseFile["colorMode"]> = { rgb: "rgba", grayscale: "grayscale", indexed: "indexed" };

/** What in a decoded file the model cannot hold, counted by kind; empty when it can hold all of it. */
export function unsupportedAseFeatures(file: AseDecoded): Record<string, number> {
  const found: Record<string, number> = {};
  const count = (name: string, n: number) => {
    if (n > 0) found[name] = (found[name] ?? 0) + n;
  };
  count("groups", file.layers.filter((l) => l.type === "group").length);
  count("tilemapLayers", file.layers.filter((l) => l.type === "tilemap").length);
  count("blendModes", file.layers.filter((l) => l.type === "image" && !l.background && l.blendMode !== 0).length);
  count("zIndexCels", file.features.zIndexCels);
  count("tilemapCels", file.features.tilemapCels);
  count("slices", file.features.slices);
  count("tilesets", file.features.tilesets);
  count("paletteChanges", file.features.paletteChanges);
  return found;
}

function celImage(file: AseDecoded, pixels: Uint8Array, width: number, height: number): Image {
  const img = new Image(width, height);
  for (let i = 0; i < img.pixels.length; i++) {
    if (file.colorMode === "rgba") {
      img.pixels[i] = rgba(pixels[i * 4]!, pixels[i * 4 + 1]!, pixels[i * 4 + 2]!, pixels[i * 4 + 3]!);
    } else if (file.colorMode === "grayscale") {
      const v = pixels[i * 2]!;
      img.pixels[i] = rgba(v, v, v, pixels[i * 2 + 1]!);
    } else {
      img.pixels[i] = pixels[i]!;
    }
  }
  return img;
}

export interface RenamedLayer {
  from: string;
  to: string;
}

/**
 * Layer names made unique, bottom to top: the first keeps its name and each
 * later one takes " 2", " 3", ... — the first free number among every name in
 * the file; an empty name takes Aseprite's "Layer N" instead. Tools find
 * layers by name, and with no group paths in the model a shared name could
 * never be told apart.
 */
function numbered(name: string, taken: Set<string>): string {
  let n = 2;
  while (taken.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/** Aseprite's name for a new layer: "Layer " and one more than the highest number any "Layer N" has. */
function asepriteLayerName(taken: Set<string>): string {
  let max = 0;
  for (const name of taken) {
    if (name.startsWith("Layer ")) max = Math.max(max, Number.parseInt(name.slice(6), 10) || 0);
  }
  return `Layer ${max + 1}`;
}

function uniqueNames(names: readonly string[]): { names: string[]; renamed: RenamedLayer[] } {
  const taken = new Set(names);
  const seen = new Set<string>();
  const renamed: RenamedLayer[] = [];
  const out = names.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    const to = name === "" ? asepriteLayerName(taken) : numbered(name, taken);
    taken.add(to);
    seen.add(to);
    renamed.push({ from: name, to });
    return to;
  });
  return { names: out, renamed };
}

/** What opening a file did not carry into the sprite, or a later save will not write back, counted by kind. */
export interface AseOpenNotes {
  renamedLayers: RenamedLayer[];
  /** Kept only until saved: a save writes them some other way, or not at all. */
  lostOnSave: Record<string, number>;
  /** Left out when the file was read, as Aseprite leaves them out. */
  skippedOnOpen: Record<string, number>;
  /** Background layers that were not at the bottom of the file's stack and were moved there, keeping their order. */
  misplacedBackground: string[];
}

function counts(entries: [string, number][]): Record<string, number> {
  return Object.fromEntries(entries.filter(([, n]) => n > 0));
}

function withoutEmpty(data: AseUserData): AseUserData | undefined {
  return Object.keys(data).length > 0 ? data : undefined;
}

/**
 * Adds the decoded file to the studio as an unmodified, active sprite, or
 * refuses one the model cannot hold. Layers that share a name are renamed;
 * the renames, and what the file holds that a save will not keep, are
 * returned for the caller to report.
 */
export function spriteFromAse(studio: Studio, file: AseDecoded, filename: string): { sprite: Sprite } & AseOpenNotes {
  const unsupported = unsupportedAseFeatures(file);
  if (Object.keys(unsupported).length > 0) {
    throw new ToolError(
      "unsupported_command",
      `'${filename}' uses ${Object.keys(unsupported).join(", ")}, which are not supported; opening it would change the picture or lose them on save.`,
      { path: filename, unsupported },
    );
  }
  const palette: number[] = [];
  for (let i = 0; i < file.palette.length; i += 4) {
    palette.push(rgba(file.palette[i]!, file.palette[i + 1]!, file.palette[i + 2]!, file.palette[i + 3]!));
  }
  const sprite = studio.addSprite({
    width: file.width,
    height: file.height,
    colorMode: MODE_FROM_ASE[file.colorMode],
    filename,
    palette,
  });
  sprite.transparentIndex = file.colorMode === "indexed" ? file.transparentIndex : 0;
  sprite.pixelRatio = { ...file.pixelRatio };
  const spriteExtra = {
    ...(file.grid ? { grid: file.grid } : {}),
    ...(file.userData ? { userData: file.userData } : {}),
    ...(file.colorProfile ? { colorProfile: file.colorProfile } : {}),
    ...(file.externalFiles ? { externalFiles: file.externalFiles } : {}),
  };
  if (Object.keys(spriteExtra).length > 0) sprite.aseprite = spriteExtra;
  sprite.frames = file.frames.map((f) => ({ durationMs: f.durationMs }));
  sprite.tags = file.tags.map((t) => ({
    name: t.name,
    from: t.from + 1,
    to: t.to + 1,
    direction: t.direction,
    repeats: t.repeat,
    color: rgba(...t.color),
    ...(t.userData ? { aseprite: { userData: t.userData } } : {}),
  }));
  sprite.layers = [];
  sprite.nextLayerId = 1;
  const { names, renamed } = uniqueNames(file.layers.map((l) => l.name));
  const layers = file.layers.map((l, i) => {
    const layer = studio.addLayer(sprite, names[i]!);
    layer.visible = l.visible;
    layer.editable = l.editable;
    layer.opacity = l.opacity;
    if (l.background) layer.background = true;
    const { marked, rest, ends } = splitMark(l.userData?.text);
    // The Lua handler's reference layers are ordinary layers; Aseprite's own are marked too, and keep their flag.
    if (marked || l.reference) layer.reference = true;
    let userData: AseUserData | undefined;
    if (l.userData) {
      const { text: _text, ...others } = l.userData;
      userData = withoutEmpty(rest === undefined ? others : { ...others, text: rest });
    }
    const extra = {
      ...(l.lockMovement ? { lockMovement: true } : {}),
      ...(l.preferLinkedCels ? { preferLinkedCels: true } : {}),
      ...(l.collapsed ? { collapsed: true } : {}),
      ...(l.reference ? { referenceFlag: true } : {}),
      ...(l.otherFlags ? { otherFlags: l.otherFlags } : {}),
      ...(userData ? { userData } : {}),
      ...(ends && (ends.end || ends.sep) ? { markLineEnds: ends } : {}),
    };
    if (Object.keys(extra).length > 0) layer.aseprite = extra;
    return layer;
  });
  let linkedCels = 0;
  file.frames.forEach((frame, fi) => {
    for (const cel of frame.cels) {
      let source: AseCel;
      try {
        source = celSource(file.frames, fi, cel);
      } catch (err) {
        throw new ToolError("io_error", `Cannot open '${filename}': ${(err as Error).message}`, { path: filename });
      }
      if (cel.linkedFrame !== undefined) linkedCels++;
      const userData = cel.userData ?? source.userData;
      const out: Cel = {
        x: cel.x,
        y: cel.y,
        image: celImage(file, source.image!.pixels, source.image!.width, source.image!.height),
        opacity: cel.opacity,
        ...(userData || cel.extra ? { aseprite: { ...(userData ? { userData } : {}), ...(cel.extra ? { extra: cel.extra } : {}) } } : {}),
      };
      layers[cel.layer]!.cels.set(fi + 1, out);
    }
  });
  // Composite draws Background layers first; moving them under the rest keeps that picture, and the stack then says what is drawn.
  const backgrounds = layers.filter((l) => l.background);
  const misplaced = !layers.slice(0, backgrounds.length).every((l) => l.background);
  if (misplaced) sprite.layers = [...backgrounds, ...layers.filter((l) => !l.background)];
  sprite.activeLayerId = sprite.layers.at(-1)?.id ?? null;
  sprite.activeFrame = 1;
  sprite.modified = false;
  return {
    sprite,
    renamedLayers: renamed,
    misplacedBackground: misplaced ? backgrounds.map((l) => l.name) : [],
    lostOnSave: counts([
      ["linkedCels", linkedCels],
      ["layerUuids", file.features.layerUuids],
      ["unknownChunks", file.features.unknownChunks],
    ]),
    skippedOnOpen: counts([
      ["cels", file.features.droppedCels],
      ["frameBytes", file.features.unreadFrameBytes],
    ]),
  };
}

function celPixels(sprite: Sprite, img: Image): Uint8Array {
  const n = img.pixels.length;
  if (sprite.colorMode === "indexed") return Uint8Array.from(img.pixels, (v) => v & 255);
  const bpp = sprite.colorMode === "rgb" ? 4 : 2;
  const out = new Uint8Array(n * bpp);
  for (let i = 0; i < n; i++) {
    const v = img.pixels[i]!;
    if (bpp === 4) {
      out[i * 4] = v >>> 24;
      out[i * 4 + 1] = (v >>> 16) & 255;
      out[i * 4 + 2] = (v >>> 8) & 255;
      out[i * 4 + 3] = v & 255;
    } else {
      out[i * 2] = v >>> 24;
      out[i * 2 + 1] = v & 255;
    }
  }
  return out;
}

/** The layer's user data with the reference mark as a line of its text, added only when the layer has no Aseprite flag to carry it. */
function layerUserData(l: Layer): AseUserData | undefined {
  const kept = l.aseprite?.userData;
  const markLine = l.reference && !l.aseprite?.referenceFlag;
  if (!markLine) return kept;
  const eol = kept?.text?.includes("\r\n") ? "\r\n" : "\n";
  const before = kept?.text ?? "";
  // A mark read from the file goes back with the line endings it had there; a new one follows the text's own.
  const ends = l.aseprite?.markLineEnds;
  let text: string;
  if (before === "") text = REFERENCE_MARK + (ends?.end ?? "");
  else if (before.endsWith("\n")) text = before + REFERENCE_MARK + (ends ? ends.end : eol);
  // A mark that sat mid-text moves to the end, its own line ending now separating it from the line before.
  else text = before + (ends?.sep || ends?.end || eol) + REFERENCE_MARK;
  return { ...kept, text };
}

export interface AdjustedDuration {
  frame: number;
  from: number;
  to: number;
}

export interface AdjustedBackgroundOpacity {
  layer: string;
  from: number;
  to: 255;
}

/**
 * The sprite as an .aseprite file: every layer a plain image layer, every cel
 * its own image, with what an opened file carried written back. A frame
 * duration outside the format's 1..65535 ms is brought into range and
 * returned; anything else the format cannot hold is refused.
 */
export function aseFromSprite(sprite: Sprite): {
  file: AseFile;
  adjustedDurations: AdjustedDuration[];
  adjustedBackgroundOpacity: AdjustedBackgroundOpacity[];
} {
  if (sprite.colorMode === "indexed" && sprite.transparentIndex > 255) {
    throw new ToolError("invalid_args", `An .aseprite file stores the transparent index in one byte; ${sprite.transparentIndex} does not fit.`);
  }
  const palette = new Uint8Array(sprite.palette.length * 4);
  sprite.palette.forEach((c, i) => {
    palette[i * 4] = c >>> 24;
    palette[i * 4 + 1] = (c >>> 16) & 255;
    palette[i * 4 + 2] = (c >>> 8) & 255;
    palette[i * 4 + 3] = c & 255;
  });
  const adjustedBackgroundOpacity: AdjustedBackgroundOpacity[] = [];
  const layers: AseLayer[] = sprite.layers.map((l) => {
    const extra = l.aseprite ?? {};
    if (l.background && l.opacity !== 255) adjustedBackgroundOpacity.push({ layer: l.name, from: l.opacity, to: 255 });
    const userData = layerUserData(l);
    return {
      name: l.name,
      type: "image",
      childLevel: 0,
      visible: l.visible,
      editable: l.editable,
      background: l.background === true,
      lockMovement: extra.lockMovement === true,
      preferLinkedCels: extra.preferLinkedCels === true,
      collapsed: extra.collapsed === true,
      reference: extra.referenceFlag === true && l.reference === true,
      blendMode: 0,
      // Aseprite reads a Background layer's opacity as 255 whatever is stored.
      opacity: l.background ? 255 : l.opacity,
      ...(extra.otherFlags ? { otherFlags: extra.otherFlags } : {}),
      ...(userData ? { userData } : {}),
    };
  });
  const adjustedDurations: AdjustedDuration[] = [];
  const frames = sprite.frames.map((f, fi) => {
    const durationMs = Math.min(0xffff, Math.max(1, Math.round(f.durationMs)));
    if (durationMs !== f.durationMs) adjustedDurations.push({ frame: fi + 1, from: f.durationMs, to: durationMs });
    const cels: AseCel[] = [];
    sprite.layers.forEach((l, li) => {
      const cel = l.cels.get(fi + 1);
      if (!cel) return;
      for (const [axis, v] of [["x", cel.x], ["y", cel.y]] as const) {
        if (v < -32768 || v > 32767) {
          throw new ToolError(
            "invalid_args",
            `Layer '${l.name}' frame ${fi + 1} has its cel at ${axis}=${v}; an .aseprite file holds positions from -32768 to 32767.`,
          );
        }
      }
      cels.push({
        layer: li,
        x: cel.x,
        y: cel.y,
        opacity: cel.opacity,
        zIndex: 0,
        image: { width: cel.image.width, height: cel.image.height, pixels: celPixels(sprite, cel.image) },
        ...(cel.aseprite?.userData ? { userData: cel.aseprite.userData } : {}),
        ...(cel.aseprite?.extra ? { extra: cel.aseprite.extra } : {}),
      });
    });
    return { durationMs, cels };
  });
  const grid = sprite.aseprite?.grid;
  const file: AseFile = {
    width: sprite.width,
    height: sprite.height,
    colorMode: MODE_TO_ASE[sprite.colorMode],
    transparentIndex: sprite.colorMode === "indexed" ? sprite.transparentIndex : 0,
    palette,
    layers,
    frames,
    tags: sprite.tags.map((t) => ({
      name: t.name,
      from: t.from - 1,
      to: t.to - 1,
      direction: t.direction,
      repeat: t.repeats,
      color: [t.color >>> 24, (t.color >>> 16) & 255, (t.color >>> 8) & 255, t.color & 255],
      ...(t.aseprite?.userData ? { userData: t.aseprite.userData } : {}),
    })),
    pixelRatio: { ...sprite.pixelRatio },
    ...(grid ? { grid } : {}),
    ...(sprite.aseprite?.userData ? { userData: sprite.aseprite.userData } : {}),
    ...(sprite.aseprite?.colorProfile ? { colorProfile: sprite.aseprite.colorProfile } : {}),
    ...(sprite.aseprite?.externalFiles ? { externalFiles: sprite.aseprite.externalFiles } : {}),
  };
  return { file, adjustedDurations, adjustedBackgroundOpacity };
}
