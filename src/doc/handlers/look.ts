import { encodePng } from "../../lib/png.js";
import { ToolError } from "../errors.js";
import { Image, TRANSPARENT, displayName, pixelToRgba, rgba, type Layer, type Rect, type Sprite } from "../model.js";
import { over, type HandlerTable, type Studio } from "../studio.js";
import { clampRegion } from "../selection.js";

const PREVIEW_TARGET_EDGE = 1024;
const PREVIEW_MAX_EDGE = 2048;
const GAP = 1;
const GAP_GREY = rgba(64, 64, 72);

/** An integer upscale bounded by the output edge, so a tiny sprite is still shown large enough to read. */
export function pickScale(w: number, h: number, requested?: unknown): number {
  const long = Math.max(w, h, 1);
  const byOutput = Math.max(1, Math.floor(PREVIEW_MAX_EDGE / long));
  if (typeof requested === "number" && requested > 0) return Math.max(1, Math.min(Math.floor(requested), byOutput));
  return Math.min(Math.max(1, Math.floor(PREVIEW_TARGET_EDGE / long + 0.5)), byOutput);
}

function upscale(img: Image, k: number): Image {
  if (k === 1) return img;
  const out = new Image(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) out.pixels[y * out.width + x] = img.pixels[Math.floor(y / k) * img.width + Math.floor(x / k)]!;
  }
  return out;
}

function crop(img: Image, r: Rect): Image {
  const out = new Image(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) out.pixels[y * r.width + x] = img.get(r.x + x, r.y + y);
  }
  return out;
}

/** One layer's cel on an otherwise clear canvas, as RGBA; layer and cel opacity are not applied. */
function celCanvas(sprite: Sprite, layer: Layer, frame: number, celOpacity = false): Image {
  const out = new Image(sprite.width, sprite.height);
  const cel = layer.cels.get(frame);
  if (!cel) return out;
  for (let y = 0; y < cel.image.height; y++) {
    for (let x = 0; x < cel.image.width; x++) {
      const c = pixelToRgba(sprite, cel.image.get(x, y), layer);
      out.set(cel.x + x, cel.y + y, celOpacity ? over(TRANSPARENT, c, cel.opacity) : c);
    }
  }
  return out;
}

/** The frame as one RGBA image: the composite, or one named layer's cel. */
function frameImage(studio: Studio, sprite: Sprite, frame: number, layerName: unknown): Image {
  if (layerName === undefined) return studio.composite(sprite, frame);
  return celCanvas(sprite, studio.resolveLayer(sprite, layerName), frame);
}

/** Draws `src` onto `dst` at (dx, dy): source-over, or a straight copy when `replace`. */
function paste(dst: Image, src: Image, dx: number, dy: number, opts: { opacity?: number; replace?: boolean } = {}): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (!dst.contains(dx + x, dy + y)) continue;
      const i = (dy + y) * dst.width + dx + x;
      const c = src.pixels[y * src.width + x]!;
      dst.pixels[i] = opts.replace ? c : over(dst.pixels[i]!, c, opts.opacity ?? 255);
    }
  }
}

function rendered(img: Image, scale: number) {
  return { png: encodePng(upscale(img, scale)), width: img.width * scale, height: img.height * scale, scale };
}

function preview(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const frame = studio.resolveFrame(sprite, args.frame);
  const region = clampRegion(sprite, args.region);
  const image = crop(frameImage(studio, sprite, frame, args.layer), region);
  const out = rendered(image, pickScale(region.width, region.height, args.scale));
  return { sprite: displayName(sprite), sourceWidth: region.width, sourceHeight: region.height, ...out };
}

function filmstrip(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const count = sprite.frames.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = sprite.width + GAP;
  const cellH = sprite.height + GAP;
  const strip = new Image(cols * cellW - GAP, rows * cellH - GAP, GAP_GREY);
  for (let i = 0; i < count; i++) {
    paste(strip, frameImage(studio, sprite, i + 1, args.layer), (i % cols) * cellW, Math.floor(i / cols) * cellH);
  }
  const out = rendered(strip, pickScale(strip.width, strip.height, args.scale));
  return { sprite: displayName(sprite), frames: count, ...out };
}

function rangeArg(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const n = value === undefined ? fallback : Number(value);
  if (!(n >= min && n <= max)) throw new ToolError("invalid_args", `${name} must be between ${min} and ${max}.`);
  return n;
}

function onion(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const target = studio.resolveFrame(sprite, args.frame);
  const before = rangeArg(args.framesBefore, 1, 0, 8, "framesBefore");
  const after = rangeArg(args.framesAfter, 1, 0, 8, "framesAfter");
  const ghostOpacity = rangeArg(args.ghostOpacity, 90, 0, 255, "ghostOpacity");
  const region = clampRegion(sprite, args.region);

  const from = Math.max(1, target - before);
  const to = Math.min(sprite.frames.length, target + after);
  const stack = new Image(sprite.width, sprite.height);
  const used: number[] = [];
  for (let n = from; n <= to; n++) {
    if (n !== target) paste(stack, frameImage(studio, sprite, n, args.layer), 0, 0, { opacity: ghostOpacity });
    used.push(n);
  }
  paste(stack, frameImage(studio, sprite, target, args.layer), 0, 0);

  const out = rendered(crop(stack, region), pickScale(region.width, region.height, args.scale));
  return { sprite: displayName(sprite), frame: target, frames: used, sourceWidth: region.width, sourceHeight: region.height, ...out };
}

function compare(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  const frame = studio.resolveFrame(sprite, args.frame);
  const ref = studio.resolveLayer(sprite, args.reference ?? "reference");
  if (!ref.cels.has(frame)) {
    throw new ToolError(
      "invalid_args",
      `'${ref.name}' has no cel on frame ${frame}. Import one there with reference op 'import' and \`frame\`, or a whole sheet with \`grid\`.`,
    );
  }
  const region = clampRegion(sprite, args.region);
  const { width: w, height: h } = region;

  // The reference at full opacity: it is kept see-through for tracing, which would wash it out here.
  const left = crop(celCanvas(sprite, ref, frame, true), region);
  const art = studio.composite(sprite, frame, {
    layers: sprite.layers.filter((l) => l !== ref && !l.reference),
  });
  const right = crop(art, region);

  const strip = new Image(w * 2 + GAP, h, GAP_GREY);
  paste(strip, left, 0, 0, { replace: true });
  paste(strip, right, w + GAP, 0, { replace: true });

  const out = rendered(strip, pickScale(strip.width, h, args.scale));
  return { sprite: displayName(sprite), frame, reference: ref.name, sourceWidth: w, sourceHeight: h, ...out };
}

export const lookHandlers: HandlerTable = {
  "look.preview": preview,
  "look.filmstrip": filmstrip,
  "look.onion": onion,
  "look.compare": compare,
};
