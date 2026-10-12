import { ToolError, need } from "../errors.js";
import { displayName, type Cel, type Layer, type Sprite } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

const EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  ease_in: (t) => t * t,
  ease_out: (t) => 1 - (1 - t) * (1 - t),
  ease_in_out: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  smoothstep: (t) => t * t * (3 - 2 * t),
};

type Touched = { frame: number; x?: number; y?: number; opacity?: number };

function list(sprite: Sprite) {
  const cels = sprite.layers.flatMap((layer) =>
    [...layer.cels]
      .sort(([a], [b]) => a - b)
      .map(([frame, c]) => ({
        layer: layer.name,
        frame,
        x: c.x,
        y: c.y,
        width: c.image.width,
        height: c.image.height,
        opacity: c.opacity,
      })),
  );
  return { sprite: displayName(sprite), cels };
}

function opacityArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new ToolError("invalid_args", `opacity must be an integer from 0 to 255, got ${String(value)}.`);
  }
  return value;
}

function intArg(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolError("invalid_args", `${name} must be an integer, got ${String(value)}.`);
  }
  return value;
}

function noCel(layer: Layer, frame: number, why = ""): ToolError {
  return new ToolError("invalid_args", `No cel on '${layer.name}' frame ${frame}${why}.`);
}

/** The frame span tween and oscillate fill in, start cel and all. */
function span(studio: Studio, sprite: Sprite, layer: Layer, args: Record<string, unknown>, op: string) {
  const from = studio.resolveFrame(sprite, need(args.fromFrame, "fromFrame"));
  const to = studio.resolveFrame(sprite, need(args.toFrame, "toFrame"));
  if (to <= from) throw new ToolError("invalid_args", `cel op '${op}' needs toFrame > fromFrame.`);
  const base = layer.cels.get(from);
  if (!base) throw noCel(layer, from, ` to ${op} from`);
  return { from, to, base };
}

/** The cel at `frame`, or a copy of `base` put there. */
function celOrCopy(layer: Layer, frame: number, base: Cel): Cel {
  let cel = layer.cels.get(frame);
  if (!cel) {
    cel = { ...base, image: base.image.clone() };
    layer.cels.set(frame, cel);
  }
  return cel;
}

function tween(studio: Studio, sprite: Sprite, layer: Layer, args: Record<string, unknown>): Touched[] {
  const { from, to, base } = span(studio, sprite, layer, args, "tween");
  const property = need(args.property, "property");
  if (property !== "position" && property !== "opacity") {
    throw new ToolError("invalid_args", "cel op 'tween' property must be 'position' or 'opacity'.");
  }
  const end = need(args.to, "to");
  const easing = String(args.easing ?? "linear");
  const ease = EASINGS[easing];
  if (!ease) throw new ToolError("invalid_args", `Unknown easing '${easing}'.`);

  let endX = 0;
  let endY = 0;
  let endOpacity = 0;
  if (property === "position") {
    const p = end as { x?: unknown; y?: unknown };
    endX = intArg(p.x, "to.x");
    endY = intArg(p.y, "to.y");
  } else {
    endOpacity = opacityArg(end);
  }

  const start = { x: base.x, y: base.y, opacity: base.opacity };
  const touched: Touched[] = [];
  for (let fn = from; fn <= to; fn++) {
    const cel = celOrCopy(layer, fn, base);
    const t = ease((fn - from) / (to - from));
    const lerp = (a: number, b: number) => (fn === from ? a : fn === to ? b : Math.floor(a + (b - a) * t + 0.5));
    if (property === "position") {
      cel.x = lerp(start.x, endX);
      cel.y = lerp(start.y, endY);
      touched.push({ frame: fn, x: cel.x, y: cel.y });
    } else {
      cel.opacity = lerp(start.opacity, endOpacity);
      touched.push({ frame: fn, opacity: cel.opacity });
    }
  }
  return touched;
}

function oscillate(studio: Studio, sprite: Sprite, layer: Layer, args: Record<string, unknown>): Touched[] {
  const { from, to, base } = span(studio, sprite, layer, args, "oscillate");
  const ampX = args.amplitudeX === undefined ? 0 : intArg(args.amplitudeX, "amplitudeX");
  const ampY = args.amplitudeY === undefined ? 0 : intArg(args.amplitudeY, "amplitudeY");
  const period = args.period === undefined ? to - from + 1 : Number(args.period);
  if (!(period >= 2)) throw new ToolError("invalid_args", "cel op 'oscillate' period must be >= 2.");
  const phase = args.phase === undefined ? 0 : Number(args.phase);
  const { x: baseX, y: baseY } = base;

  const touched: Touched[] = [];
  for (let fn = from; fn <= to; fn++) {
    const wave = Math.sin(2 * Math.PI * ((fn - from) / period + phase));
    const cel = celOrCopy(layer, fn, base);
    cel.x = baseX + Math.floor(ampX * wave + 0.5);
    cel.y = baseY + Math.floor(ampY * wave + 0.5);
    touched.push({ frame: fn, x: cel.x, y: cel.y });
  }
  return touched;
}

function celApply(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const op = String(need(args.op, "op"));
  if (op === "list") return list(sprite);

  const layer = studio.resolveLayer(sprite, args.layer);
  const frame = studio.resolveFrame(sprite, args.frame);
  let applied = 0;
  let frames: Touched[] | undefined;

  switch (op) {
    case "create":
      studio.ensureCel(sprite, layer, frame);
      applied = 1;
      break;
    case "clear": {
      const cel = layer.cels.get(frame);
      if (cel) {
        cel.image = studio.newImage(sprite, cel.image.width, cel.image.height);
        applied = 1;
      }
      break;
    }
    case "delete":
      if (layer.cels.delete(frame)) applied = 1;
      break;
    case "set":
    case "move": {
      const cel = layer.cels.get(frame);
      if (!cel) throw noCel(layer, frame);
      const x = args.x !== undefined ? intArg(args.x, "x") : cel.x + (args.dx === undefined ? 0 : intArg(args.dx, "dx"));
      const y = args.y !== undefined ? intArg(args.y, "y") : cel.y + (args.dy === undefined ? 0 : intArg(args.dy, "dy"));
      const opacity = args.opacity !== undefined ? opacityArg(args.opacity) : cel.opacity;
      Object.assign(cel, { x, y, opacity });
      applied = 1;
      break;
    }
    case "copy": {
      const src = layer.cels.get(frame);
      if (!src) throw new ToolError("invalid_args", "Nothing to copy from.");
      const dstLayer = args.toLayer !== undefined ? studio.resolveLayer(sprite, args.toLayer) : layer;
      const dstFrame = args.toFrame !== undefined ? studio.resolveFrame(sprite, args.toFrame) : frame;
      dstLayer.cels.set(dstFrame, { x: src.x, y: src.y, image: src.image.clone(), opacity: 255 });
      applied = 1;
      break;
    }
    case "tween":
      frames = tween(studio, sprite, layer, args);
      applied = frames.length;
      break;
    case "oscillate":
      frames = oscillate(studio, sprite, layer, args);
      applied = frames.length;
      break;
    default:
      throw new ToolError("unsupported_command", `cel op '${op}' is not supported.`);
  }
  if (applied > 0) sprite.modified = true;
  return { sprite: displayName(sprite), applied, frames };
}

export const celHandlers: HandlerTable = {
  "cel.apply": celApply,
};
