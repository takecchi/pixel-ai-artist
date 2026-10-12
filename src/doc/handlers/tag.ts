import { ToolError, need } from "../errors.js";
import { displayName, hexToRgba, rgba, type Sprite, type Tag, type TagDirection } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

const DIRECTIONS: readonly TagDirection[] = ["forward", "reverse", "pingpong", "pingpong_reverse"];

function directionArg(value: unknown): TagDirection {
  if (DIRECTIONS.includes(value as TagDirection)) return value as TagDirection;
  throw new ToolError("invalid_args", `direction must be one of ${DIRECTIONS.join(", ")}, got '${String(value)}'.`);
}

function repeatsArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ToolError("invalid_args", `repeats must be a whole number, 0 for forever, got ${String(value)}.`);
  }
  return value;
}

function checkRange(sprite: Sprite, from: unknown, to: unknown): [number, number] {
  const f = Number(from);
  const t = Number(to);
  if (!(Number.isInteger(f) && Number.isInteger(t) && f >= 1 && f <= t && t <= sprite.frames.length)) {
    throw new ToolError(
      "invalid_args",
      `Tag range ${String(from)}–${String(to)} must run forward within frames 1–${sprite.frames.length}.`,
    );
  }
  return [f, t];
}

/** Every field the op sets, checked before any is written, so a refusal leaves the tag as it was. */
function fields(sprite: Sprite, args: Record<string, unknown>, base: { from: number; to: number }) {
  const [from, to] = checkRange(sprite, args.from ?? base.from, args.to ?? base.to);
  return {
    from,
    to,
    ...(args.direction !== undefined ? { direction: directionArg(args.direction) } : {}),
    ...(args.repeats !== undefined ? { repeats: repeatsArg(args.repeats) } : {}),
    ...(args.color !== undefined ? { color: hexToRgba(String(args.color)) } : {}),
  };
}

function apply(sprite: Sprite, op: string, args: Record<string, unknown>): void {
  if (op === "create") {
    const from = need(args.from, "from");
    const to = need(args.to, "to");
    const name = String(need(args.name, "name"));
    const tag: Tag = { name, direction: "forward", repeats: 0, color: rgba(0, 0, 0), ...fields(sprite, args, { from: from as number, to: to as number }) };
    sprite.tags.push(tag);
    sprite.modified = true;
    return;
  }
  if (op !== "update" && op !== "delete") throw new ToolError("unsupported_command", `tag op '${op}' is not supported.`);

  // Two tags may share a name; the extension acted on the last one.
  const target = sprite.tags.findLast((t) => t.name === args.name);
  if (!target) throw new ToolError("invalid_args", `No tag named '${String(args.name)}'.`);
  if (op === "delete") {
    sprite.tags.splice(sprite.tags.indexOf(target), 1);
  } else {
    Object.assign(target, fields(sprite, args, target), args.newName !== undefined ? { name: String(args.newName) } : {});
  }
  sprite.modified = true;
}

function tagApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const op = String(need(args.op, "op"));
  if (op !== "list") apply(sprite, op, args);
  const ms = sprite.frames.map((f) => Math.round(f.durationMs));
  return {
    sprite: displayName(sprite),
    tags: sprite.tags.map((t) => ({
      name: t.name,
      from: t.from,
      to: t.to,
      direction: t.direction,
      frames: t.to - t.from + 1,
      durationMs: ms.slice(t.from - 1, t.to).reduce((a, b) => a + b, 0),
    })),
  };
}

export const tagHandlers: HandlerTable = {
  "tag.apply": tagApply,
};
