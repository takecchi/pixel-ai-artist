import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Studio } from "../doc/index.js";
import { fail, ok, targetShape } from "./kit.js";

const SAMPLED_IN_TEXT = 8;

/** The colours themselves, which the generic summary would fold into a count; the rest stay in `palette`. */
function describeSampled(data: Record<string, unknown>): string {
  const palette = (data.palette as { hex: string; share: number }[] | undefined) ?? [];
  if (palette.length === 0) return `The ${String(data.width)}×${String(data.height)} source is fully transparent; no colours to sample.`;
  const percent = (share: number) => (share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`);
  const shown = palette.slice(0, SAMPLED_IN_TEXT).map((c) => `${c.hex} ${percent(c.share)}`);
  const rest = palette.length - shown.length;
  const more = rest > 0 ? `, … and ${rest} more` : "";
  return `Sampled ${palette.length} colour(s) from the ${String(data.width)}×${String(data.height)} source: ${shown.join(", ")}${more}.`;
}

export function registerAssetTools(server: McpServer, studio: Studio): void {
  server.registerTool(
    "reference",
    {
      title: "Reference image",
      description:
        "Bring an external image into the sprite as a reference layer, so you can trace proportions or sample colours from it. Ops: 'import' (place an image on a locked, semi-transparent layer above the art), 'sample_palette' (read its dominant colours without importing), 'list', 'remove'. " +
        "A concept sheet or storyboard arrives as one image: `region` crops one panel of it, and `grid` cuts it into panels and puts panel i on frame i of a single reference layer, so each animation frame is drawn over its own storyboard panel. " +
        "Importing at a different size uses nearest-neighbour; a reference scaled down to 32×32 is a guide for proportion and pose, never a finished sprite.",
      inputSchema: {
        op: z.enum(["import", "sample_palette", "list", "remove"]),
        sprite: targetShape.sprite,
        frame: targetShape.frame.describe(
          "Import: the frame the image — or the first `grid` panel — lands on. Default: the active frame, or frame 1 with `grid`.",
        ),
        path: z.string().optional().describe("Image file to read."),
        name: z.string().optional().describe("Layer name. Default: 'reference'."),
        region: z
          .object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .optional()
          .describe("Use only this rectangle of the SOURCE image, in its own pixels — one panel of a concept sheet. Applies to 'import' and 'sample_palette'."),
        grid: z
          .object({
            columns: z.number().int().positive(),
            rows: z.number().int().positive(),
            count: z.number().int().positive().optional().describe("Panels actually used, read row-major. Default: columns × rows."),
            gap: z.number().int().min(0).default(0).describe("Source pixels between panels."),
          })
          .optional()
          .describe(
            "Import a storyboard: split the (cropped) source into equal panels and place panel i on frame `frame`+i-1 of one reference layer. The sprite must already have enough frames.",
          ),
        x: z.number().int().default(0),
        y: z.number().int().default(0),
        fit: z
          .enum(["none", "contain", "cover", "stretch"])
          .default("contain")
          .describe("How to size the image (or each panel) against the canvas."),
        opacity: z.number().int().min(0).max(255).default(128),
        colors: z.number().int().min(2).max(64).default(16).describe("For 'sample_palette'."),
      },
      outputSchema: {
        sprite: z.string(),
        op: z.string(),
        layer: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        panels: z.number().int().optional().describe("Import: how many panels were placed."),
        frames: z.array(z.number().int()).optional().describe("Import: the frames that received a reference cel."),
        palette: z
          .array(z.object({ hex: z.string(), share: z.number() }))
          .optional()
          .describe("Dominant colours with their share of the image."),
        references: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await studio.call<Record<string, unknown>>("reference.apply", args);
        return ok(data, args.op === "sample_palette" ? describeSampled(data) : undefined);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "export",
    {
      title: "Export",
      description:
        "Write game-ready files. Ops: 'png' (single frame), 'gif' (animation), 'spritesheet' (packed sheet plus a JSON atlas with per-frame and per-tag data), 'frames' (numbered PNGs), 'aseprite' (a copy of the document as an .aseprite file). " +
        "Spritesheet is what an engine actually consumes: pass `sheetType` and `byTag` to control layout. Exporting does not save the working document — use sprite_manage op 'save' for that. " +
        "Reference layers are not left out: a visible one is drawn into the files like any other layer, so `reference op=\"remove\"` it or hide it first. " +
        "An argument the op does not read is refused unless left at its default: `frame` is for 'png' only, `scale` for every op but 'aseprite', and `sheetType`, `byTag`, `padding`, `trim` and `includeJson` for 'spritesheet' only.",
      inputSchema: {
        op: z.enum(["png", "gif", "spritesheet", "frames", "aseprite"]),
        sprite: targetShape.sprite,
        path: z
          .string()
          .describe(
            "Output file path. For 'frames', a pattern containing {frame}, e.g. 'walk_{frame}.png' — one file per frame, numbered from 0.",
          ),
        frame: targetShape.frame.describe("For 'png': the frame written. Omit for the active frame. The other ops write every frame, or the frames `tags` cover."),
        scale: z.number().int().min(1).max(16).default(1).describe("Integer upscale, nearest-neighbour."),
        sheetType: z
          .enum(["horizontal", "vertical", "rows", "columns", "packed"])
          .default("horizontal")
          .describe(
            "Spritesheet layout. 'packed' places frames whose pictures are identical only once — their atlas entries share one rectangle, as Aseprite's packed sheets do; to cut the sheet as a fixed grid with one cell per frame, use 'rows'.",
          ),
        byTag: z
          .boolean()
          .default(false)
          .describe(
            "Spritesheet: write only the frames that carry a tag, once per tag, so a frame in overlapping tags appears twice (no tags: every frame, as without it). Tags fill separate bands only with sheetType 'rows' or 'columns'; the other layouts keep one run.",
          ),
        padding: z
          .number()
          .int()
          .min(0)
          .max(16)
          .default(0)
          .describe("Spritesheet: transparent pixels added inside each frame on all four sides (0–16), so neighbouring frames sit 2×padding apart; prevents bleed at non-integer zoom. As with Aseprite's inner padding, each atlas `frame` rectangle includes it: the art starts padding pixels in, and `spriteSourceSize`/`sourceSize` leave it out."),
        trim: z.boolean().default(false).describe("Trim transparent margins; the atlas keeps the original offsets."),
        includeJson: z.boolean().default(true).describe("Write a sibling JSON atlas for 'spritesheet'."),
        layers: z
          .array(z.string())
          .optional()
          .describe("Export only these layers, by name. png, gif, frames, spritesheet; 'aseprite' refuses it."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Export only the frames these tags cover. gif, frames, spritesheet; 'png' and 'aseprite' refuse it. An unknown tag is refused."),
      },
      outputSchema: {
        sprite: z.string(),
        op: z.string(),
        files: z.array(z.string()),
        width: z.number().int().optional().describe("The sprite's own width — not the written file's, which scale and spritesheet change."),
        height: z.number().int().optional().describe("The sprite's own height — not the written file's."),
        outputWidth: z
          .number()
          .int()
          .optional()
          .describe("Width of the image written: the sprite's width × scale, or for 'spritesheet' the whole texture."),
        outputHeight: z.number().int().optional().describe("Height of the image written, as outputWidth."),
        scale: z.number().int().optional().describe("The upscale applied. 'aseprite' writes the document unscaled, so 1."),
        frameCount: z.number().int().optional(),
        frame: z.number().int().optional().describe("Which frame a single-frame export wrote. Defaults to the active frame, which is not always the one you drew on."),
        atlas: z.string().nullish().optional(),
        adjustedDurations: z
          .array(z.object({ frame: z.number().int(), from: z.number(), to: z.number().int() }))
          .optional()
          .describe("Op 'aseprite': frame durations brought into the format's 1..65535 ms."),
        adjustedBackgroundOpacity: z
          .array(z.object({ layer: z.string(), from: z.number().int(), to: z.literal(255) }))
          .optional()
          .describe("Op 'aseprite': Background layers whose opacity was written as 255, because Aseprite ignores a Background's opacity when it reads the file."),
        alphaDropped: z
          .number()
          .int()
          .optional()
          .describe("Ops 'gif' and 'frames': pixels written opaque with their colour kept, because a visible Background leaves PNG and GIF with no transparency (as Aseprite's PNG saver drops alpha). A Background below 255 opacity and holes in it come out solid."),
        alphaRounded: z
          .number()
          .int()
          .optional()
          .describe("Op 'gif', and 'png' or 'frames' to a .gif path: pixels of partial alpha (a soft edge, or a layer or cel below 255 opacity) written fully opaque or fully clear, because GIF transparency is on or off; counted once per frame."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await studio.call<Record<string, unknown>>("export.run", args, {
          expect: ["files"],
        });
        const files = (data.files as string[]) ?? [];
        const durations = ((data.adjustedDurations as unknown[] | undefined) ?? []).length > 0 ? " Some frame durations were brought into 1..65535 ms (adjustedDurations)." : "";
        const background = (data.adjustedBackgroundOpacity as { layer: string; from: number }[] | undefined) ?? [];
        const backgrounds = background.length > 0 ? ` Background opacity was written as 255 (Aseprite ignores it): ${background.map((b) => `'${b.layer}' ${b.from}`).join(", ")} (adjustedBackgroundOpacity).` : "";
        const dropped = typeof data.alphaDropped === "number" ? ` ${data.alphaDropped} pixel(s) written opaque because a visible Background leaves the file no transparency (alphaDropped).` : "";
        const rounded = typeof data.alphaRounded === "number" ? ` ${data.alphaRounded} pixel(s) of partial alpha written fully opaque or fully clear, because GIF transparency is on or off (alphaRounded).` : "";
        const size = typeof data.outputWidth === "number" ? ` Image ${data.outputWidth}×${String(data.outputHeight)} (scale ${String(data.scale)}).` : "";
        return ok(data, `Wrote ${files.length} file(s): ${files.join(", ")}.${size}${durations}${backgrounds}${dropped}${rounded}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
