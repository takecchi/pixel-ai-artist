import { handlers } from "./commands.js";
import { Studio } from "./studio.js";

export function createStudio(): Studio {
  return new Studio(handlers);
}

export * from "./errors.js";
export * from "./model.js";
export * from "./studio.js";
export { spriteSummary } from "./handlers/session.js";
