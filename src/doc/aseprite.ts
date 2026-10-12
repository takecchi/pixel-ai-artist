/**
 * Documents to and from the .aseprite format. The model holds a subset of
 * what the format can: no groups, tilemaps, blend modes, z-index, slices,
 * reference layers or palette changes over time. A file that uses any of them
 * is refused rather than opened with them dropped, because the picture or the
 * file saved back would silently differ.
 */

import type { AseCel, AseDecoded, AseFile, AseLayer } from "../lib/ase.js";
import { ToolError } from "./errors.js";
import { Image, rgba, type Cel, type ColorMode, type Sprite } from "./model.js";
import type { Studio } from "./studio.js";

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
  count("referenceLayers", file.layers.filter((l) => l.reference).length);
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

/** Adds the decoded file to the studio as an unmodified, active sprite, or refuses one the model cannot hold. */
export function spriteFromAse(studio: Studio, file: AseDecoded, filename: string): Sprite {
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
  sprite.frames = file.frames.map((f) => ({ durationMs: f.durationMs }));
  sprite.tags = file.tags.map((t) => ({
    name: t.name,
    from: t.from + 1,
    to: t.to + 1,
    direction: t.direction,
    repeats: t.repeat,
    color: rgba(...t.color),
  }));
  sprite.layers = [];
  sprite.nextLayerId = 1;
  const layers = file.layers.map((l) => {
    const layer = studio.addLayer(sprite, l.name);
    layer.visible = l.visible;
    layer.editable = l.editable;
    // Aseprite ignores a background layer's opacity; it is always drawn opaque.
    layer.opacity = l.background ? 255 : l.opacity;
    return layer;
  });
  file.frames.forEach((frame, fi) => {
    for (const cel of frame.cels) {
      // A linked cel shares the image of the frame it points to; the model holds a copy.
      const source = cel.linkedFrame === undefined ? cel : file.frames[cel.linkedFrame]?.cels.find((c) => c.layer === cel.layer);
      if (!source?.image) continue;
      const out: Cel = {
        x: cel.x,
        y: cel.y,
        image: celImage(file, source.image.pixels, source.image.width, source.image.height),
        opacity: cel.opacity,
      };
      layers[cel.layer]!.cels.set(fi + 1, out);
    }
  });
  sprite.activeLayerId = layers.at(-1)?.id ?? null;
  sprite.activeFrame = 1;
  sprite.modified = false;
  return sprite;
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

/** The sprite as an .aseprite file: every layer a plain image layer, every cel its own image. */
export function aseFromSprite(sprite: Sprite): AseFile {
  const palette = new Uint8Array(sprite.palette.length * 4);
  sprite.palette.forEach((c, i) => {
    palette[i * 4] = c >>> 24;
    palette[i * 4 + 1] = (c >>> 16) & 255;
    palette[i * 4 + 2] = (c >>> 8) & 255;
    palette[i * 4 + 3] = c & 255;
  });
  const layers: AseLayer[] = sprite.layers.map((l) => ({
    name: l.name,
    type: "image",
    childLevel: 0,
    visible: l.visible,
    editable: l.editable,
    background: false,
    lockMovement: false,
    preferLinkedCels: false,
    collapsed: false,
    reference: false,
    blendMode: 0,
    opacity: l.opacity,
  }));
  return {
    width: sprite.width,
    height: sprite.height,
    colorMode: MODE_TO_ASE[sprite.colorMode],
    transparentIndex: sprite.colorMode === "indexed" ? sprite.transparentIndex : 0,
    palette,
    layers,
    frames: sprite.frames.map((f, fi) => {
      const cels: AseCel[] = [];
      sprite.layers.forEach((l, li) => {
        const cel = l.cels.get(fi + 1);
        if (!cel) return;
        cels.push({
          layer: li,
          x: cel.x,
          y: cel.y,
          opacity: cel.opacity,
          zIndex: 0,
          image: { width: cel.image.width, height: cel.image.height, pixels: celPixels(sprite, cel.image) },
        });
      });
      return { durationMs: Math.min(0xffff, Math.max(1, Math.round(f.durationMs))), cels };
    }),
    tags: sprite.tags.map((t) => ({
      name: t.name,
      from: t.from - 1,
      to: t.to - 1,
      direction: t.direction,
      repeat: t.repeats,
      color: [t.color >>> 24, (t.color >>> 16) & 255, (t.color >>> 8) & 255, t.color & 255],
    })),
    pixelRatio: { ...sprite.pixelRatio },
  };
}
