import { readFileSync } from "node:fs";
import path from "node:path";
import { decodePaletteFile } from "../../lib/palette-file.js";
import { ToolError, need } from "../errors.js";
import { displayName, rgbaToHex } from "../model.js";
import type { HandlerTable, Studio } from "../studio.js";

function paletteLoad(studio: Studio, args: Record<string, unknown>) {
  const s = studio.resolveSprite(args.sprite);
  const file = need(args.path, "path");
  if (typeof file !== "string") throw new ToolError("invalid_args", "path must be a string.");
  const full = path.resolve(file);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(full);
  } catch (err) {
    throw new ToolError("io_error", `Cannot read '${file}': ${(err as Error).message}`, { path: full });
  }
  const colors = decodePaletteFile(bytes, path.extname(full));
  if (colors.length === 0) {
    throw new ToolError("io_error", `Could not read a palette from '${file}'.`, { path: full });
  }

  s.palette = colors;
  s.modified = true;
  return { sprite: displayName(s), colors: colors.map((c) => rgbaToHex(c, true)), size: colors.length, path: file };
}

export const paletteHandlers: HandlerTable = {
  "palette.load": paletteLoad,
};
