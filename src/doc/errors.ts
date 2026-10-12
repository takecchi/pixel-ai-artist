/**
 * The codes the Lua extension answered with, plus the ones the server itself
 * raises. `internal_error` takes the place of `aseprite_error`: a handler that
 * throws anything but a ToolError has a bug, and there is no editor to blame.
 */
export type ErrorCode =
  | "no_active_sprite"
  | "unsupported_command"
  | "invalid_args"
  | "refused"
  | "too_large"
  | "io_error"
  | "internal_error";

/** What a command throws for the agent to read; `fail()` turns it into a tool result. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  /** Machine-readable remediation hint; never free-form prose the agent must parse. */
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

/** The Lua `need()`: a required argument that is absent is `invalid_args` naming it. */
export function need<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new ToolError("invalid_args", `Missing required argument '${name}'.`);
  }
  return value;
}
