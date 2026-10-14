---
name: studio
title: Take any pixel-art request end to end
description: The front door for any pixel-art or sprite request. Works out what the user actually wants, picks which workflows to run and in what order, hands parts to the specialist agents where the harness has them, and does not stop until the result has been looked at, reviewed and written to a file. Use when a request spans several steps ("make me an animated knight for Godot") or when you are unsure which workflow applies.
---

# Take any pixel-art request end to end

The other workflows each do one thing well. This one decides which of them the
request needs, runs them in the order that keeps mistakes cheap, and owns the
result until it is finished. It does not replace them: at every step, read the
workflow it names and follow that — do not do the step from memory.

## Procedure

1. **`preflight`.** The documents live in this server's memory, with no
   window: the user sees only the `look` previews you show them and the files
   you write. Show previews as you go, and save (`sprite_manage` op `save_as`
   to an `.aseprite` path — a `.png` or `.gif` keeps only the picture, not the
   layers, frames or tags) or export before reporting — nothing is on disk
   until you do, and it is lost when the server stops. Never write sprite
   files by any other route.

2. **Read the room.** `sprite_manage op="list"`, then `sprite_info` on whatever
   is open — and if the user points at a file ("fix my knight.png"), `open` it
   first. An open sprite changes the plan: "make it bigger" means a sprite that exists, and its canvas and
   palette answer questions you would otherwise have to ask.

3. **Classify the request** against the table below. Most requests are one row;
   a big one ("animated knight, export for Godot") chains several. Write the
   chain down before starting — it is the plan you report progress against.

4. **Decide once whether to ask.** Open-ended requests start with `pixel-ai-artist:brief`,
   which puts every decision to the user in one message. Specific requests ("add
   a 1px outline", "export this as a GIF") do not — just do them. Never ask more
   than once per stage: a user who asked for a whole animation does not want to
   approve every frame.

5. **Design before drawing.** Anything new — a character, a prop, a scene, an
   animation — goes through `pixel-ai-artist:concept` before a pixel is placed: it
   writes the art spec (scenario, palette, poses), turns it into a prompt for
   an image model, and offers the user two ways on: generate a concept sheet or
   storyboard with that prompt and send it back, or continue without one. That
   offer rides in the brief's message when there is a brief, so the user still
   answers once. If they will send references, stop and wait; when the images
   arrive, `pixel-ai-artist:concept` reads them into a PixelSpec and imports them. If
   the user already supplied reference art, skip the prompt and go straight to
   reading it.

6. **Run the chain.** For each stage, read its skill (`skill://<name>`) and
   follow it. Hand a stage to a specialist agent when your harness has one (see
   below) — the agent reads the same rules, so the result is the same whether it
   runs or you do.

7. **Look after every stage that changed pixels.** `look` op `preview` for the
   read, op `ascii` when position matters, op `compare` when there is a
   reference. A stage is done when you have seen its result, not when its tool
   reported success.

8. **Get judged by someone who did not draw it.** For anything you drew or
   changed, hand the result to the `pixel-critic` agent where the harness has
   one — never grade your own work in place of it; you know what you meant,
   so you see it. Give it the document name and the brief, nothing about how
   it was made. Elsewhere, run `pixel-ai-artist:review` and do its cold read first.

   The critique decides whether you iterate at all. A draft ships as it is
   when its critique has **no BLOCKING finding and scores 7/10 or more** —
   note its other findings in your report and stop. Below that, or while any
   BLOCKING finding remains, fix it — at most three fix rounds. Stopping a
   weak draft only because nothing was marked BLOCKING leaves it weak.

   Each round fixes the BLOCKING findings, or when there are none the one
   change the critic names as its first fix — never a general polish. A
   fresh critic always finds something, and each finds something different;
   polishing on that alone rebuilds parts that already worked. The guards
   below are what keep a round from doing that:

   - **Snapshot before you touch it.** `export op="png"` the current frame (or
     `op="gif"` for an animation) to a scratch path, and keep an exact copy of
     every layer you will change — `export op="aseprite"` to a scratch path,
     or the layer's rows from `look op="ascii"`. Restoring means writing those
     rows back as a `grid` at the same x/y, or opening the copy and
     `layer op="duplicate" toSprite=<document>`. The duplicate lands on top
     of the document as `<name> 2`, next to the changed layer: delete the
     changed one, rename the copy back and `reorder` it to the old `index`
     from `sprite_info`, then `close` the copy.
   - **Fix, don't redraw.** A fix changes the pixels the finding points at —
     read that region with `look op="ascii"`, change those rows, write them
     back as a `grid` — or recolours a mass that is too dark (`recolor`; on a
     fixed palette with no lighter step it answers 0 pixels, so add the step
     with `palette op="ramp"` first or change the rows by hand). If
     the round changed more than about a quarter of a layer's opaque pixels,
     it was a redraw: restore the snapshot and make the smaller fix. Never
     touch pixels the brief says must stay as they are.
   - **Decide by comparison, not by score.** Scores from separate critic calls
     are not on one scale — the same tree drew 5/10 from one critic and 4/10
     from the next. After the fix, export the new version next to the
     snapshot, and give **one** critic call both images, in an order it cannot
     read anything into (`a.png`, `b.png`, coin-flipped), asking which is the
     better sprite for the brief and whether the BLOCKING finding is gone.
     Keep the fix only if it picks the new one; otherwise restore. Two
     rounds in a row that the comparison rejects end the loop.

   Do not change pixels after the last critique; anything you edit afterwards
   goes back to the critic. A critique whose cold read did not name your
   subject is the most important finding you will get: the picture does not
   say what you think it says. Report each round: the BLOCKING finding, what
   you changed, and which version the comparison chose.

9. **Report** in a few lines: what exists now (document, layers, tags, and the
   paths of the files written), what you decided on the user's behalf, what you compromised on and
   why — including where the sprite departs from the reference on purpose.
   Show it — a `look` preview or the exported file's path, not an adjective.

## Routing

| The user wants | Chain |
|----------------|-------|
| Something new, loosely described ("a knight") | `pixel-ai-artist:brief` + `pixel-ai-artist:concept` (one message) → `pixel-ai-artist:new` → `pixel-ai-artist:palette` if the palette is not settled → `pixel-ai-artist:draw` → `pixel-ai-artist:shade` → `pixel-ai-artist:review` |
| Something new, fully specified | `pixel-ai-artist:concept` → `pixel-ai-artist:new` → `pixel-ai-artist:draw` → `pixel-ai-artist:shade` → `pixel-ai-artist:review` |
| Pixel art of a picture the user supplied ("make this character a sprite") | `pixel-ai-artist:brief` if size or palette is open → `pixel-ai-artist:concept` from its reference step → `pixel-ai-artist:new` → `pixel-ai-artist:draw` → `pixel-ai-artist:review` |
| An animation of a character | the drawing chain above if nothing exists yet, with a storyboard in the concept prompt → `pixel-ai-artist:rig` → `pixel-ai-artist:animate` → `pixel-ai-artist:review` |
| An animation of a sprite that is already rigged | `pixel-ai-artist:concept` for the storyboard (offer) → `pixel-ai-artist:animate` → `pixel-ai-artist:review` |
| Tiles, terrain, level art | `pixel-ai-artist:brief` if open-ended → `pixel-ai-artist:concept` (an environment sheet) → `pixel-ai-artist:draw` → `pixel-ai-artist:review` |
| Colours changed, a retro look, a cleanup | `pixel-ai-artist:palette` → `pixel-ai-artist:review` |
| Volume, light, "it looks flat" | `pixel-ai-artist:shade` → `pixel-ai-artist:review` |
| A change to existing art ("make it more menacing", "fix the hands") | `pixel-ai-artist:fix` → `pixel-ai-artist:review` |
| An opinion ("is this good?", "why does it look off?") | `pixel-ai-artist:review` only — report, do not edit unless asked |
| Files for an engine or for sharing | `pixel-ai-artist:review` if not already done → `pixel-ai-artist:export` |
| Words on the art — a label, score, title card | `pixel-ai-artist:draw` (its Text section) → `pixel-ai-artist:review` |

If a request fits no row, it is usually a direct tool call ("rename the layer",
"add a frame"): make it, `look` if pixels changed, and say what you did.

## Subject rules

Before a stage draws or animates something, read the rule files for its
subject — every stage, and every agent you hand a stage to. Two or three files
is normal; reading all of them is not. Each one has size budgets, mistakes, a
review list and ` ```grid ` templates to transcribe with `draw` kind `grid`.

| Drawing | Read |
|---------|------|
| Any character | `rules://30-proportions-by-size`, `rules://31-anatomy-and-pose`, `rules://36-character-design` |
| Its face, eyes, expression | `rules://32-heads-and-faces`, `rules://33-eyes-and-expressions` |
| Hands, feet, a held weapon | `rules://34-hands-and-feet` |
| Hair, clothing, armour, capes | `rules://35-hair-and-clothing`, `rules://23-materials-soft` |
| A turnaround, top-down or 8-direction set | `rules://37-views-and-directions`, `rules://47-top-down-animation` |
| A dialogue portrait | `rules://38-portraits` |
| Any animation | `rules://40-timing-and-spacing`, plus the cycle below |
| Idle, walk/run, jump, attack | `rules://41-idle-and-breathing`, `rules://42-walk-and-run`, `rules://43-jump-fall-land`, `rules://44-attacks-and-impacts` |
| Hair, capes, tails in motion; tiny movement | `rules://45-secondary-motion`, `rules://46-subpixel-animation` |
| Animals | `rules://50-quadrupeds`, `rules://51-animal-gaits`, `rules://52-birds-and-flight`, `rules://53-small-creatures` |
| Monsters | `rules://54-monster-design`, `rules://36-character-design` |
| Sky, landscape, a background | `rules://60-skies-and-atmosphere`, `rules://61-landscapes-and-terrain`, `rules://62-parallax-backgrounds` |
| Trees, water, ground | `rules://63-trees-and-foliage`, `rules://64-water`, `rules://65-ground-rocks-grass` |
| Tilesets, buildings, rooms | `rules://66-tiles-and-autotiling`, `rules://67-architecture-and-interiors` |
| Anything with depth: perspective, isometric, solid forms | `rules://70-perspective`, `rules://71-isometric`, `rules://72-3d-forms` |
| Items, weapons, vehicles, rotating objects | `rules://73-props-and-items`, `rules://74-vehicles-and-machines`, `rules://75-rotation-and-turnarounds` |
| Fire, smoke, magic, hits, particles, weather | `rules://80-vfx-fire-smoke-magic`, `rules://81-impacts-and-game-feel`, `rules://82-particles-and-weather` |
| UI, icons, text | `rules://83-ui-and-icons`, `rules://84-bitmap-fonts` |
| Colour, materials, light | `rules://20-color-for-pixel-art`, `rules://22-materials-hard`, `rules://23-materials-soft`, `rules://24-lighting-scenarios` |
| A retro platform look or a fixed palette | `rules://21-limited-and-platform-palettes`, `rules://90-platform-styles` |
| Line quality, AA, dithering, small sizes | `rules://10-lines-and-curves`, `rules://11-clusters-and-noise`, `rules://12-anti-aliasing`, `rules://13-dithering-and-texture`, `rules://14-readability-and-scale` |
| A whole scene | `rules://91-composition-and-scenes` |
| Review, or "it looks AI-made" | `rules://92-generated-art-tells`, `rules://07-review-checklist` |

## Specialists

Claude Code and omp ship four agents. Use them when the harness offers them;
elsewhere, run the matching skill yourself.

| Agent | Takes over | Instead of |
|-------|------------|------------|
| `palette-smith` | proposing and justifying a palette | `pixel-ai-artist:palette` |
| `rig-builder` | planning and building the layer rig | `pixel-ai-artist:rig` |
| `animation-director` | key poses, timing and tags before frames are drawn — and the storyboard panels for the concept prompt | the planning half of `pixel-ai-artist:animate` |
| `pixel-critic` | a scored, located critique; read-only | `pixel-ai-artist:review` |

Give an agent the brief, the PixelSpec if there is one, the document name and
the stage it owns — it starts with no memory of this conversation. Run agents
one at a time: they all edit the same document, and two at once will fight
over the active layer and frame.

## What this workflow must not do

- **Skip the brief on an open-ended request** to seem fast. Guessed size and
  palette cost a full redraw when they are wrong.
- **Skip the concept offer on something new** because drawing straight away
  looks faster. The user decides whether to generate references; you decide
  only how to phrase the prompt.
- **Pixelize a reference** — downscale it onto the canvas and call it art. It is
  a guide for shapes and poses; the pixels are still drawn.
- **Ask about things a default covers.** Light from the upper-left is not worth
  a round trip.
- **Declare done without `look` and a review.** A tool result saying pixels
  changed is not evidence the sprite is right.
- **Leave the user's document in a state they did not ask for** — stray scratch
  layers, a changed active frame, colours added to the palette without saying so.

## Related

`rules://index` for the craft every stage relies on, `rules://07-review-checklist`
for what "finished" means.
