---
name: shade
title: Shade a sprite
description: Add light and shadow with proper hue shifting, one step at a time, so the sprite gains form without gaining the flat-luminance look that marks generated pixel art. Use when flat art needs volume.
---

# Shade a sprite

Flat shading — the same hue, darker — is the clearest signal that a sprite was
made by moving a brightness slider. Real shading shifts hue.

## The rule

- **Shadows** rotate toward blue/purple and desaturate slightly.
- **Highlights** rotate toward yellow/orange and saturate slightly.

`recolor` op `shade` implements this. Use it instead of choosing darker hex
values yourself.

## Procedure

1. **Fix the light direction** and state it. Upper-left is the safe default. It
   does not move again — not across the sprite, not across animation frames.

2. **Confirm the flat art is right first.** `look` op `preview`. Shading a bad
   silhouette wastes the effort.

3. **Give each material its steps in the palette** (see *Ramps* below). `recolor`
   snaps every colour it makes to the palette (`clampToPalette`, on by default):
   with no darker or lighter step there, a shaded colour snaps straight back to
   itself and the call answers `0 pixel(s) recoloured`. On a fixed palette whose
   steps you must not add to, pass `clampToPalette=false` and then add the new
   colours with `palette op="set"`, or draw the step by hand from the palette.

4. **One shadow step.** Select the region away from the light, then:

   ```
   select op="rect" rect={…}
   recolor op="shade" amount=-0.2 selectionOnly=true
   ```

   Or draw the shadow shape directly with `draw` if it needs to follow a form
   the selection tools cannot describe.

5. **Look.** `look op="preview"`. Does it read as volume, or as a stain? A
   shadow that follows the form's cross-section reads; one that follows the
   outline does not.

6. **One light step**, on the side facing the light: `amount=0.2`.

7. **Look again.** Most sprites are finished here.

8. **Only if it needs it**: a deep shadow (`amount=-0.4`) in occluded crevices,
   a specular highlight of one or two pixels on the hardest material, or
   reflected light — a faint cool step on the shadow side's outer edge, which
   makes metal read as metal.

## Ramps

If you will shade a material more than once, put its ramp in the palette:

```
palette op="ramp" base="#c04030" steps=5
```

Then draw with ramp entries directly. Reuse the darkest step across materials —
it ties a sprite together and costs no palette slots.

## Dithering

Only on 32px+ and only in large flat areas. Use `bayer4`, keep the two colours
adjacent in a ramp, and stop if it reads as noise. See
`rules://02-shading-and-light`.

## Checks

- Is the light in exactly one place?
- Do the shadows hue-shift, or are they the same hue darker?
- Any banding — long parallel stripes of adjacent steps?
- Any semi-transparent pixels? (`validate` will tell you.)

## Related

`rules://02-shading-and-light`, `rules://01-palette-and-color`,
`rules://22-materials-hard`, `rules://23-materials-soft`,
`rules://24-lighting-scenarios`, `rules://72-3d-forms`.
