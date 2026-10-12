import { presets } from "../../lib/palettes.js";
import { ToolError, need } from "../errors.js";
import {
  Image,
  channels,
  displayName,
  hexToRgba,
  pixelToRgba,
  rgbaToHex,
  rgbaToPixel,
  type ColorMode,
  type Layer,
  type Rgba,
  type Sprite,
} from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";
import { spriteSummary } from "./session.js";

/** The extension's flatten_layers, for a model with no groups, blend modes or tilemaps. */
function layerInfo(layer: Layer, index: number) {
  return {
    name: layer.name,
    index: index + 1,
    visible: layer.visible,
    editable: layer.editable,
    opacity: layer.opacity,
    blendMode: "normal",
    isGroup: false,
    isTilemap: false,
    cels: [...layer.cels.keys()].sort((a, b) => a - b),
  };
}

function selectionBounds(sprite: Sprite) {
  const sel = sprite.selection;
  if (!sel || sel.bounds.width <= 0 || sel.bounds.height <= 0) return undefined;
  const { x, y, width, height } = sel.bounds;
  return { x, y, width, height };
}

function spriteInfo(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  if (args.includeSlices) {
    throw new ToolError("unsupported_command", "Slices are not supported.", { command: "sprite.info" });
  }
  const active = sprite.layers.length > 0 ? studio.resolveLayer(sprite) : undefined;
  return {
    id: sprite.id,
    name: displayName(sprite),
    filename: sprite.filename ?? undefined,
    width: sprite.width,
    height: sprite.height,
    colorMode: sprite.colorMode,
    transparentIndex: sprite.colorMode === "indexed" ? sprite.transparentIndex : undefined,
    frameCount: sprite.frames.length,
    layers: sprite.layers.map(layerInfo),
    frames: sprite.frames.map((f, i) => ({ number: i + 1, durationMs: Math.round(f.durationMs) })),
    tags: sprite.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction, repeats: t.repeats })),
    modified: sprite.modified,
    activeLayer: active?.name,
    activeFrame: sprite.activeFrame,
    palette: args.includePalette === false ? undefined : sprite.palette.map((c) => rgbaToHex(c, true)),
    selection: selectionBounds(sprite),
  };
}

const COLOR_MODES: readonly ColorMode[] = ["rgb", "grayscale", "indexed"];

function colorModeArg(value: unknown): ColorMode {
  if (COLOR_MODES.includes(value as ColorMode)) return value as ColorMode;
  throw new ToolError("invalid_args", `colorMode must be one of ${COLOR_MODES.join(", ")}, got '${String(value)}'.`);
}

function sizeArg(value: unknown, name: string): number {
  const n = need(value, name);
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new ToolError("invalid_args", `${name} must be a positive integer, got ${String(n)}.`);
  }
  return n;
}

/** Aseprite gives every new sprite its default palette, DawnBringer 32. */
function defaultPalette(): Rgba[] {
  return presets()["dawnbringer-32"]!.colors.map(hexToRgba);
}

const ANCHORS: Record<string, [number, number]> = {
  top_left: [0, 0],
  top: [0.5, 0],
  top_right: [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  bottom_left: [0, 1],
  bottom: [0.5, 1],
  bottom_right: [1, 1],
};

/**
 * Aseprite's crop to (-dx, -dy, w, h): every cel moves by (dx, dy) and keeps
 * only what lands on the new canvas. A cel left with nothing on it is removed,
 * as Aseprite's crop drops cels that end up empty.
 */
function resizeCanvas(studio: Studio, sprite: Sprite, w: number, h: number, dx: number, dy: number): void {
  for (const layer of sprite.layers) {
    for (const [frame, cel] of [...layer.cels]) {
      const x = cel.x + dx;
      const y = cel.y + dy;
      const x0 = Math.max(0, x);
      const y0 = Math.max(0, y);
      const x1 = Math.min(w, x + cel.image.width);
      const y1 = Math.min(h, y + cel.image.height);
      if (x1 <= x0 || y1 <= y0) {
        layer.cels.delete(frame);
        continue;
      }
      const trimmed = studio.newImage(sprite, x1 - x0, y1 - y0);
      for (let ty = 0; ty < trimmed.height; ty++) {
        for (let tx = 0; tx < trimmed.width; tx++) {
          trimmed.set(tx, ty, cel.image.get(x0 - x + tx, y0 - y + ty));
        }
      }
      cel.x = x0;
      cel.y = y0;
      cel.image = trimmed;
    }
  }
  const sel = sprite.selection;
  if (sel) {
    const mask = new Uint8Array(w * h);
    let [minX, minY, maxX, maxY] = [w, h, -1, -1];
    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        if (!sel.mask[y * sprite.width + x]) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        mask[ny * w + nx] = 1;
        [minX, minY, maxX, maxY] = [Math.min(minX, nx), Math.min(minY, ny), Math.max(maxX, nx), Math.max(maxY, ny)];
      }
    }
    sprite.selection = maxX < 0 ? null : { mask, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
  }
  sprite.width = w;
  sprite.height = h;
  sprite.modified = true;
}

/**
 * Re-encodes every cel for `target`. Into indexed, a clear pixel becomes the
 * transparent index and any other the RGB-nearest entry other than it, which
 * is how Aseprite's ChangePixelFormat maps onto an existing palette.
 */
function changeColorMode(sprite: Sprite, target: ColorMode): void {
  if (target === "indexed" && sprite.palette.length < 2) {
    throw new ToolError("invalid_args", "Converting to indexed needs a palette of at least 2 colours. Set one with `palette` first.");
  }
  const before: Sprite = { ...sprite };
  const after: Sprite = { ...sprite, colorMode: target };
  const encode = (c: Rgba): number => {
    if (target !== "indexed") return rgbaToPixel(after, c);
    if (channels(c)[3] === 0) return sprite.transparentIndex;
    const [r, g, b] = channels(c);
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    sprite.palette.forEach((p, i) => {
      if (i === sprite.transparentIndex) return;
      const [pr, pg, pb] = channels(p);
      const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  };
  for (const layer of sprite.layers) {
    for (const cel of layer.cels.values()) {
      const converted = new Image(cel.image.width, cel.image.height);
      cel.image.pixels.forEach((v, i) => {
        converted.pixels[i] = encode(pixelToRgba(before, v));
      });
      cel.image = converted;
    }
  }
  sprite.colorMode = target;
  sprite.modified = true;
}

function spriteManage(studio: Studio, args: Record<string, unknown>) {
  const op = need(args.op, "op");

  if (op === "list") {
    const active = studio.activeSprite();
    return {
      sprites: studio.sprites().map((s) => ({ ...spriteSummary(s), active: s === active, modified: s.modified })),
    };
  }

  if (op === "new") {
    const width = sizeArg(args.width, "width");
    const height = sizeArg(args.height, "height");
    const colorMode = args.colorMode === undefined ? "rgb" : colorModeArg(args.colorMode);
    const s = studio.addSprite({ width, height, colorMode, palette: defaultPalette() });
    return { sprite: displayName(s), id: s.id, width: s.width, height: s.height };
  }

  if (op === "open" || op === "save" || op === "save_as") {
    throw new ToolError("unsupported_command", `sprite.manage op '${op}' is not available yet.`, {
      command: "sprite.manage",
      op,
    });
  }

  if (typeof op === "string" && op.startsWith("slice_")) {
    throw new ToolError("unsupported_command", "Slices are not supported.", { command: "sprite.manage", op });
  }

  const s = studio.resolveSprite(args.sprite);

  if (op === "activate") {
    studio.activate(s);
    return { sprite: displayName(s), id: s.id };
  }

  if (op === "close") {
    studio.closeSprite(s);
    return { sprite: displayName(s), id: s.id };
  }

  if (op === "resize_canvas") {
    const w = args.width === undefined ? s.width : sizeArg(args.width, "width");
    const h = args.height === undefined ? s.height : sizeArg(args.height, "height");
    const [ax, ay] = ANCHORS[String(args.anchor ?? "center")] ?? ANCHORS.center!;
    resizeCanvas(studio, s, w, h, Math.floor((w - s.width) * ax), Math.floor((h - s.height) * ay));
    return { sprite: displayName(s), width: s.width, height: s.height };
  }

  if (op === "set_properties") {
    let pixelRatio: { w: number; h: number } | null = null;
    if (args.pixelAspect !== undefined) {
      const m = /^(\d+):(\d+)$/.exec(String(args.pixelAspect));
      if (!m || Number(m[1]) === 0 || Number(m[2]) === 0) {
        throw new ToolError("invalid_args", `pixelAspect must look like '1:1' or '2:1', got '${String(args.pixelAspect)}'.`);
      }
      pixelRatio = { w: Number(m[1]), h: Number(m[2]) };
    }
    const target = args.colorMode === undefined ? null : colorModeArg(args.colorMode);
    if (target && target !== s.colorMode) changeColorMode(s, target);
    if (pixelRatio) {
      s.pixelRatio = pixelRatio;
      s.modified = true;
    }
    return { sprite: displayName(s), width: s.width, height: s.height };
  }

  throw new ToolError("unsupported_command", `sprite.manage does not support op '${String(op)}'.`, {
    command: "sprite.manage",
    op,
  });
}

export const spriteHandlers: HandlerTable = {
  "sprite.info": spriteInfo,
  "sprite.manage": spriteManage,
};
