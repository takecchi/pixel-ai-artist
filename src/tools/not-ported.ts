/**
 * Arguments the original tools took that this port does not. The SDK strips
 * keys a schema does not declare, so an agent that learned the original's
 * calls would never hear that one had no effect. Each is declared here only so
 * that passing it is refused with why and what to do instead. Unknown keys in
 * general are still let through, because some clients add their own.
 */

import { z } from "zod";
import { ToolError } from "../doc/errors.js";

export interface NotPorted {
  why: string;
  instead: string;
  /** Whether this value asks for what the port cannot do; absent means any value does. */
  refuses?: (value: unknown) => boolean;
}

const isTrue = (v: unknown) => v === true;
const nonEmptyList = (v: unknown) => !Array.isArray(v) || v.length > 0;

export const NOT_PORTED = {
  draw: {
    label: {
      why: "It named the step in Aseprite's undo history, and this port keeps no undo history.",
      instead: "Leave it out.",
    },
  },
  transform: {
    allowLossy: {
      why: "Rotation is by multiples of 90° only, because any other angle resamples every pixel and ruins pixel art; there is no lossy path to allow.",
      instead: "Rotate by 90, 180 or 270, or redraw the part at the new angle.",
      refuses: isTrue,
    },
  },
  preflight: {
    mode: {
      why: "It switched between a live and a headless Aseprite, and this port has one session, in the server itself.",
      instead: "Leave it out; preflight reports the session as it is.",
    },
  },
  sprite_info: {
    includeSlices: {
      why: "Slices are not ported.",
      instead: "Leave it out; mark a region with its own layer or a tag.",
      refuses: isTrue,
    },
  },
  layer: {
    parent: {
      why: "Layer groups are not ported; every layer sits at the top level.",
      instead: "Leave it out, and name related layers so they sort together, such as 'arm-far' and 'arm-near'.",
      refuses: (v: unknown) => v !== "",
    },
    blendMode: {
      why: "Blend modes are not ported; every layer composites normally at its opacity.",
      instead: "Use the layer's opacity, or recolor its pixels.",
      refuses: (v: unknown) => v !== "normal",
    },
    names: {
      why: "It listed layers for a multi-layer merge and for grouping, and layer groups are not ported.",
      instead: "Merge one layer at a time with `name` and op 'merge'.",
      refuses: nonEmptyList,
    },
  },
  frame: {
    linkCels: {
      why: "Linked cels are not ported; a duplicated frame copies its cels.",
      instead: "Leave it out, and edit each copy, or finish the cel before duplicating.",
      refuses: isTrue,
    },
  },
  cel: {
    frames: {
      why: "It gave the frames for op 'link', and linked cels are not ported.",
      instead: "Copy the cel to each frame with op 'copy'.",
      refuses: nonEmptyList,
    },
  },
} satisfies Record<string, Record<string, NotPorted>>;

/** The schema entry for a dropped argument: accepted by the SDK so that the tool can refuse it. */
export function notPortedArg(n: NotPorted): z.ZodOptional<z.ZodUnknown> {
  return z.unknown().optional().describe(`Not in this port, and refused when passed: ${n.why} ${n.instead}`);
}

/** Schema entries for every dropped argument of one tool. */
export function notPortedShape(table: Record<string, NotPorted>): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries(Object.entries(table).map(([key, n]) => [key, notPortedArg(n)]));
}

/**
 * Throws invalid_args naming every dropped argument asked for, in `args` and
 * in each item of `batch` (named as in "batch[2].parent"), so that one retry
 * can leave them all out. Each reason is given once per argument.
 */
export function refuseNotPorted(
  args: Record<string, unknown>,
  table: Record<string, NotPorted>,
  batch: readonly Record<string, unknown>[] = [],
): void {
  const sources: [string, Record<string, unknown>][] = [["", args], ...batch.map((op, i): [string, Record<string, unknown>] => [`batch[${i}].`, op])];
  const asked = sources.flatMap(([where, source]) =>
    Object.entries(table)
      .filter(([key, n]) => source[key] !== undefined && (!n.refuses || n.refuses(source[key])))
      .map(([key, n]) => ({ name: `${where}${key}`, key, n })),
  );
  if (asked.length === 0) return;
  const names = asked.map((a) => `\`${a.name}\``);
  const listed = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  const reasons = [...new Map(asked.map((a) => [a.key, a.n])).entries()].map(([key, n]) =>
    asked.length === 1 ? `${n.why} ${n.instead}` : `\`${key}\`: ${n.why} ${n.instead}`,
  );
  throw new ToolError("invalid_args", `${listed} ${asked.length === 1 ? "is" : "are"} not ported in this version. ${reasons.join(" ")}`, {
    argument: asked[0]!.name,
    arguments: asked.map((a) => a.name),
  });
}
