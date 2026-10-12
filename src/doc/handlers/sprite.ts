import { ToolError } from "../errors.js";
import { displayName, rgbaToHex, type Layer, type Sprite } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

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

export const spriteHandlers: HandlerTable = {
  "sprite.info": spriteInfo,
};
