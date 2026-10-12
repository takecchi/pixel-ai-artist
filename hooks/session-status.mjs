#!/usr/bin/env node
/**
 * Tells the session whether Aseprite is actually reachable, before the model
 * tries to draw and gets a confusing failure five tool calls in.
 */

import { bridgeStatusMessage } from "./shared.mjs";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: await bridgeStatusMessage(),
    },
  }),
);
