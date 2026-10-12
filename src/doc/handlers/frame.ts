import { ToolError, need } from "../errors.js";
import { displayName, type Cel, type Sprite } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

/** Renumbers every cel keyed by frame through `map`; a frame mapped to null loses its cels. */
function renumberCels(sprite: Sprite, map: (frame: number) => number | null): void {
  for (const layer of sprite.layers) {
    const moved = new Map<number, Cel>();
    for (const [frame, cel] of layer.cels) {
      const to = map(frame);
      if (to !== null) moved.set(to, cel);
    }
    layer.cels = moved;
  }
}

/**
 * Inserts an empty frame at `at`, taking the duration of the frame before it.
 * A tag starting at or after `at` moves along; one spanning it grows.
 */
function insertFrame(sprite: Sprite, at: number): void {
  const durationMs = sprite.frames[at - 2]?.durationMs ?? sprite.frames[0]?.durationMs ?? 100;
  sprite.frames.splice(at - 1, 0, { durationMs });
  renumberCels(sprite, (f) => (f >= at ? f + 1 : f));
  for (const tag of sprite.tags) {
    if (tag.from >= at) tag.from++;
    if (tag.to >= at) tag.to++;
  }
  if (sprite.activeFrame >= at) sprite.activeFrame++;
}

/** Removes frame `at` with its cels; tags past it move back, and a tag left with no frames goes. */
function deleteFrame(sprite: Sprite, at: number): void {
  if (sprite.frames.length === 1) throw new ToolError("invalid_args", "A sprite keeps at least one frame.");
  sprite.frames.splice(at - 1, 1);
  renumberCels(sprite, (f) => (f === at ? null : f > at ? f - 1 : f));
  for (const tag of sprite.tags) {
    if (tag.from > at) tag.from--;
    if (tag.to >= at) tag.to--;
  }
  sprite.tags = sprite.tags.filter((t) => t.from <= t.to);
  if (sprite.activeFrame > at || sprite.activeFrame > sprite.frames.length) sprite.activeFrame--;
}

function durationArg(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ToolError("invalid_args", `${name} must be a whole number of milliseconds from 1 to 65535, got ${String(value)}.`);
  }
  return value;
}

function countArg(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolError("invalid_args", `count must be a positive integer, got ${String(value)}.`);
  }
  return value;
}

function apply(studio: Studio, sprite: Sprite, op: string, args: Record<string, unknown>): void {
  switch (op) {
    case "add": {
      const count = countArg(args.count);
      let at = sprite.frames.length + 1;
      if (args.afterFrame !== undefined) {
        const after = Math.floor(Number(args.afterFrame));
        if (!(after >= 0 && after <= sprite.frames.length)) {
          throw new ToolError("invalid_args", `afterFrame ${String(args.afterFrame)} is outside frames 0–${sprite.frames.length}.`);
        }
        at = after + 1;
      }
      for (let i = 0; i < count; i++) insertFrame(sprite, at);
      break;
    }
    case "duplicate": {
      if (args.linkCels === true) {
        throw new ToolError("unsupported_command", "Linked cels are not supported; duplicate without linkCels copies the cels.");
      }
      const src = studio.resolveFrame(sprite, args.frame);
      for (let i = 0; i < countArg(args.count); i++) {
        insertFrame(sprite, src + 1);
        for (const layer of sprite.layers) {
          const cel = layer.cels.get(src);
          if (cel) layer.cels.set(src + 1, { ...cel, image: cel.image.clone() });
        }
      }
      break;
    }
    case "delete":
      deleteFrame(sprite, studio.resolveFrame(sprite, args.frame));
      break;
    case "set_duration":
      if (Array.isArray(args.durations)) {
        const ms = args.durations.map((d, i) => durationArg(d, `durations[${i}]`));
        ms.slice(0, sprite.frames.length).forEach((d, i) => (sprite.frames[i]!.durationMs = d));
      } else {
        const ms = durationArg(need(args.durationMs, "durationMs"), "durationMs");
        if (args.frame !== undefined) sprite.frames[studio.resolveFrame(sprite, args.frame) - 1]!.durationMs = ms;
        else for (const f of sprite.frames) f.durationMs = ms;
      }
      break;
    case "activate":
      sprite.activeFrame = studio.resolveFrame(sprite, args.frame);
      return;
    case "reorder": {
      const from = studio.resolveFrame(sprite, args.frame);
      const to = need(args.toIndex, "toIndex") as number;
      if (!(to >= 1 && to <= sprite.frames.length)) {
        throw new ToolError("invalid_args", `toIndex ${String(to)} is outside frames 1–${sprite.frames.length}.`);
      }
      if (to === from) return;
      // Frames move; tag ranges stay on the positions they cover.
      const [moved] = sprite.frames.splice(from - 1, 1);
      sprite.frames.splice(to - 1, 0, moved!);
      renumberCels(sprite, (f) => {
        if (f === from) return to;
        if (from < to && f > from && f <= to) return f - 1;
        if (to < from && f >= to && f < from) return f + 1;
        return f;
      });
      break;
    }
    default:
      throw new ToolError("unsupported_command", `frame op '${op}' is not supported.`);
  }
  sprite.modified = true;
}

function frameApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const op = String(need(args.op, "op"));
  if (op !== "list") apply(studio, sprite, op, args);
  const frames = sprite.frames.map((f, i) => ({ number: i + 1, durationMs: Math.round(f.durationMs) }));
  return {
    sprite: displayName(sprite),
    frameCount: frames.length,
    frames,
    totalDurationMs: frames.reduce((sum, f) => sum + f.durationMs, 0),
    activeFrame: sprite.activeFrame,
  };
}

export const frameHandlers: HandlerTable = {
  "frame.apply": frameApply,
};
