/**
 * Small helpers shared by every tool module.
 *
 * The house style for this server: one tool per *noun*, an `op` enum for the
 * verbs, and a batch array wherever an agent would otherwise loop. Ninety
 * single-purpose tools is a schema the model pays for on every single turn
 * whether it draws anything or not; see docs/adr/0003-compact-tool-surface.md.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "../doc/errors.js";

export const hexColor = z
  .string()
  .regex(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected #rrggbb or #rrggbbaa")
  .describe("Colour as #rrggbb or #rrggbbaa.");

/** Every tool that touches a document accepts this; omitted means "active". */
export const targetShape = {
  sprite: z
    .string()
    .optional()
    .describe(
      "Which sprite: its id as '#7' (what every result reports back, and the only unambiguous form — two unsaved documents are both called 'Sprite'), its filename, or its display name. Omit to use the active sprite, which preflight reports.",
    ),
  layer: z.string().optional().describe("Layer name. Omit to use the active layer."),
  frame: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based frame number. Omit to use the active frame."),
};

export function ok(structured: Record<string, unknown>, summary?: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary ?? compactSummary(structured) }],
    structuredContent: structured,
  };
}

export function okWithImage(
  structured: Record<string, unknown>,
  image: { data: string; mimeType: string },
  summary: string,
): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
    structuredContent: structured,
  };
}

/**
 * Errors are returned as tool results, not thrown as protocol errors: the model
 * has to see them to recover, and a JSON-RPC error is swallowed by most hosts.
 * The first line is `<code>: <message>`, the part an agent branches on.
 *
 * No `structuredContent`: an output schema describes the success shape, and
 * MCP clients (the SDK's `callTool` among them) check structured content
 * against it even on an error, turning a tool error into a protocol error.
 */
export function fail(err: unknown): CallToolResult {
  const tool = err instanceof ToolError ? err : null;
  const code = tool?.code ?? "internal_error";
  const message = err instanceof Error ? err.message : String(err);
  const details = tool?.details ?? {};

  const lines = [`${code}: ${message}`];
  if (details.remediation) lines.push(`Fix: ${String(details.remediation)}`);

  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

function compactSummary(structured: Record<string, unknown>): string {
  const keys = Object.keys(structured);
  if (keys.length === 0) return "Done.";
  const parts: string[] = [];
  for (const key of keys.slice(0, 6)) {
    const value = structured[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) parts.push(`${key}=${value.length}`);
    else if (typeof value === "object") continue;
    else parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? parts.join(" ") : "Done.";
}
