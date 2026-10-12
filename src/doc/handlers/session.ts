import { displayName, type Sprite } from "../model.js";
import type { HandlerTable } from "../studio.js";

const COLOR_MODE_NAMES = { rgb: "rgb", grayscale: "grayscale", indexed: "indexed" } as const;

/** The extension's sprite_summary: what list, site and every "which sprite" answer carry. */
export function spriteSummary(s: Sprite) {
  return {
    id: s.id,
    name: displayName(s),
    filename: s.filename ?? undefined,
    width: s.width,
    height: s.height,
    colorMode: COLOR_MODE_NAMES[s.colorMode],
    frames: s.frames.length,
    layers: s.layers.length,
  };
}

export const sessionHandlers: HandlerTable = {
  "session.site": (studio) => {
    const sprite = studio.activeSprite();
    return {
      sprite: sprite ? spriteSummary(sprite) : undefined,
      layer: sprite ? studio.resolveLayer(sprite).name : undefined,
      frame: sprite ? sprite.activeFrame : undefined,
      openSprites: studio.sprites().length,
    };
  },
};
