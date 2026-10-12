/**
 * The command table: one handler per name in `COMMAND_NAMES`, gathered from
 * `./handlers/`, one module per area. A name with no handler answers
 * `unsupported_command` — which is what every command not yet ported does,
 * rather than pretending to succeed.
 */

import { celHandlers } from "./handlers/cel.js";
import { drawHandlers } from "./handlers/draw.js";
import { exportHandlers } from "./handlers/export.js";
import { frameHandlers } from "./handlers/frame.js";
import { layerHandlers } from "./handlers/layer.js";
import { lookHandlers } from "./handlers/look.js";
import { paletteHandlers } from "./handlers/palette.js";
import { pixelHandlers } from "./handlers/pixels.js";
import { recolorHandlers } from "./handlers/recolor.js";
import { sessionHandlers } from "./handlers/session.js";
import { spriteHandlers } from "./handlers/sprite.js";
import { tagHandlers } from "./handlers/tag.js";
import { transformHandlers } from "./handlers/transform.js";
import { validateHandlers } from "./handlers/validate.js";
import type { HandlerTable } from "./studio.js";

// Alphabetical, one module per line, like the imports: two changes that each
// add a module then touch different lines and merge without a conflict.
export const handlers: HandlerTable = {
  ...celHandlers,
  ...drawHandlers,
  ...exportHandlers,
  ...frameHandlers,
  ...layerHandlers,
  ...lookHandlers,
  ...paletteHandlers,
  ...pixelHandlers,
  ...recolorHandlers,
  ...sessionHandlers,
  ...spriteHandlers,
  ...tagHandlers,
  ...transformHandlers,
  ...validateHandlers,
};
