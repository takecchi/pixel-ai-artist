import { displayName, isOpaque, pixelToHex, rgbaToHex, type Image, type Layer, type Sprite } from "../model.js";
import { paletteStats } from "../stats.js";
import type { HandlerTable, Studio } from "../studio.js";

type Severity = "error" | "warning" | "note";

interface Finding {
  check: string;
  severity: Severity;
  message: string;
  layer?: string;
  frame?: number;
  at?: { x: number; y: number };
  count?: number;
}

const ALL_CHECKS = ["palette", "strays", "outline", "banding", "antialiasing", "layers", "animation", "export_readiness"];
const FOUR: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const EIGHT: readonly (readonly [number, number])[] = [...FOUR, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Fields the Lua left nil are absent, not undefined, so a result compares equal to the plain object it is. */
function finding(
  list: Finding[],
  check: string,
  severity: Severity,
  message: string,
  extra: Partial<Pick<Finding, "layer" | "frame" | "at" | "count">> = {},
): void {
  const present = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  list.push({ check, severity, message, ...present });
}

function cellIsEmpty(image: Image, sprite: Sprite, layer: Layer): boolean {
  return !image.pixels.some((v) => isOpaque(sprite, v, layer));
}

const GAPS_NAMED = 5;

/**
 * The outline as the frame shows it: visible layers composited, references
 * left out. Checked per layer, the extension took a rigged body's edge against
 * its arm layer for silhouette, and any edge colour but the commonest for a
 * gap, which flagged selective and coloured outlines too. A gap here is an
 * edge pixel whose colour carries on inward — the fill reaching the
 * background through the outline. An edge pixel in a colour of its own is a
 * different stretch of outline, not a hole. Shapes are judged apart: one with
 * none of the outline colour on its edge — a spark, a glow, a particle — is
 * meant to have no outline (rules://80-vfx-fire-smoke-magic), so it is left out.
 */
function outlineFindings(studio: Studio, sprite: Sprite, frame: number, findings: Finding[]): void {
  const img = studio.composite(sprite, frame, { layers: sprite.layers.filter((l) => !l.reference) });
  const hexAt = (x: number, y: number): string | null => {
    if (!img.contains(x, y)) return null;
    const c = img.get(x, y);
    return (c & 255) === 0 ? null : rgbaToHex(c, sprite.colorMode === "rgb");
  };
  const isEdge = (x: number, y: number) => FOUR.some(([dx, dy]) => hexAt(x + dx, y + dy) === null);

  // Shapes join on diagonals too, so an outline stepped one pixel at a time stays one shape.
  const shapeOf = new Int32Array(img.width * img.height).fill(-1);
  let shapes = 0;
  for (let i = 0; i < shapeOf.length; i++) {
    if (shapeOf[i] !== -1 || hexAt(i % img.width, Math.floor(i / img.width)) === null) continue;
    const stack = [i];
    shapeOf[i] = shapes;
    while (stack.length > 0) {
      const at = stack.pop()!;
      const [x, y] = [at % img.width, Math.floor(at / img.width)];
      for (const [dx, dy] of EIGHT) {
        const j = (y + dy) * img.width + x + dx;
        if (hexAt(x + dx, y + dy) === null || shapeOf[j] !== -1) continue;
        shapeOf[j] = shapes;
        stack.push(j);
      }
    }
    shapes++;
  }

  const all: { x: number; y: number; hex: string; shape: number }[] = [];
  const counts = new Map<string, number>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const hex = hexAt(x, y);
      if (hex === null || !isEdge(x, y)) continue;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
      all.push({ x, y, hex, shape: shapeOf[y * img.width + x]! });
    }
  }
  if (all.length === 0) return;

  let best = "";
  let bestN = 0;
  for (const [hex, n] of counts) {
    if (n > bestN) [best, bestN] = [hex, n];
  }
  const outlined = new Set(all.filter((e) => e.hex === best).map((e) => e.shape));
  const edge = all.filter((e) => outlined.has(e.shape));
  const share = bestN / edge.length;
  if (share < 0.6) {
    finding(
      findings,
      "outline",
      "note",
      `No single colour owns the silhouette edge on frame ${frame}, so this sprite is not outlined. That is a valid style — just keep it consistent.`,
      { frame },
    );
    return;
  }

  const gaps = edge.filter(
    (e) => e.hex !== best && FOUR.some(([dx, dy]) => hexAt(e.x + dx, e.y + dy) === e.hex && !isEdge(e.x + dx, e.y + dy)),
  );
  if (gaps.length === 0) return;
  const named = gaps.slice(0, GAPS_NAMED).map((g) => `(${g.x},${g.y})`).join(", ");
  const more = gaps.length > GAPS_NAMED ? ` and ${gaps.length - GAPS_NAMED} more` : "";
  finding(
    findings,
    "outline",
    "warning",
    `Outline is ${Math.floor(share * 100 + 0.5)}% '${best}' on frame ${frame}, but the fill runs out through it at ${gaps.length} edge pixel(s): ${named}${more}. ` +
      "A broken outline reads as a hole in the silhouette.",
    { frame, at: { x: gaps[0]!.x, y: gaps[0]!.y }, count: gaps.length },
  );
}

function validateRun(studio: Studio, args: Record<string, unknown>) {
  const sprite = studio.resolveSprite(args.sprite);
  // The default is every check the schema offers: "omit to run everything"
  // that quietly skips one is a check the agent believes it ran.
  const wanted = new Set<string>((args.checks as string[] | undefined) ?? ALL_CHECKS);

  const findings: Finding[] = [];

  if (wanted.has("palette")) {
    const stats = paletteStats(sprite);
    if (stats.offPalette.length > 0) {
      const worst = stats.offPalette[0]!;
      finding(
        findings,
        "palette",
        "warning",
        `${stats.offPalette.length} colour(s) in the art are not in the palette; the most used is ` +
          `${worst.hex} (${worst.pixels}px). Run recolor op 'snap' to bring them in line.`,
        { count: stats.offPalette.length },
      );
    }
    if (stats.colors.length > 64) {
      finding(
        findings,
        "palette",
        "note",
        `${stats.colors.length} palette entries. Most sprites read better under 32 — a large palette usually means ramps that were never merged.`,
        { count: stats.colors.length },
      );
    }
  }

  // Hidden layers are skipped by the per-pixel scans, the way outline and
  // banding already skipped them: a finding about pixels that do not reach the
  // export is noise, and a document that keeps its earlier drafts around as
  // hidden layers is mostly hidden.
  let hiddenSkipped = 0;

  for (const layer of sprite.layers) {
    if (wanted.has("layers") && layer.cels.size === 0) {
      finding(findings, "layers", "note", `Layer '${layer.name}' has no cels on any frame.`, { layer: layer.name });
    }

    if (!layer.visible) hiddenSkipped++;

    for (const frame of [...layer.cels.keys()].sort((a, b) => a - b)) {
      const cel = layer.cels.get(frame)!;
      const img = cel.image;

      if (wanted.has("strays") && layer.visible) {
        // A lone opaque pixel with no opaque neighbour is nearly always a
        // misplaced click or an off-by-one in generated coordinates.
        let strays = 0;
        let first: { x: number; y: number } | undefined;
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            if (!isOpaque(sprite, img.get(x, y), layer)) continue;
            const neighbours = FOUR.filter(
              ([dx, dy]) => img.contains(x + dx, y + dy) && isOpaque(sprite, img.get(x + dx, y + dy), layer),
            ).length;
            if (neighbours === 0) {
              strays++;
              first ??= { x: x + cel.x, y: y + cel.y };
            }
          }
        }
        if (strays > 0) {
          finding(
            findings,
            "strays",
            strays > 3 ? "error" : "warning",
            `${strays} isolated pixel(s) with no neighbour on '${layer.name}' frame ${frame}. These read as noise at 1x.`,
            { layer: layer.name, frame, at: first, count: strays },
          );
        }
      }

      if (wanted.has("antialiasing") && layer.visible && sprite.colorMode !== "indexed") {
        // The alpha is the low byte in grayscale too. The extension read it
        // through the RGBA accessor, which finds nothing in a gray+alpha pixel,
        // so grayscale sprites never reported here.
        // Faded by layer × cel opacity as the composite fades it: an opaque
        // pixel on a cel at 142 shows half-transparent all the same.
        const opacity = Math.round((layer.opacity * cel.opacity) / 255);
        let semi = 0;
        for (const v of img.pixels) {
          const a = ((v & 255) * opacity) / 255;
          if (a > 0 && a < 255) semi++;
        }
        if (semi > 0) {
          const why =
            opacity < 255
              ? ` frame ${frame}: layer × cel opacity is ${opacity}/255, so they show partly transparent, and a GIF rounds them to opaque or clear. Fade with opaque palette colours, or set the opacity to 255.`
              : ". Partial alpha usually comes from a soft brush or a resize and reads as blur.";
          finding(
            findings,
            "antialiasing",
            "warning",
            `${semi} semi-transparent pixel(s) on '${layer.name}'${why}`,
            { layer: layer.name, frame, count: semi },
          );
        }
      }
    }
  }

  if (wanted.has("outline")) {
    for (let frame = 1; frame <= sprite.frames.length; frame++) outlineFindings(studio, sprite, frame, findings);
  }

  if (wanted.has("banding")) {
    for (const layer of sprite.layers) {
      if (!layer.visible) continue;
      for (const frame of [...layer.cels.keys()].sort((a, b) => a - b)) {
        const cel = layer.cels.get(frame)!;
        const img = cel.image;

        // Banding is a long straight boundary between two colours: the eye
        // reads it as a contour line instead of a curved surface.
        const threshold = Math.max(8, Math.floor(img.width / 3));
        let worst = 0;
        let worstAt: { x: number; y: number } | undefined;
        let worstPair: [string, string] | undefined;
        for (let y = 0; y < img.height - 1; y++) {
          let run = 0;
          let above: string | null = null;
          let below: string | null = null;
          let runX = 0;
          for (let x = 0; x < img.width; x++) {
            const a = pixelToHex(sprite, img.get(x, y), layer);
            const b = pixelToHex(sprite, img.get(x, y + 1), layer);
            if (a !== null && b !== null && a !== b && a === above && b === below) {
              run++;
            } else {
              above = a;
              below = b;
              run = a !== null && b !== null && a !== b ? 1 : 0;
              runX = x;
            }
            if (run > worst) {
              worst = run;
              worstAt = { x: runX + cel.x, y: y + cel.y };
              worstPair = [above!, below!];
            }
          }
        }
        if (worst >= threshold && worstPair) {
          finding(
            findings,
            "banding",
            "note",
            `A ${worst}-pixel straight boundary between ${worstPair[0]} and ${worstPair[1]} on '${layer.name}'. ` +
              "Let the edge wander, or dither part of it, so it reads as a surface rather than a contour line.",
            { layer: layer.name, frame, at: worstAt, count: worst },
          );
        }
      }
    }
  }

  if (wanted.has("animation") && sprite.frames.length > 1) {
    if (sprite.tags.length === 0) {
      finding(
        findings,
        "animation",
        "error",
        `${sprite.frames.length} frames and no animation tags. An engine cannot address untagged frames — add a tag per cycle.`,
        { count: sprite.frames.length },
      );
    }
    const durations = new Set(sprite.frames.map((f) => Math.floor(f.durationMs + 0.5)));
    if (durations.size === 1 && sprite.frames.length > 3) {
      finding(
        findings,
        "animation",
        "note",
        "Every frame has the same duration. Uniform timing reads mechanical; hold contact poses longer than pass poses.",
      );
    }
  }

  if (wanted.has("export_readiness") && (sprite.filename ?? "") === "") {
    finding(
      findings,
      "export_readiness",
      "warning",
      "Sprite has never been saved as a document; files written by export do not count here. " +
        "To keep its layers and tags on disk, save_as an .aseprite file — a .png or .gif keeps only how it looks.",
    );
  }

  // `expect` is orthogonal to `checks`: it names the animation contract the
  // caller already knows (which layer should hold ink on which frames, which
  // pairs must never share a pixel), so it always runs when given, regardless
  // of which named checks were requested.
  const expect = args.expect as
    | { layerFrames?: Record<string, [number, number][]>; mustNotOverlap?: [string, string][] }
    | undefined;
  if (expect) {
    for (const [layerName, ranges] of Object.entries(expect.layerFrames ?? {})) {
      const layer = studio.resolveLayer(sprite, layerName);
      const inRange = new Set<number>();
      for (const r of ranges) {
        for (let f = r[0]; f <= r[1]; f++) inRange.add(f);
      }
      for (let fn = 1; fn <= sprite.frames.length; fn++) {
        const cel = layer.cels.get(fn);
        const nonEmpty = cel !== undefined && !cellIsEmpty(cel.image, sprite, layer);
        if (inRange.has(fn)) {
          if (!nonEmpty) {
            finding(
              findings,
              "animation",
              "warning",
              `Layer '${layerName}' expected art on frame ${fn} but the cel is missing or empty.`,
              { layer: layerName, frame: fn },
            );
          }
        } else if (nonEmpty) {
          finding(
            findings,
            "animation",
            "warning",
            `Layer '${layerName}' has art on frame ${fn}, outside its expected range(s).`,
            { layer: layerName, frame: fn },
          );
        }
      }
    }

    for (const pair of expect.mustNotOverlap ?? []) {
      const la = studio.resolveLayer(sprite, pair[0]);
      const lb = studio.resolveLayer(sprite, pair[1]);
      for (let fn = 1; fn <= sprite.frames.length; fn++) {
        const celA = la.cels.get(fn);
        const celB = lb.cels.get(fn);
        if (!celA || !celB) continue;
        const ox0 = Math.max(celA.x, celB.x);
        const oy0 = Math.max(celA.y, celB.y);
        const ox1 = Math.min(celA.x + celA.image.width, celB.x + celB.image.width);
        const oy1 = Math.min(celA.y + celA.image.height, celB.y + celB.image.height);
        let at: { x: number; y: number } | undefined;
        for (let y = oy0; y < oy1 && !at; y++) {
          for (let x = ox0; x < ox1; x++) {
            if (
              isOpaque(sprite, celA.image.get(x - celA.x, y - celA.y), la) &&
              isOpaque(sprite, celB.image.get(x - celB.x, y - celB.y), lb)
            ) {
              at = { x, y };
              break;
            }
          }
        }
        if (at) {
          finding(
            findings,
            "layers",
            "error",
            `Layers '${pair[0]}' and '${pair[1]}' have overlapping opaque pixels on frame ${fn}.`,
            { at, frame: fn },
          );
        }
      }
    }
  }

  // Say what was not looked at, rather than letting a clean result imply the
  // whole document was checked.
  const skipsHidden = ["strays", "outline", "banding", "antialiasing"].some((c) => wanted.has(c));
  if (hiddenSkipped > 0 && skipsHidden) {
    finding(
      findings,
      "layers",
      "note",
      `${hiddenSkipped} hidden layer(s) were not scanned for strays, outline, banding or ` +
        "antialiasing — those checks describe what the sprite shows. Make a layer visible to include it.",
      { count: hiddenSkipped },
    );
  }

  return { sprite: displayName(sprite), findings };
}

export const validateHandlers: HandlerTable = {
  "validate.run": validateRun,
};
