import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Studio } from "../doc/index.js";
import { fail, ok, targetShape } from "./kit.js";

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
        return ok(data);
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
        "Spritesheet is what an engine actually consumes: pass `sheetType` and `byTag` to control layout. Exporting does not save the working document — use sprite_manage op 'save' for that.",
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
          .describe("Spritesheet layout."),
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
          .describe("Spritesheet: transparent pixels added inside each frame on all four sides (0–16), so neighbouring frames sit 2×padding apart; prevents bleed at non-integer zoom."),
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
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        frameCount: z.number().int().optional(),
        frame: z.number().int().optional().describe("Which frame a single-frame export wrote. Defaults to the active frame, which is not always the one you drew on."),
        atlas: z.string().nullish().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await studio.call<Record<string, unknown>>("export.run", args, {
          expect: ["files"],
        });
        const files = (data.files as string[]) ?? [];
        return ok(data, `Wrote ${files.length} file(s): ${files.join(", ")}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
