/**
 * The command table: one handler per name in `COMMAND_NAMES`, gathered from
 * `./handlers/`, one module per area. A name with no handler answers
 * `unsupported_command` — which is what every command not yet ported does,
 * rather than pretending to succeed.
 */

import { pixelHandlers } from "./handlers/pixels.js";
import { sessionHandlers } from "./handlers/session.js";
import { spriteHandlers } from "./handlers/sprite.js";
import type { HandlerTable } from "./studio.js";

export const handlers: HandlerTable = {
  ...sessionHandlers,
  ...spriteHandlers,
  ...pixelHandlers,
};
