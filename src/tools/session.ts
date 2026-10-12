import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LinkSelector } from "../bridge/selector.js";
import { fail, ok, targetShape } from "./kit.js";
import { LiveError } from "../lib/protocol.js";
import { packageVersion } from "../lib/version.js";

const boundsShape = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** A slice as `sprite_info` and `sprite_manage`'s slice_* ops both report it. */
const sliceInfoShape = z.object({
  name: z.string(),
  bounds: boundsShape,
  center: boundsShape.optional().describe("Nine-slice centre region, relative to the slice. Only when set."),
  pivot: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
});

export function registerSessionTools(server: McpServer, live: LinkSelector): void {
  server.registerTool(
    "preflight",
    {
      title: "Preflight",
      description:
        "Check that Aseprite is connected and report what this session can do. Call this FIRST in any pixel-art task and stop if `ready` is false — every editing tool writes into the user's open Aseprite window ('live') or into a batch Aseprite this server owns ('headless'), and there is no useful fallback when that Aseprite is not there. " +
        "Pass `mode` to choose which one the session works with from now on — only because the user asked (e.g. --headless) or the request plainly needs no window (files for CI, a batch of assets). Never switch to get around a live session that is not ready: ask the user instead. Switching loses nothing; each side keeps its documents.",
      inputSchema: {
        mode: z
          .enum(["live", "headless"])
          .optional()
          .describe("Switch the session to this Aseprite before checking. Omit to keep the current one."),
      },
      outputSchema: {
        ready: z.boolean().describe("True only when Aseprite is attached and accepting commands."),
        switched: z.boolean().describe("True when this call changed the session's mode."),
        mode: z
          .enum(["live", "headless"])
          .describe("'live' = the user's open window. 'headless' = a batch Aseprite with no window; nothing is on disk until you save or export."),
        bridgeConnected: z.boolean(),
        pluginConnected: z.boolean(),
        asepriteVersion: z.string().nullish(),
        extensionVersion: z.string().nullish(),
        features: z.array(z.string()).describe("Optional capabilities this extension build supports."),
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
      const switched = args.mode ? live.use(args.mode) : false;
      if (live.mode === "headless") {
        // Starting the batch process is part of the answer: a missing or
        // broken executable is reported here, in its own words, rather than
        // on the first draw call.
        try {
          const site = await live.call<Record<string, unknown>>("session.site", {}, { expect: ["openSprites"] });
          const sprite = activeSpriteOf(site);
          const version = String(live.hello?.asepriteVersion);
          return ok(
            {
              ready: true,
              mode: "headless",
              switched,
              bridgeConnected: live.bridgeConnected,
              pluginConnected: live.pluginConnected,
              asepriteVersion: live.hello?.asepriteVersion ?? null,
              extensionVersion: live.hello?.extensionVersion ?? null,
              features: live.features,
              activeSprite: sprite,
              directive:
                "Ready, headless: there is no window, so the user sees only what `look` shows and the files you write. " +
                "Open or create a sprite with sprite_manage, and save it (op 'save'/'save_as') before you finish — unsaved work is lost when this server stops.",
            },
            sprite
              ? `READY (headless) — Aseprite ${version}, active sprite ${sprite.name} (${sprite.width}×${sprite.height}). Nothing is on disk until you save.`
              : `READY (headless) — Aseprite ${version}, no sprite open. Nothing is on disk until you save.`,
          );
        } catch (err) {
          const remediation = err instanceof LiveError ? err.details.remediation : undefined;
          const message = err instanceof Error ? err.message : String(err);
          return ok(
            {
              ready: false,
              mode: "headless",
              switched,
              bridgeConnected: live.bridgeConnected,
              pluginConnected: false,
              asepriteVersion: null,
              extensionVersion: null,
              features: [],
              activeSprite: null,
              directive: `${message}${remediation ? ` ${String(remediation)}` : ""} Tell the user; do not write the files by another route.`,
            },
            "NOT READY — the headless Aseprite could not start. Do not attempt to write sprite files yourself instead.",
          );
        }
      }

      await live.waitForBridge(2_000);
      if (!live.pluginConnected) await live.waitForPlugin(1_500);

      const base = {
        mode: "live" as const,
        switched,
        bridgeConnected: live.bridgeConnected,
        pluginConnected: live.pluginConnected,
        asepriteVersion: live.hello?.asepriteVersion ?? null,
        extensionVersion: live.hello?.extensionVersion ?? null,
        features: live.features,
      };

      if (!live.pluginConnected) {
        return ok(
          {
            ...base,
            ready: false,
            activeSprite: null,
            directive:
              (live.bridgeConnected
                ? "The bridge is running but Aseprite is not attached. Ask the user to open Aseprite with the pixel-ai-artist extension installed, then call preflight again."
                : "The bridge is not running. Ask the user to run `npx pixel-ai-artist doctor`.") +
              " If the work does not need their window, you may offer headless mode — ask; do not switch on your own.",
          },
          "NOT READY — Aseprite is not connected. Do not attempt to edit files on disk instead.",
        );
      }

      // Aseprite loads the extension once, at startup, so an editor left open
      // across an upgrade keeps answering with the old build — and the agent
      // spends the session working around bugs that were fixed weeks ago. Say
      // so up front; it is the first thing preflight is asked.
      const stale =
        base.extensionVersion !== null && base.extensionVersion !== packageVersion()
          ? `The attached extension is ${String(base.extensionVersion)} but this server is ${packageVersion()}. ` +
            "Tell the user to run `install-extension` and restart Aseprite before trusting a command that misbehaves. "
          : "";

      try {
        const site = await live.call<Record<string, unknown>>("session.site", {}, { expect: ["openSprites"] });
        const sprite = activeSpriteOf(site);
        return ok(
          {
            ...base,
            ready: true,
            activeSprite: sprite,
            directive:
              stale +
              (sprite
                ? "Ready. Call sprite_info before your first edit so you are working from the real layer, frame and palette state."
                : "Ready, but no sprite is open. Use sprite_manage with op 'new' or 'open' first."),
          },
          sprite
            ? `READY — Aseprite ${base.asepriteVersion}, active sprite ${sprite.name} (${sprite.width}×${sprite.height}).`
            : "READY — Aseprite is connected but no sprite is open.",
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
        "Full structured state of a sprite: dimensions, colour mode, palette, every layer (with opacity, blend mode, visibility, group nesting), every frame with its duration, animation tags, slices and the current selection. Read this before editing — guessing at layer names or frame counts is the most common way an agent corrupts someone's file.",
      inputSchema: {
        sprite: targetShape.sprite,
        includePalette: z.boolean().default(true).describe("Include the full palette as hex."),
        includeSlices: z.boolean().default(false),
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
            blendMode: z.string(),
            isGroup: z.boolean(),
            isTilemap: z.boolean(),
            parent: z.string().nullish(),
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
        slices: z.array(sliceInfoShape).optional(),
        selection: z
          .object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() })
          .nullish(),
        activeLayer: z.string().nullish(),
        activeFrame: z.number().int().nullish(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await live.call<Record<string, unknown>>("sprite.info", args, {
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
        "Open, create, focus, resize, save and close sprites in the running Aseprite session. Ops: 'list' (open documents), 'new', 'open', 'activate', 'save', 'save_as', 'close', 'resize_canvas', 'set_properties', 'slice_create', 'slice_update', 'slice_delete'. Canvas resize keeps existing pixels — pass an anchor to say where they land. " +
        "Slices name a rectangular region of the canvas for an engine to read back — a 9-patch panel's `center`, or a hotspot's `pivot`.",
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
        ]),
        sprite: targetShape.sprite,
        path: z.string().optional().describe("File path for 'open' and 'save_as'."),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        colorMode: z.enum(["rgb", "grayscale", "indexed"]).optional().describe("For 'new'. Indexed keeps a sprite honest about its palette."),
        anchor: z
          .enum(["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"])
          .default("center")
          .describe("Where existing pixels sit after 'resize_canvas'."),
        pixelAspect: z.string().optional().describe("e.g. '1:1' or '1:2'."),
        force: z
          .boolean()
          .default(false)
          .describe("Allow 'close' to discard unsaved changes. Ask the user before setting this."),
        name: z.string().optional().describe("Slice name. Required for 'slice_create'; identifies it for update/delete."),
        bounds: boundsShape.optional().describe("Slice rectangle. Required for 'slice_create'."),
        center: boundsShape
          .optional()
          .describe("For slice ops: nine-slice centre region, relative to `bounds`."),
        pivot: z.object({ x: z.number().int(), y: z.number().int() }).optional().describe("For slice ops."),
        color: z.string().optional().describe("For slice ops: slice colour in the timeline, #rrggbb."),
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
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        name: z.string().optional().describe("Slice name, for 'slice_delete'."),
        slice: sliceInfoShape.optional().describe("The affected slice, for 'slice_create'/'slice_update'."),
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
          // A close that discards work is not recoverable through undo.
          const info = await live.call<{ modified?: boolean; name?: string }>("sprite.info", {
            sprite: args.sprite,
            includePalette: false,
          });
          if (info.modified) {
            return fail(
              new Error(
                `'${info.name ?? "This sprite"}' has unsaved changes. Save it first, or ask the user to confirm and call again with force: true.`,
              ),
            );
          }
        }
        const data = await live.call<Record<string, unknown>>("sprite.manage", args);
        const merged = { op: args.op, ...data };
        // Hand back the unambiguous form: the display name of a fresh document
        // is "Sprite" for every unsaved sprite at once, so an agent that feeds
        // the name straight back can address the wrong one.
        const hint = data.id === undefined ? "" : ` Refer to it as '#${String(data.id)}'.`;
        return ok(merged, `${args.op}: ${String(data.sprite ?? "ok")}.${hint}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
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
