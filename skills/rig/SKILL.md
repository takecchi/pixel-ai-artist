---
name: rig
title: Rig a character for animation
description: Split a character onto named layers — head, torso, arms, legs — so it can be animated by moving cels instead of redrawing pixels. Use before animating anything, or when limbs are baked into one layer.
---

# Rig a character for animation

Pixels baked into a single layer cannot be animated without redrawing them. Rig
first; separating a finished sprite later is more work than building it split.

## The standard rig

Top of the stack first, so nearer parts draw over farther ones (`sprite_info`
and `layer op="list"` list the same stack the other way up, bottom first):

```
arm-near     ← camera-side arm
leg-near
head
torso
arm-far      ← partly hidden by the torso; this is what sells depth
leg-far
shadow       ← ground contact, if the style has one
```

Add `weapon`, `cape`, `hair-front`, `hair-back` as the design needs. Keep names
stable — every later call refers to them by name.

Every layer has its own name: `layer` refuses to create or rename a layer to a
name another layer already has. Name twins by side (`arm-near`, `arm-far`),
never two `arm`s.

## Building it fresh

A new sprite starts with one empty layer, `Layer 1`. Rename it to the bottom
part rather than leaving it empty under the rig — `validate` flags an empty
layer on every run. One batch, applied all or nothing:

```
layer batch=[
  {op:"rename", name:"Layer 1", newName:"shadow"},
  {op:"create", name:"leg-far"},
  {op:"create", name:"arm-far"},
  {op:"create", name:"torso"},
  {op:"create", name:"head"},
  {op:"create", name:"leg-near"},
  {op:"create", name:"arm-near"},
]
```

Then draw each part on its own layer from the start.

## Splitting an existing sprite

When the art is already baked into one layer:

1. `sprite_info` to see what you have, and `look op="ascii"` to find exact part
   boundaries. Guessing at coordinates here is how limbs get clipped.
2. Create the rig layers (above).
3. For each part, in one `draw` call per target layer:
   ```
   draw layer="head" ops=[{ kind:"blit", fromLayer:"Layer 1", from:{x:12,y:4,width:8,height:8}, to:{x:12,y:4} }]
   ```
   `fromLayer` names the baked layer to copy from. Leave it out and `blit`
   reads the layer it is drawing on — an empty new layer — and copies nothing.
   `skipTransparent` keeps the copy clean.
4. Clear the copied region from the original layer, or rename the original to
   `flat-original` and hide it. **Prefer hiding** — if a boundary was wrong you
   want the original still there.
5. `look op="preview"` with the original hidden. The sprite should look
   unchanged. If a limb lost pixels, the boundary was wrong.

## Overlap matters

A limb needs a pixel or two of overlap with the torso, or a gap appears the
moment it rotates. Copy generously and let the stacking order hide the excess.

## Then

`pixel-ai-artist:animate`.

## Related

`rules://06-layers-and-rigging`, `rules://03-silhouette-and-form`,
`rules://31-anatomy-and-pose` for where the joints really are.
