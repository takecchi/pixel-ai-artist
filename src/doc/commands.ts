/**
 * The command table: one handler per name in `COMMAND_NAMES`, gathered from
 * `./handlers/`, one module per area. A name with no handler answers
 * `unsupported_command` — which is what every command not yet ported does,
 * rather than pretending to succeed.
 */

import { celHandlers } from "./handlers/cel.js";
import { drawHandlers } from "./handlers/draw.js";
import { frameHandlers } from "./handlers/frame.js";
import { layerHandlers } from "./handlers/layer.js";
import { lookHandlers } from "./handlers/look.js";
import { pixelHandlers } from "./handlers/pixels.js";
import { recolorHandlers } from "./handlers/recolor.js";
import { sessionHandlers } from "./handlers/session.js";
import { spriteHandlers } from "./handlers/sprite.js";
import { tagHandlers } from "./handlers/tag.js";
import { transformHandlers } from "./handlers/transform.js";
import { validateHandlers } from "./handlers/validate.js";
import type { HandlerTable } from "./studio.js";

export const handlers: HandlerTable = {
  ...sessionHandlers,
  ...spriteHandlers,
  ...pixelHandlers,
  ...lookHandlers,
  ...layerHandlers,
  ...frameHandlers,
  ...tagHandlers,
  ...celHandlers,
  ...drawHandlers,
  ...recolorHandlers,
  ...transformHandlers,
  ...validateHandlers,
};
