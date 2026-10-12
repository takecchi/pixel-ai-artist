# ADR-0009 — Design with an image model, draw with the agent

**Status:** accepted · 2026-09-29

## Context

Drawing a new character from words asks the agent to invent a design — the
character, the pose, the camera, the palette — and place every pixel of it in
the same breath. That is where generated pixel art fails: the tools and rules
fix technique, but nothing fixes the design, so the agent improvises one pixel
at a time and the result drifts.

Image-generation models are good at exactly the half the agent is bad at, and
bad at the half it is good at: they design convincingly and produce pixel art
that is anti-aliased, off-grid and sprawling in colour. Downscaling their output
onto the canvas ("pixelize") keeps the worst of both.

## Decision

Split the job. The image model owns the **design**; the agent owns the **pixel
interpretation**.

- **`pixel-ai-artist:concept`** writes an art spec (scenario, palette hexes, view,
  proportions, key poses), turns it into a prompt for a concept sheet or a
  storyboard with a sliceable layout contract (equal panels, one row, same scale
  and ground line), and offers the user the choice — generate and send it back,
  or continue without. The offer rides in the brief's message, so the user
  still answers once. The server never calls an image model itself.
- **A PixelSpec** is written from the reference (or from the spec alone):
  landmarks and boxes in target pixels, a palette mapping onto the sprite's own
  palette, and the deliberate deviations. It is what drawing and review check
  against.
- **Tool support is ops, not tools** ([ADR-0003]): `reference` op `import`
  gains `region` (one panel of a sheet) and `grid` (panel i onto frame i of one
  layer), and `look` gains op `compare` (reference beside the art without it).
  The count stays at eighteen (seventeen in the port).
- **The reference is a guide, never the pixels.** Skills forbid importing the
  concept as the art, copying it through `read_pixels`, or adopting its colours.

## Consequences

**Good.** The agent's task changes from "draw a mage" to "reproduce this design
at 32×32 in these colours", and review gains an external truth: `look` op
`compare` plus a list of intended deviations separates a decision from a miss.

**Good.** Works with any image model the user already has; nothing to install,
no API key, no model choice baked into the package.

**Bad.** A round trip through another tool. Mitigated by making it optional,
asked once, and never blocking — "continue without" still gets the written
spec and PixelSpec.

**Bad.** Image models ignore layout instructions often enough that `grid`
slicing will sometimes cut through a character. Mitigated by checking the first
panel with `compare` straight after import, and by per-panel `region` imports
when the panels are uneven.

[ADR-0003]: 0003-compact-tool-surface.md
