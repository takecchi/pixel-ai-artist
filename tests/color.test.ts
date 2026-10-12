import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  asepriteBestFit,
  buildRamp,
  contrastRatio,
  deltaE,
  hueShiftShade,
  parseHex,
  rgbToHsl,
  rgbToLab,
  snapToPalette,
  toHex,
} from "../dist/lib/color.js";
import { presets } from "../dist/lib/palettes.js";

test("parseHex accepts both lengths and rejects junk", () => {
  assert.deepEqual(parseHex("#ff004d"), { r: 255, g: 0, b: 77, a: 255 });
  assert.deepEqual(parseHex("ff004d80"), { r: 255, g: 0, b: 77, a: 128 });
  assert.throws(() => parseHex("#xyz"), /Invalid colour/);
});

test("toHex drops alpha unless asked and it matters", () => {
  assert.equal(toHex({ r: 255, g: 0, b: 77, a: 255 }, true), "#ff004d");
  assert.equal(toHex({ r: 255, g: 0, b: 77, a: 128 }, true), "#ff004d80");
  assert.equal(toHex({ r: 255, g: 0, b: 77, a: 128 }, false), "#ff004d");
});

test("CIELAB puts pure white and black at the ends of the L axis", () => {
  assert.ok(Math.abs(rgbToLab(parseHex("#ffffff")).l - 100) < 0.5);
  assert.ok(Math.abs(rgbToLab(parseHex("#000000")).l) < 0.5);
});

test("deltaE is zero for identical colours and grows with difference", () => {
  const red = rgbToLab(parseHex("#ff0000"));
  const nearRed = rgbToLab(parseHex("#fe0101"));
  const blue = rgbToLab(parseHex("#0000ff"));
  assert.equal(deltaE(red, red), 0);
  assert.ok(deltaE(red, nearRed) < 2);
  assert.ok(deltaE(red, blue) > 100);
});

test("snapToPalette picks the perceptually nearest entry, not the RGB-nearest", () => {
  // Classic case: RGB distance overweights green, so a dark olive can look
  // closer to a saturated green than to the grey a human would pick.
  const palette = ["#000000", "#808080", "#00ff00", "#ffffff"];
  const snapped = snapToPalette(parseHex("#7a7a7a"), palette);
  assert.equal(snapped.hex, "#808080");
  assert.ok(snapped.distance < 5);
});

test("snapToPalette refuses an empty palette rather than guessing", () => {
  assert.throws(() => snapToPalette(parseHex("#ffffff"), []), /empty/i);
});

test("shading a colour darker also cools its hue", () => {
  const base = parseHex("#c04030"); // warm red
  const shadow = hueShiftShade(base, { amount: -0.4 });
  const light = hueShiftShade(base, { amount: 0.4 });

  assert.ok(rgbToLab(shadow).l < rgbToLab(base).l, "shadow should be darker");
  assert.ok(rgbToLab(light).l > rgbToLab(base).l, "highlight should be lighter");
  // Cooling means the blue channel loses less than the red channel does.
  const redDrop = base.r - shadow.r;
  const blueDrop = base.b - shadow.b;
  assert.ok(redDrop > blueDrop, `expected red to fall faster than blue (${redDrop} vs ${blueDrop})`);
});

test("shading pulls hues toward blue in shadow and yellow in light, whichever side of the wheel they start on", () => {
  // A fixed rotation direction passes for some hues and inverts others: red
  // shadows went orange. Check hues on both sides of the shadow and light targets.
  const arcTo = (from: number, to: number) => Math.abs(((((to - from) % 360) + 540) % 360) - 180);

  for (const hex of ["#c04030", "#40a040", "#8040c0", "#3050c0", "#c0a030"]) {
    const base = parseHex(hex);
    const h = rgbToHsl(base).h;
    const shadow = rgbToHsl(hueShiftShade(base, { amount: -0.4 })).h;
    const light = rgbToHsl(hueShiftShade(base, { amount: 0.4 })).h;
    assert.ok(arcTo(shadow, 240) < arcTo(h, 240), `${hex} shadow should move toward blue`);
    if (arcTo(h, 60) > 1) assert.ok(arcTo(light, 60) < arcTo(h, 60), `${hex} highlight should move toward yellow`);
  }
});

test("buildRamp centres on the base colour and returns the requested length", () => {
  const ramp = buildRamp(parseHex("#c04030"), 5);
  assert.equal(ramp.length, 5);
  const lightness = ramp.map((hex) => rgbToLab(parseHex(hex)).l);
  for (let i = 1; i < lightness.length; i++) {
    assert.ok(lightness[i]! > lightness[i - 1]!, "ramp must increase in lightness");
  }
  assert.throws(() => buildRamp(parseHex("#000000"), 1), /at least 2/);
});

test("contrastRatio matches the WCAG extremes", () => {
  assert.ok(Math.abs(contrastRatio(parseHex("#ffffff"), parseHex("#000000")) - 21) < 0.01);
  assert.equal(contrastRatio(parseHex("#777777"), parseHex("#777777")), 1);
});

test("asepriteBestFit weighs 5-bit channels as Aseprite does, which can differ from the perceptual pick", () => {
  const palette = ["#3c3c3c", "#ff6a00"];
  assert.equal(asepriteBestFit(parseHex("#780000"), palette.map(parseHex)), 0);
  assert.equal(snapToPalette(parseHex("#780000"), palette).index, 1);
});

test("asepriteBestFit sends an off-palette near-white to DawnBringer 32's white", () => {
  const db32 = presets()["dawnbringer-32"]!.colors;
  const index = asepriteBestFit(parseHex("#fff1e8"), db32.map(parseHex));
  assert.equal(db32[index], "#ffffff");
});

test("asepriteBestFit takes the first entry equal at 5 bits, and the first of equally near ones", () => {
  assert.equal(asepriteBestFit(parseHex("#ff0000"), ["#000000", "#f80000", "#ff0000"].map(parseHex)), 1);
  assert.equal(asepriteBestFit(parseHex("#808080"), ["#707070", "#707070"].map(parseHex)), 0);
});

test("asepriteBestFit compares alpha too, and looks at no more than 256 entries", () => {
  assert.equal(asepriteBestFit(parseHex("#ff000080"), ["#ff0000ff", "#ff000080"].map(parseHex)), 1);
  const palette = [...Array.from({ length: 256 }, () => parseHex("#000000")), parseHex("#ffffff")];
  assert.equal(asepriteBestFit(parseHex("#ffffff"), palette), 0);
});

test("asepriteBestFit refuses an empty palette", () => {
  assert.throws(() => asepriteBestFit(parseHex("#ffffff"), []), /empty/);
});
