import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Studio } from "../doc/index.js";
import { fail, ok, targetShape } from "./kit.js";
import { NOT_PORTED, notPortedShape, refuseNotPorted } from "./not-ported.js";
import { packageVersion } from "../lib/version.js";
import { ToolError } from "../doc/errors.js";

export function registerSessionTools(server: McpServer, studio: Studio): void {
  server.registerTool(
    "preflight",
    {
      title: "Preflight",
      description:
        "Report what this session holds and what to do next. Call this FIRST in any pixel-art task. Documents live in this server's memory, with no editor and no window: the user sees only what `look` shows and the files you write, and nothing is on disk until you save or export.",
      inputSchema: { ...notPortedShape(NOT_PORTED.preflight) },
      outputSchema: {
        ready: z.boolean().describe("Always true: the documents live in this process."),
        version: z.string().describe("This server's version."),
        activeSprite: z
          .object({
            name: z.string(),
            width: z.number().int(),
            height: z.number().int(),
            colorMode: z.string(),
            frames: z.number().int(),
            layers: z.number().int(),
          })
          .nullish(),
        directive: z.string().describe("What to do next, in one sentence."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        refuseNotPorted(args, NOT_PORTED.preflight);
        const site = await studio.call<Record<string, unknown>>("session.site", {}, { expect: ["openSprites"] });
        const sprite = activeSpriteOf(site);
        const version = packageVersion();
        return ok(
          {
            ready: true,
            version,
            activeSprite: sprite,
            directive: sprite
              ? "Ready. Call sprite_info before your first edit so you are working from the real layer, frame and palette state. Nothing is on disk until you save or export."
              : "Ready, no sprite open. Create one with sprite_manage op 'new', or 'open' a file. Nothing is on disk until you save or export.",
          },
          sprite
            ? `READY — pixel-ai-artist ${version}, active sprite ${sprite.name} (${sprite.width}×${sprite.height}).`
            : `READY — pixel-ai-artist ${version}, no sprite open.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sprite_info",
    {
      title: "Sprite info",
      description:
        "Full structured state of a sprite: dimensions, colour mode, palette, every layer (with opacity and visibility), every frame with its duration, animation tags and the current selection. Read this before editing — guessing at layer names or frame counts is the most common way an agent corrupts someone's file.",
      inputSchema: {
        sprite: targetShape.sprite,
        includePalette: z.boolean().default(true).describe("Include the full palette as hex."),
        ...notPortedShape(NOT_PORTED.sprite_info),
      },
      outputSchema: {
        id: z.number().int().describe("Stable id for this open document. Pass it back as '#<id>'."),
        name: z.string(),
        filename: z.string().nullish(),
        width: z.number().int(),
        height: z.number().int(),
        colorMode: z.enum(["rgb", "grayscale", "indexed"]),
        transparentIndex: z.number().int().nullish(),
        frameCount: z.number().int(),
        modified: z.boolean().describe("Unsaved changes present in this document."),
        layers: z.array(
          z.object({
            name: z.string(),
            index: z.number().int(),
            visible: z.boolean(),
            editable: z.boolean(),
            opacity: z.number().int(),
            background: z
              .literal(true)
              .optional()
              .describe("Present on an Aseprite Background layer. Its pixels can be drawn like any layer's, but it stays at the bottom: it cannot be lifted above a plain layer, nothing goes below it, and PNG or GIF saved while it is visible have no transparency."),
            cels: z.array(z.number().int()).describe("1-based frames that have a cel on this layer."),
          }),
        ),
        frames: z.array(z.object({ number: z.number().int(), durationMs: z.number().int() })),
        tags: z.array(
          z.object({
            name: z.string(),
            from: z.number().int(),
            to: z.number().int(),
            direction: z.string(),
            repeats: z.number().int().nullish().describe("Loop count; 0 means forever."),
          }),
        ),
        palette: z.array(z.string()).optional(),
        selection: z
          .object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() })
          .nullish(),
        activeLayer: z.string().nullish(),
        activeFrame: z.number().int().nullish(),
        pixelAspect: z
          .string()
          .describe(
            "The pixel's width:height ratio, as set by sprite_manage 'set_properties' pixelAspect, in the form 'w:h' ('1:1' by default). It changes no pixels, and nothing that exports applies it yet.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        refuseNotPorted(args, NOT_PORTED.sprite_info);
        const data = await studio.call<Record<string, unknown>>("sprite.info", args, {
          expect: ["name", "width", "height", "colorMode", "frameCount", "layers"],
        });
        return ok(data, describeSprite(data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sprite_manage",
    {
      title: "Manage sprites",
      description:
        "Open, create, focus, resize, save and close the sprites this server holds. Ops: 'list' (open documents), 'new', 'open', 'activate', 'save', 'save_as', 'close', 'resize_canvas', 'set_properties'. Canvas resize keeps existing pixels — pass an anchor to say where they land.",
      inputSchema: {
        op: z.enum([
          "list",
          "new",
          "open",
          "activate",
          "save",
          "save_as",
          "close",
          "resize_canvas",
          "set_properties",
          "slice_create",
          "slice_update",
          "slice_delete",
        ]).describe("The slice_* ops are refused: slices are not ported."),
        sprite: targetShape.sprite,
        path: z
          .string()
          .optional()
          .describe(
            "File path for 'open' (.aseprite, PNG, GIF or JPEG, read by its content) and 'save_as' (.aseprite with every layer; .png — one file per frame, numbered as Aseprite numbers them, when there are several; or .gif). An .aseprite that uses layer groups, tilemaps, blend modes, z-index, slices or palette changes over time is refused. Layers that share a name open renamed with ' 2', ' 3' (reported in renamedLayers). An Aseprite reference layer, or one this server marked, opens as a reference layer here, but it is drawn and exported like any other layer: hide or remove it before exporting.",
          ),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        colorMode: z.enum(["rgb", "grayscale", "indexed"]).optional().describe("For 'new', or 'set_properties' to convert an existing sprite. Indexed keeps a sprite honest about its palette."),
        anchor: z
          .enum(["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"])
          .default("center")
          .describe("Where existing pixels sit after 'resize_canvas'."),
        pixelAspect: z.string().optional().describe("For 'set_properties': the pixel's width:height ratio as 'w:h', e.g. '1:1' or '2:1'. Read it back with sprite_info. Ignored by other ops."),
        force: z
          .boolean()
          .default(false)
          .describe("Allow 'close' to discard unsaved changes. Ask the user before setting this."),
      },
      outputSchema: {
        op: z.string(),
        sprites: z
          .array(
            z.object({
              id: z.number().int(),
              name: z.string(),
              filename: z.string().nullish(),
              width: z.number().int(),
              height: z.number().int(),
              colorMode: z.string(),
              frames: z.number().int(),
              layers: z.number().int(),
              active: z.boolean(),
              modified: z.boolean(),
            }),
          )
          .optional(),
        sprite: z.string().optional(),
        id: z.number().int().optional().describe("Stable id of the affected document; pass it back as '#<id>'."),
        path: z.string().optional(),
        files: z
          .array(z.string())
          .optional()
          .describe("For 'save' and 'save_as': every file written. A PNG of several frames is one numbered file per frame, none of them at `path`."),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        renamedLayers: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional()
          .describe("Op 'open': layers that shared a name in the file and were renamed so each can be addressed."),
        lostOnSave: z
          .record(z.number().int())
          .optional()
          .describe("Op 'open': what the file holds that saving will not write back the same way, counted by kind (linkedCels are saved as separate images; layerUuids and unknownChunks are dropped). Ops 'save'/'save_as' to .png or .gif: what that flat file could not keep of the sprite (layers drawn into one picture; frames, for PNG, written as numbered files without their durations; tags; an indexed sprite's palette, for PNG). Save to .aseprite to keep them."),
        skippedOnOpen: z
          .record(z.number().int())
          .optional()
          .describe("Op 'open': what the file holds that was not read, as Aseprite does not read it either (cels linked to nothing or duplicated on one layer and frame; bytes after a frame's last chunk)."),
        adjustedDurations: z
          .array(z.object({ frame: z.number().int(), from: z.number(), to: z.number().int() }))
          .optional()
          .describe("Ops 'save'/'save_as' to .aseprite: frame durations brought into the format's 1..65535 ms."),
        misplacedBackground: z
          .array(z.string())
          .optional()
          .describe("Op 'open': Background layers that were moved down to the bottom of the stack, keeping their order; one that was already in place is not listed. Backgrounds are drawn first, so the picture is unchanged, and they stay at the bottom."),
        adjustedBackgroundOpacity: z
          .array(z.object({ layer: z.string(), from: z.number().int(), to: z.literal(255) }))
          .optional()
          .describe("Ops 'save'/'save_as' to .aseprite (and export op 'aseprite', which answers the same): Background layers whose opacity was written as 255, because Aseprite ignores a Background's opacity when it reads the file."),
        alphaDropped: z
          .number()
          .int()
          .optional()
          .describe("Ops 'save'/'save_as' to .png or .gif: pixels written opaque with their colour kept, because a visible Background leaves PNG and GIF with no transparency (as Aseprite's PNG saver drops alpha). A Background below 255 opacity and holes in it come out solid."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.op === "close" && !args.force) {
          // There is no undo: a close that discards work loses it for good.
          const info = await studio.call<{ modified?: boolean; name?: string }>("sprite.info", {
            sprite: args.sprite,
            includePalette: false,
          });
          if (info.modified) {
            return fail(
              new ToolError(
                "refused",
                `'${info.name ?? "This sprite"}' has unsaved changes. Save it first, or ask the user to confirm and call again with force: true.`,
              ),
            );
          }
        }
        const data = await studio.call<Record<string, unknown>>("sprite.manage", args);
        const merged = { op: args.op, ...data };
        // Hand back the unambiguous form: the display name of a fresh document
        // is "Sprite" for every unsaved sprite at once, so an agent that feeds
        // the name straight back can address the wrong one.
        const hint = data.id === undefined ? "" : ` Refer to it as '#${String(data.id)}'.`;
        if (args.op === "list") return ok(merged, describeOpen(data.sprites as OpenSprite[]));
        const renamed = (data.renamedLayers as { from: string; to: string }[] | undefined) ?? [];
        const renames = renamed.length === 0 ? "" : ` Renamed layers that shared a name: ${renamed.map((r) => `'${r.from}' → '${r.to}'`).join(", ")}.`;
        const kinds = (key: string) => Object.entries((data[key] as Record<string, number> | undefined) ?? {}).map(([k, n]) => `${k} ${n}`).join(", ");
        const lostWhat = kinds("lostOnSave");
        const lost = !lostWhat ? "" : args.op === "open" ? ` Saving will not keep: ${lostWhat}.` : ` The file could not keep: ${lostWhat} (lostOnSave).`;
        const skipped = kinds("skippedOnOpen") ? ` Not read from the file: ${kinds("skippedOnOpen")}.` : "";
        const misplaced = (data.misplacedBackground as string[] | undefined) ?? [];
        const misplacedNote = misplaced.length > 0 ? ` Moved these Background layers down to the bottom, where they are drawn: ${misplaced.map((n) => `'${n}'`).join(", ")}.` : "";
        const dropped = typeof data.alphaDropped === "number" ? ` ${data.alphaDropped} pixel(s) written opaque because a visible Background leaves the file no transparency (alphaDropped).` : "";
        const adjusted = ((data.adjustedDurations as unknown[] | undefined) ?? []).length > 0 ? " Some frame durations were brought into 1..65535 ms (adjustedDurations)." : "";
        const background = (data.adjustedBackgroundOpacity as { layer: string; from: number }[] | undefined) ?? [];
        const backgrounds = background.length > 0 ? ` Background opacity was written as 255 (Aseprite ignores it): ${background.map((b) => `'${b.layer}' ${b.from}`).join(", ")} (adjustedBackgroundOpacity).` : "";
        return ok(merged, `${args.op}: ${String(data.sprite ?? "ok")}.${hint}${renames}${lost}${skipped}${misplacedNote}${adjusted}${backgrounds}${dropped}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

interface OpenSprite {
  id: number;
  name: string;
  active: boolean;
  modified: boolean;
}

function describeOpen(sprites: OpenSprite[]): string {
  if (sprites.length === 0) return "list: no sprite is open.";
  const each = sprites.map((s) => {
    const marks = [s.active ? "active" : "", s.modified ? "unsaved changes" : ""].filter(Boolean);
    return `'${s.name}' #${s.id}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
  });
  return `list: ${sprites.length} open — ${each.join(", ")}.`;
}

/** The `activeSprite` preflight reports, from a `session.site` reply. */
function activeSpriteOf(site: Record<string, unknown>) {
  const sprite = site.sprite as Record<string, unknown> | null | undefined;
  if (!sprite) return null;
  return {
    name: String(sprite.name ?? "untitled"),
    width: Number(sprite.width ?? 0),
    height: Number(sprite.height ?? 0),
    colorMode: String(sprite.colorMode ?? "rgb"),
    frames: Number(sprite.frames ?? 0),
    layers: Number(sprite.layers ?? 0),
  };
}

function describeSprite(data: Record<string, unknown>): string {
  const layers = (data.layers as unknown[] | undefined)?.length ?? 0;
  const tags = (data.tags as { name: string }[] | undefined) ?? [];
  const palette = (data.palette as unknown[] | undefined)?.length;
  const bits = [
    `${String(data.name)} ${String(data.width)}×${String(data.height)} ${String(data.colorMode)}`,
    `${String(data.frameCount)} frame(s)`,
    `${layers} layer(s)`,
  ];
  if (palette !== undefined) bits.push(`${palette}-colour palette`);
  if (tags.length > 0) bits.push(`tags: ${tags.map((t) => t.name).join(", ")}`);
  return bits.join(" · ");
}
