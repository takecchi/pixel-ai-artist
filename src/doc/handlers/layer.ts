import { ToolError, need } from "../errors.js";
import { Image, displayName, pixelToRgba, rgbaToPixel, type Cel, type Layer, type Sprite } from "../model.js";
import { over, type HandlerTable, type Studio } from "../studio.js";
import { layerInfo } from "./sprite.js";

type Op = Record<string, unknown>;

interface Duplicated {
  sourceLayer: string;
  name: string;
  toSprite: string;
  framesDropped: number;
}

/** What a batch may change, so a failure part-way leaves the sprites as they were. */
function snapshot(sprite: Sprite) {
  const layers = sprite.layers.map((layer) => ({
    layer,
    name: layer.name,
    visible: layer.visible,
    editable: layer.editable,
    opacity: layer.opacity,
    cels: new Map([...layer.cels].map(([frame, cel]) => [frame, { ...cel }])),
  }));
  const { activeLayerId, nextLayerId, modified } = sprite;
  return () => {
    sprite.layers = layers.map(({ layer, cels, ...fields }) => {
      Object.assign(layer, fields);
      layer.cels = cels;
      return layer;
    });
    Object.assign(sprite, { activeLayerId, nextLayerId, modified });
  };
}

function opacityArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new ToolError("invalid_args", `opacity must be an integer from 0 to 255, got ${String(value)}.`);
  }
  return value;
}

/** Moves `layer` to 1-based stack position `index` (1 = bottom), clamped to the stack. */
function restack(sprite: Sprite, layer: Layer, index: unknown): void {
  const n = Math.floor(Number(index));
  if (!Number.isFinite(n)) throw new ToolError("invalid_args", `index must be a number, got ${String(index)}.`);
  const target = Math.min(Math.max(n, 1), sprite.layers.length) - 1;
  // Aseprite only treats the bottom layer as the Background, so it keeps it there.
  if (layer.background && target !== 0) {
    throw new ToolError("invalid_args", "The background layer cannot be moved.");
  }
  const bottom = sprite.layers.find((l) => l !== layer);
  if (!layer.background && target === 0 && bottom?.background) {
    throw new ToolError("invalid_args", "You cannot move or copy something below the background layer.");
  }
  sprite.layers.splice(sprite.layers.indexOf(layer), 1);
  sprite.layers.splice(target, 0, layer);
}

/** `base`, or `base 2`, `base 3`… — the first that no layer of the sprite already has. */
export function freeLayerName(sprite: Sprite, base: string): string {
  const taken = new Set(sprite.layers.map((l) => l.name));
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) name = `${base} ${suffix}`;
  return name;
}

/**
 * Two layers with one name can never be told apart again — a lookup by name
 * refuses as ambiguous, as the extension's did, and without groups there is
 * no path to pass instead — so a name an agent chooses must be free.
 */
function refuseTaken(sprite: Sprite, name: string, self?: Layer): void {
  if (sprite.layers.some((l) => l !== self && l.name === name)) {
    throw new ToolError("invalid_args", `A layer named '${name}' already exists. Pick another name.`);
  }
}

function cloneCel(cel: Cel): Cel {
  return { ...cel, image: cel.image.clone() };
}

/** Aseprite's DuplicateLayer: a copy named "<name> Copy" directly above, with every cel. */
function duplicateHere(studio: Studio, sprite: Sprite, layer: Layer): void {
  const active = sprite.activeLayerId;
  const copy = studio.addLayer(sprite, freeLayerName(sprite, `${layer.name} Copy`));
  Object.assign(copy, { visible: layer.visible, editable: layer.editable, opacity: layer.opacity });
  if (layer.reference) copy.reference = true;
  for (const [frame, cel] of layer.cels) copy.cels.set(frame, cloneCel(cel));
  sprite.layers.pop();
  sprite.layers.splice(sprite.layers.indexOf(layer) + 1, 0, copy);
  sprite.activeLayerId = active;
}

function duplicateInto(studio: Studio, source: Sprite, layer: Layer, target: Sprite): Duplicated {
  const name = freeLayerName(target, layer.name);
  const active = target.activeLayerId;
  const copy = studio.addLayer(target, name);
  target.activeLayerId = active;
  copy.opacity = layer.opacity;
  copy.visible = layer.visible;
  if (layer.reference) copy.reference = true;
  let framesDropped = 0;
  for (const [frame, cel] of layer.cels) {
    if (frame > target.frames.length) {
      framesDropped++;
      continue;
    }
    // Pixels are raw colour-mode values; a sprite in another mode needs them re-encoded.
    const image = new Image(cel.image.width, cel.image.height);
    cel.image.pixels.forEach((v, i) => {
      image.pixels[i] = rgbaToPixel(target, pixelToRgba(source, v, layer));
    });
    copy.cels.set(frame, { x: cel.x, y: cel.y, image, opacity: 255 });
  }
  return { sourceLayer: layer.name, name, toSprite: `#${target.id}`, framesDropped };
}

/**
 * Aseprite's MergeDownLayer: `layer` is painted onto the one below at its
 * layer × cel opacity, frame by frame, and removed; the lower layer keeps its
 * name and settings.
 */
function mergeDown(studio: Studio, sprite: Sprite, layer: Layer): void {
  const at = sprite.layers.indexOf(layer);
  const below = sprite.layers[at - 1];
  if (!below) throw new ToolError("invalid_args", `'${layer.name}' is the bottom layer; there is nothing to merge it into.`);
  for (const [frame, upper] of layer.cels) {
    const lower = studio.ensureCel(sprite, below, frame, { x: upper.x, y: upper.y, width: upper.image.width, height: upper.image.height });
    // The batch snapshot shares image buffers; write to a fresh one so a later failure can roll back.
    lower.image = lower.image.clone();
    const opacity = Math.round((layer.opacity * upper.opacity) / 255);
    for (let y = 0; y < upper.image.height; y++) {
      for (let x = 0; x < upper.image.width; x++) {
        const lx = upper.x + x - lower.x;
        const ly = upper.y + y - lower.y;
        if (!lower.image.contains(lx, ly)) continue;
        const mixed = over(pixelToRgba(sprite, lower.image.get(lx, ly), below), pixelToRgba(sprite, upper.image.get(x, y), layer), opacity);
        lower.image.set(lx, ly, (mixed & 255) === 0 ? lower.image.get(lx, ly) : rgbaToPixel(sprite, mixed));
      }
    }
  }
  sprite.layers.splice(at, 1);
  if (sprite.activeLayerId === layer.id) sprite.activeLayerId = below.id;
}

function applyOp(studio: Studio, sprite: Sprite, op: Op, duplicated: Duplicated[]): void {
  const kind = op.op;
  if (kind === "create") {
    let name: string;
    if (typeof op.name === "string") {
      refuseTaken(sprite, op.name);
      name = op.name;
    } else {
      let n = sprite.layers.length + 1;
      while (sprite.layers.some((l) => l.name === `Layer ${n}`)) n++;
      name = `Layer ${n}`;
    }
    const layer = studio.addLayer(sprite, name);
    if (op.opacity !== undefined) layer.opacity = opacityArg(op.opacity);
    if (op.visible !== undefined) layer.visible = Boolean(op.visible);
    if (op.editable !== undefined) layer.editable = Boolean(op.editable);
    if (op.index !== undefined) restack(sprite, layer, op.index);
    return;
  }
  if (kind === "list" || typeof kind !== "string") {
    throw new ToolError("unsupported_command", `layer op '${String(kind)}' is not supported.`);
  }

  const layer = studio.resolveLayer(sprite, op.name);
  switch (kind) {
    case "rename": {
      const name = String(need(op.newName, "newName"));
      refuseTaken(sprite, name, layer);
      layer.name = name;
      break;
    }
    case "delete":
      if (sprite.layers.length === 1) throw new ToolError("invalid_args", "A sprite keeps at least one layer.");
      sprite.layers.splice(sprite.layers.indexOf(layer), 1);
      break;
    case "reorder":
      restack(sprite, layer, need(op.index, "index"));
      break;
    case "activate":
      sprite.activeLayerId = layer.id;
      return;
    case "duplicate":
      if (op.toSprite !== undefined) duplicated.push(duplicateInto(studio, sprite, layer, studio.resolveSprite(op.toSprite)));
      else duplicateHere(studio, sprite, layer);
      break;
    case "merge":
      mergeDown(studio, sprite, layer);
      break;
    case "set":
      if (op.newName !== undefined) refuseTaken(sprite, String(op.newName), layer);
      if (op.visible !== undefined) layer.visible = Boolean(op.visible);
      if (op.editable !== undefined) layer.editable = Boolean(op.editable);
      if (op.opacity !== undefined) layer.opacity = opacityArg(op.opacity);
      if (op.newName !== undefined) layer.name = String(op.newName);
      break;
    default:
      throw new ToolError("unsupported_command", `layer op '${kind}' is not supported.`);
  }
  sprite.modified = true;
}

function report(studio: Studio, sprite: Sprite) {
  return {
    sprite: displayName(sprite),
    layers: sprite.layers.map(layerInfo),
    activeLayer: sprite.layers.length > 0 ? studio.resolveLayer(sprite).name : undefined,
  };
}

function layerApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const batch = Array.isArray(args.batch) ? (args.batch as Op[]) : null;
  if (args.op === "list" && !batch) return report(studio, sprite);

  const ops = batch ?? [args];
  const duplicated: Duplicated[] = [];
  const undo = studio.sprites().map(snapshot);
  try {
    for (const op of ops) applyOp(studio, sprite, op, duplicated);
  } catch (err) {
    for (const restore of undo) restore();
    throw err;
  }
  for (const target of new Set(duplicated.map((d) => d.toSprite))) studio.resolveSprite(target).modified = true;
  return {
    ...report(studio, sprite),
    applied: ops.length,
    duplicated: duplicated.length > 0 ? duplicated : undefined,
  };
}

export const layerHandlers: HandlerTable = {
  "layer.apply": layerApply,
};
