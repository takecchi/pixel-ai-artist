# Layers and rigging

## Split before you animate, not after

Pixels baked into one layer cannot be animated without redrawing them. Separating
a finished sprite into limbs later is more work than building it separated. If
the sprite will ever move, rig it first.

## The standard character rig

Bottom to top in the layer stack, so nearer parts draw over farther ones:

```
  arm-near          ← the arm on the camera side
  leg-near
  head
  torso
  arm-far           ← partly hidden by the torso; this is what sells depth
  leg-far
  shadow            ← ground contact, if the style has one
```

Add `weapon`, `cape`, `hair-back` and `hair-front` as the design needs. Keep the
names stable — every later tool call refers to them by name.

Build the whole rig in one `layer` call with a `batch` array; it lands all or
nothing, in one round trip.

Give every layer a unique name. There are no layer groups to tell two `arm`s
apart, so a name two layers share is refused rather than guessed.

## Cels

A **cel** is one layer's image on one frame, with a position. Moving a limb
between frames is `cel` op `move` (cheap, lossless) rather than redrawing it.

A part that does not move in a cycle — a static torso under moving arms — is
`cel` op `copy` to every frame; each copy is its own image, so a later edit has
to be copied again.

## Non-destructive habits

- Keep a `reference` layer locked and semi-transparent while tracing; delete it
  before export.
- Keep sketch/blockout on its own layer until the clean pass is done.
- Never merge layers to "simplify" unless the user asked. The layer split is the
  sprite's editability.
- Hide layers rather than deleting them when trying an alternative.
