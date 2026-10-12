import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AsepriteLink } from "../bridge/link.js";
import { fail, ok, targetShape } from "./kit.js";

/**
 * Layers, frames, tags and cels — the skeleton an animator works against.
 *
 * Each is one tool with an `op` enum and a batch array, because these calls
 * arrive in clusters: building a character rig is eight layers, and blocking in
 * a walk cycle is eight frames with three different durations.
 */
const blendMode = z.enum([
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color_dodge", "color_burn", "hard_light", "soft_light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity", "addition",
  "subtract", "divide",
]);

const layerOpName = z.enum([
  "list", "create", "rename", "delete", "reorder", "set",
  "group", "ungroup", "merge", "duplicate", "activate",
]);

/** One layer operation. Used for both the single-op form and every `batch` entry. */
const layerOp = z.object({
  op: layerOpName,
  name: z.string().optional(),
  newName: z.string().optional(),
  parent: z.string().optional().describe("Group layer to nest under."),
  index: z.number().int().optional().describe("Target stack position; 0 is bottom."),
  visible: z.boolean().optional(),
  editable: z.boolean().optional(),
  opacity: z.number().int().min(0).max(255).optional(),
  blendMode: blendMode.optional(),
  names: z.array(z.string()).optional().describe("For 'merge' and bulk 'group'."),
  toSprite: z
    .string()
    .optional()
    .describe("For 'duplicate': copy the layer into another OPEN sprite instead of this one."),
});

export function registerStructureTools(server: McpServer, live: AsepriteLink): void {
  server.registerTool(
    "layer",
    {
      title: "Layers",
      description:
        "Manage layers. Ops: 'list', 'create', 'rename', 'delete', 'reorder', 'set' (visibility/opacity/blend/lock), 'group', 'ungroup', 'merge', 'duplicate', 'activate'. " +
        "Pass `batch` to run several in one undoable action — building a rig in one call is the normal use. " +
        "'duplicate' takes an optional `toSprite` to copy the layer's cels into another OPEN sprite instead of this one, by frame index; frames past the target's frame count are dropped and reported. " +
        "A character that will be animated wants its parts on separate layers (head, torso, arm-far, arm-near, leg-far, leg-near) before any frames exist; splitting baked pixels apart later is far more work.",
      inputSchema: {
        op: layerOpName.optional().describe("Single operation. Use `batch` instead for several."),
        sprite: targetShape.sprite,
        name: z.string().optional(),
        newName: z.string().optional(),
        parent: z.string().optional().describe("Group layer to nest under."),
        index: z.number().int().optional().describe("Target stack position for 'reorder'; 0 is bottom."),
        visible: z.boolean().optional(),
        editable: z.boolean().optional(),
        opacity: z.number().int().min(0).max(255).optional(),
        blendMode: blendMode.optional(),
        names: z.array(z.string()).optional().describe("For 'merge' and bulk 'group'."),
        toSprite: z
          .string()
          .optional()
          .describe("For 'duplicate': copy the layer into another OPEN sprite instead of this one."),
        batch: z
          .array(layerOp)
          .max(128)
          .optional()
          .describe("Operations applied in order, in one undoable action. Same shape as the single-op arguments."),
      },
      outputSchema: {
        sprite: z.string(),
        layers: z
          .array(
            z.object({
              name: z.string(),
              index: z.number().int(),
              visible: z.boolean(),
              editable: z.boolean(),
              opacity: z.number().int(),
              blendMode: z.string(),
              isGroup: z.boolean(),
              isTilemap: z.boolean(),
              parent: z.string().nullish(),
              cels: z.array(z.number().int()).describe("1-based frames that have a cel on this layer."),
            }),
          )
          .optional(),
        applied: z.number().int().optional(),
        activeLayer: z.string().nullish().optional(),
        duplicated: z
          .array(
            z.object({
              sourceLayer: z.string(),
              name: z.string().describe("Name it got in the target sprite; suffixed on a name clash."),
              toSprite: z.string().describe("Target as '#<id>' — stable even when several documents share a name."),
              framesDropped: z.number().int().describe("Cels whose frame index exceeded the target's frame count."),
            }),
          )
          .optional()
          .describe("Present when a 'duplicate' op in this call used `toSprite`."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await live.call<Record<string, unknown>>("layer.apply", args);
        return ok(data, describeLayers(data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "frame",
    {
      title: "Frames",
      description:
        "Manage animation frames. Ops: 'list', 'add', 'duplicate', 'delete', 'set_duration', 'activate', 'reorder'. " +
        "Durations are milliseconds per frame and carry most of the life in a cycle — hold a contact pose longer than a pass pose. " +
        "Use `count` to add several at once and `durations` to set a whole cycle's timing in one call.",
      inputSchema: {
        op: z.enum(["list", "add", "duplicate", "delete", "set_duration", "activate", "reorder"]),
        sprite: targetShape.sprite,
        frame: targetShape.frame,
        count: z.number().int().positive().max(256).default(1),
        afterFrame: z.number().int().positive().optional().describe("Insert position. Default: at the end."),
        durationMs: z.number().int().positive().max(65535).optional(),
        durations: z
          .array(z.number().int().positive())
          .optional()
          .describe("Per-frame durations from frame 1, for 'set_duration'."),
        toIndex: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("For 'reorder': the 1-based position `frame` ends up at. Its cels and duration move with it; tag ranges stay where they are."),
        linkCels: z
          .boolean()
          .default(false)
          .describe("For 'duplicate': share the cel image instead of copying it, so edits apply to both."),
      },
      outputSchema: {
        sprite: z.string(),
        frameCount: z.number().int(),
        frames: z
          .array(z.object({ number: z.number().int(), durationMs: z.number().int() }))
          .optional(),
        activeFrame: z.number().int().optional(),
        totalDurationMs: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await live.call<Record<string, unknown>>("frame.apply", args);
        const total = data.totalDurationMs;
        const summary =
          typeof total === "number"
            ? `${String(data.frameCount)} frame(s), ${total}ms total (${(1000 / Math.max(total / Number(data.frameCount || 1), 1)).toFixed(1)} fps average).`
            : undefined;
        return ok(data, summary);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "tag",
    {
      title: "Animation tags",
      description:
        "Manage animation tags — the named frame ranges a game engine imports as 'idle', 'walk', 'attack'. Ops: 'list', 'create', 'update', 'delete'. Tag every cycle before export; an untagged spritesheet is a pile of frames the engine cannot address.",
      inputSchema: {
        op: z.enum(["list", "create", "update", "delete"]),
        sprite: targetShape.sprite,
        name: z.string().optional(),
        newName: z.string().optional(),
        from: z.number().int().positive().optional().describe("First frame, 1-based, inclusive."),
        to: z.number().int().positive().optional().describe("Last frame, 1-based, inclusive."),
        direction: z.enum(["forward", "reverse", "pingpong", "pingpong_reverse"]).optional(),
        repeats: z.number().int().min(0).optional().describe("Loop count; 0 means forever."),
        color: z.string().optional().describe("Tag colour in the timeline, #rrggbb."),
      },
      outputSchema: {
        sprite: z.string(),
        tags: z.array(
          z.object({
            name: z.string(),
            from: z.number().int(),
            to: z.number().int(),
            direction: z.string(),
            frames: z.number().int(),
            durationMs: z.number().int(),
          }),
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await live.call<Record<string, unknown>>("tag.apply", args);
        return ok(data);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cel",
    {
      title: "Cels",
      description:
        "Manage cels — one layer's image on one frame. Ops: 'list', 'create', 'clear', 'delete', 'move', 'copy', 'link', 'unlink', 'set' (position/opacity), 'tween', 'oscillate'. " +
        "'move' is how you shift a whole limb between frames without redrawing it; 'link' shares one image across frames so a static part of a cycle stays in sync. " +
        "'tween' interpolates position or opacity between two frames with an easing curve; 'oscillate' adds a sinusoidal position offset over a frame range — both fill in any missing in-between cels from the start cel, in one transaction.",
      inputSchema: {
        op: z.enum([
          "list", "create", "clear", "delete", "move", "copy", "link", "unlink", "set", "tween", "oscillate",
        ]),
        ...targetShape,
        toFrame: z.number().int().positive().optional(),
        toLayer: z.string().optional(),
        frames: z.array(z.number().int().positive()).optional().describe("For 'link' across a range."),
        x: z.number().int().optional().describe("Cel origin, for 'set' and 'move'."),
        y: z.number().int().optional(),
        dx: z.number().int().optional().describe("Relative move."),
        dy: z.number().int().optional(),
        opacity: z.number().int().min(0).max(255).optional(),
        fromFrame: z.number().int().positive().optional().describe("For 'tween'/'oscillate': the start frame."),
        property: z.enum(["position", "opacity"]).optional().describe("For 'tween'."),
        to: z
          .union([z.object({ x: z.number().int(), y: z.number().int() }), z.number().int().min(0).max(255)])
          .optional()
          .describe("For 'tween': end value — {x,y} for property 'position', 0-255 for 'opacity'."),
        easing: z
          .enum(["linear", "ease_in", "ease_out", "ease_in_out", "smoothstep"])
          .default("linear")
          .describe("For 'tween'."),
        amplitudeX: z.number().int().default(0).describe("For 'oscillate'."),
        amplitudeY: z.number().int().default(0).describe("For 'oscillate'."),
        period: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe("For 'oscillate', in frames. Default: the whole fromFrame..toFrame span."),
        phase: z.number().min(0).max(1).default(0).describe("For 'oscillate': 0-1 fraction of one period."),
      },
      outputSchema: {
        sprite: z.string(),
        cels: z
          .array(
            z.object({
              layer: z.string(),
              frame: z.number().int(),
              x: z.number().int(),
              y: z.number().int(),
              width: z.number().int(),
              height: z.number().int(),
              opacity: z.number().int(),
              linked: z.boolean(),
            }),
          )
          .optional(),
        applied: z.number().int().optional(),
        frames: z
          .array(
            z.object({
              frame: z.number().int(),
              x: z.number().int().optional(),
              y: z.number().int().optional(),
              opacity: z.number().int().optional(),
            }),
          )
          .optional()
          .describe("Only present for 'tween' and 'oscillate': one entry per frame touched, ascending."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await live.call<Record<string, unknown>>("cel.apply", args);
        return ok(data);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

function describeLayers(data: Record<string, unknown>): string | undefined {
  const layers = data.layers as { name: string; isGroup: boolean; visible: boolean }[] | undefined;
  if (!layers) return undefined;
  return `${layers.length} layer(s), top to bottom: ${[...layers]
    .reverse()
    .map((l) => `${l.name}${l.isGroup ? "/" : ""}${l.visible ? "" : " (hidden)"}`)
    .join(", ")}`;
}
