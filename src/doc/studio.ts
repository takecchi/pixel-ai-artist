/**
 * Where documents live, and the one entry point every tool calls.
 *
 * Tools call `studio.call(cmd, args)` with the command names the Aseprite
 * extension used to answer; each name is a `Handler` in `./handlers/`.
 * Handlers share the resolution and compositing helpers here, so "which
 * sprite / layer / frame did the agent mean" is decided in one place, the way
 * the extension's find_sprite / find_layer / find_frame decided it.
 */

import { ToolError } from "./errors.js";
import {
  Image,
  channels,
  displayName,
  pixelToRgba,
  rgba,
  transparentPixel,
  type Cel,
  type ColorMode,
  type Layer,
  type Rect,
  type Rgba,
  type Sprite,
} from "./model.js";

export const COMMAND_NAMES = [
  "session.site",
  "sprite.info",
  "sprite.manage",
  "pixels.read",
  "look.preview",
  "look.filmstrip",
  "look.onion",
  "look.compare",
  "draw.batch",
  "select.apply",
  "transform.apply",
  "recolor.apply",
  "validate.run",
  "layer.apply",
  "frame.apply",
  "tag.apply",
  "cel.apply",
  "palette.get",
  "palette.set",
  "palette.load",
  "palette.stats",
  "palette.extract",
  "reference.apply",
  "export.run",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/**
 * Answers one command. Fields the Lua handler left nil are `undefined` here,
 * so they vanish from the tool result exactly as they did from its JSON.
 */
export type Handler = (studio: Studio, args: Record<string, unknown>) => unknown;

export type HandlerTable = Partial<Record<CommandName, Handler>>;

export interface CallOptions {
  /** Reply fields the caller goes on to read; a reply without one is an `internal_error`. */
  expect?: readonly string[];
}

export interface NewSpriteOptions {
  width: number;
  height: number;
  colorMode?: ColorMode;
  filename?: string | null;
  palette?: Rgba[];
}

export class Studio {
  private readonly docs = new Map<number, Sprite>();
  private activeId: number | null = null;
  private nextId = 1;

  constructor(private readonly handlers: HandlerTable) {}

  // ── commands ───────────────────────────────────────────────────────────

  async call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const handler = (COMMAND_NAMES as readonly string[]).includes(cmd)
      ? this.handlers[cmd as CommandName]
      : undefined;
    if (!handler) {
      throw new ToolError("unsupported_command", `'${cmd}' is not supported.`, { command: cmd });
    }
    let value: unknown;
    try {
      value = await handler(this, stripUndefined(args));
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError("internal_error", `'${cmd}' failed: ${err instanceof Error ? err.message : String(err)}`, {
        command: cmd,
      });
    }
    const missing = missingFields(value, opts.expect ?? []);
    if (missing.length > 0) {
      throw new ToolError("internal_error", `'${cmd}' answered without ${missing.join(", ")}.`, { command: cmd, missing });
    }
    return value as T;
  }

  // ── documents ──────────────────────────────────────────────────────────

  sprites(): Sprite[] {
    return [...this.docs.values()];
  }

  activeSprite(): Sprite | null {
    return this.activeId === null ? null : (this.docs.get(this.activeId) ?? null);
  }

  /** Creates a sprite with one empty layer and one frame, and makes it active. */
  addSprite(opts: NewSpriteOptions): Sprite {
    const id = this.nextId++;
    const sprite: Sprite = {
      id,
      filename: opts.filename ?? null,
      width: opts.width,
      height: opts.height,
      colorMode: opts.colorMode ?? "rgb",
      transparentIndex: 0,
      palette: opts.palette ?? [],
      layers: [],
      frames: [{ durationMs: 100 }],
      tags: [],
      selection: null,
      pixelRatio: { w: 1, h: 1 },
      modified: false,
      activeLayerId: null,
      activeFrame: 1,
      nextLayerId: 1,
    };
    this.addLayer(sprite, "Layer 1");
    sprite.modified = false;
    this.docs.set(id, sprite);
    this.activeId = id;
    return sprite;
  }

  activate(sprite: Sprite): void {
    this.activeId = sprite.id;
  }

  closeSprite(sprite: Sprite): void {
    this.docs.delete(sprite.id);
    if (this.activeId === sprite.id) this.activeId = this.sprites().at(-1)?.id ?? null;
  }

  /**
   * '#7' or 7 (the id every result reports), a filename, or a display name;
   * omitted means the active sprite. A name two documents share is refused
   * rather than guessed — fresh documents are all called "Sprite".
   */
  resolveSprite(ref?: unknown): Sprite {
    if (ref === undefined || ref === null || ref === "") {
      const active = this.activeSprite();
      if (!active) throw new ToolError("no_active_sprite", "No sprite is open.");
      return active;
    }
    const name = String(ref);
    const byId = /^#?(\d+)$/.exec(name);
    if (byId) {
      const sprite = this.docs.get(Number(byId[1]));
      if (sprite) return sprite;
    }
    const matches = this.sprites().filter((s) => s.filename === name || displayName(s) === name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const ids = matches.map((s) => `#${s.id}`);
      throw new ToolError(
        "invalid_args",
        `'${name}' matches ${matches.length} open sprites (${ids.join(", ")}). Pass one of those ids instead.`,
      );
    }
    const open = this.sprites().map((s) => `${displayName(s)} (#${s.id})`);
    throw new ToolError(
      "invalid_args",
      `No open sprite matches '${name}'. Open: ${open.length > 0 ? open.join(", ") : "(none)"}.`,
    );
  }

  // ── layers, frames, cels ───────────────────────────────────────────────

  /** Adds a layer on top and makes it active. */
  addLayer(sprite: Sprite, name: string): Layer {
    const layer: Layer = { id: sprite.nextLayerId++, name, visible: true, editable: true, opacity: 255, cels: new Map() };
    sprite.layers.push(layer);
    sprite.activeLayerId = layer.id;
    sprite.modified = true;
    return layer;
  }

  /** By name; omitted means the sprite's active layer, else the top one. */
  resolveLayer(sprite: Sprite, name?: unknown): Layer {
    if (name === undefined || name === null || name === "") {
      const active = sprite.layers.find((l) => l.id === sprite.activeLayerId) ?? sprite.layers.at(-1);
      if (!active) throw new ToolError("invalid_args", "Sprite has no layers.");
      return active;
    }
    const matches = sprite.layers.filter((l) => l.name === name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new ToolError("invalid_args", `Layer name '${String(name)}' is ambiguous: ${matches.length} layers share it.`);
    }
    throw new ToolError("invalid_args", `No layer named '${String(name)}'.`);
  }

  /** 1-based; omitted means the sprite's active frame. */
  resolveFrame(sprite: Sprite, frame?: unknown): number {
    if (frame === undefined || frame === null) return sprite.activeFrame;
    const n = Math.floor(Number(frame));
    if (!(n >= 1 && n <= sprite.frames.length)) {
      throw new ToolError("invalid_args", `Frame ${n} is out of range (1..${sprite.frames.length}).`);
    }
    return n;
  }

  /** A canvas-sized-or-smaller image filled with the sprite's "no paint" value. */
  newImage(sprite: Sprite, width = sprite.width, height = sprite.height): Image {
    return new Image(width, height, transparentPixel(sprite));
  }

  /**
   * The cel on `layer` at `frame`, created (covering the whole canvas) or grown
   * so its image covers `area`. Growth is clamped to the canvas — pixels off
   * it are invisible and Aseprite trims them — and existing pixels keep their
   * canvas position.
   */
  ensureCel(sprite: Sprite, layer: Layer, frame: number, area?: Rect): Cel {
    let cel = layer.cels.get(frame);
    if (!cel) {
      cel = { x: 0, y: 0, image: this.newImage(sprite), opacity: 255 };
      layer.cels.set(frame, cel);
    }
    if (!area) return cel;
    const x0 = Math.max(0, Math.min(cel.x, area.x));
    const y0 = Math.max(0, Math.min(cel.y, area.y));
    const x1 = Math.min(sprite.width, Math.max(cel.x + cel.image.width, area.x + area.width));
    const y1 = Math.min(sprite.height, Math.max(cel.y + cel.image.height, area.y + area.height));
    if (x1 <= x0 || y1 <= y0) return cel;
    if (x0 === cel.x && y0 === cel.y && x1 - x0 === cel.image.width && y1 - y0 === cel.image.height) return cel;
    const grown = this.newImage(sprite, x1 - x0, y1 - y0);
    blit(grown, cel.image, cel.x - x0, cel.y - y0);
    cel.x = x0;
    cel.y = y0;
    cel.image = grown;
    return cel;
  }

  /**
   * The canvas as it looks at `frame`, as RGBA whatever the colour mode:
   * visible layers bottom to top, each at its layer × cel opacity,
   * source-over. `layers` restricts which layers take part (visibility still
   * applies unless `includeHidden`).
   */
  composite(sprite: Sprite, frame: number, opts: { layers?: readonly Layer[]; includeHidden?: boolean } = {}): Image {
    const out = new Image(sprite.width, sprite.height);
    const only = opts.layers ? new Set(opts.layers.map((l) => l.id)) : null;
    // Aseprite draws Background layers first, wherever they sit in the stack.
    const order = [...sprite.layers.filter((l) => l.background), ...sprite.layers.filter((l) => !l.background)];
    for (const layer of order) {
      if (only && !only.has(layer.id)) continue;
      if (!layer.visible && !opts.includeHidden) continue;
      const cel = layer.cels.get(frame);
      if (!cel) continue;
      const opacity = Math.round((layer.opacity * cel.opacity) / 255);
      for (let y = 0; y < cel.image.height; y++) {
        for (let x = 0; x < cel.image.width; x++) {
          const tx = cel.x + x;
          const ty = cel.y + y;
          if (!out.contains(tx, ty)) continue;
          const i = ty * out.width + tx;
          out.pixels[i] = over(out.pixels[i]!, pixelToRgba(sprite, cel.image.pixels[y * cel.image.width + x]!, layer), opacity);
        }
      }
    }
    return out;
  }
}

/** Copies `src` into `dst` at (dx, dy), replacing pixels, clipped to `dst`. */
export function blit(dst: Image, src: Image, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) dst.set(dx + x, dy + y, src.pixels[y * src.width + x]!);
  }
}

/** Source-over of RGBA `above` onto RGBA `below`, with `above` further faded by `opacity` 0–255. */
export function over(below: Rgba, above: Rgba, opacity = 255): Rgba {
  const [ar, ag, ab, aa0] = channels(above);
  const aa = (aa0 * opacity) / 255;
  if (aa <= 0) return below;
  if (aa >= 255) return above;
  const [br, bg, bb, ba] = channels(below);
  const a = aa + (ba * (255 - aa)) / 255;
  const mix = (s: number, d: number) => Math.round((s * aa + (d * ba * (255 - aa)) / 255) / a);
  return rgba(mix(ar, br), mix(ag, bg), mix(ab, bb), Math.round(a));
}

/**
 * Fields a caller declared it would read (`expect`) that the reply lacks.
 * `undefined` is absent, as nil was in the extension's JSON; `null` is an
 * answer.
 */
export function missingFields(value: unknown, expect: readonly string[]): string[] {
  if (expect.length === 0) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [...expect];
  return expect.filter((field) => (value as Record<string, unknown>)[field] === undefined);
}

/** zod leaves optional fields as explicit `undefined`; handlers test with `in`. */
function stripUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}
