/**
 * The typeface in the data and on the card: the pin payload, the preset, the shipped
 * library and the markup a card is drawn from.
 *
 * Deliberately imports nothing from `typeface.ts`: every expectation is written out, so
 * against the code before the typeface existed these fail on what they assert rather
 * than on a missing module.
 */
import { describe, expect, it } from "vitest";
import { FLAGS, MODULE_ID, SCHEMA_VERSION } from "../src/const";
import { planMigration } from "../src/data/migrations";
import { defaultPin, freezeMetrics, validatePin } from "../src/data/pin-schema";
import { dressing } from "../src/effects/EffectRegistry";
import { presetToCssVars } from "../src/effects/preset-css";
import { PRESET_SCHEMA_VERSION, validatePreset } from "../src/effects/preset-schema";
import { CORE_PRESETS, getCorePreset } from "../src/effects/presets/core-presets";
import { cardHtml } from "../src/render/CardTemplate";

/** The same hostile names as `typeface.test.ts`, written out rather than shared. */
const HOSTILE = [
  'Arial"; } .dp-card { background: url(//evil.example/x)',
  "a,b",
  "Arial; color: red",
  "Comic Sans\\",
  "x{y}",
  "local(Arial)",
  "a:b",
  "fonts/evil",
  "x".repeat(65),
];

const GENERICS = ["serif", "sans-serif", "monospace", "cursive"];

/** `fontStack("monospace")` as it appears inside a style attribute. */
const MONOSPACE_ATTR =
  "--dp-font:ui-monospace, &quot;Cascadia Mono&quot;, Consolas, Menlo, " +
  "&quot;DejaVu Sans Mono&quot;, monospace";

describe("the pin payload", () => {
  const withFont = (font: unknown) =>
    validatePin({ ...defaultPin(), display: { ...defaultPin().display, font } });

  it("stores a valid face and the generics", () => {
    expect(withFont("Amiri").pin.display.font).toBe("Amiri");
    expect(withFont("monospace").pin.display.font).toBe("monospace");
  });

  it("refuses a hostile face with the pin's own warning, and lets the preset decide", () => {
    const { pin, warnings } = withFont('Arial"; }');
    expect(pin.display.font).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("DP.pin.warn.badFont");
  });

  it("reads a version 4 payload as version 5 already would, with no face of its own", () => {
    const v4: any = { ...defaultPin(), v: 4, display: { ...defaultPin().display } };
    delete v4.display.font;
    const { pin, warnings } = validatePin(v4);
    expect(pin.v).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5);
    expect(pin.display.font).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("migrates a version 4 payload once, and the second pass has nothing to do", () => {
    const current = freezeMetrics(
      validatePin({
        ...defaultPin(),
        source: { ...defaultPin().source, uuid: "JournalEntry.abc" },
      }).pin,
      { width: 400, height: 560 }
    );
    const v4: any = structuredClone(current);
    v4.v = 4;
    delete v4.display.font;
    const tile = (pin: unknown) => ({
      id: "a",
      x: 0,
      y: 0,
      width: 400,
      height: 560,
      rotation: 0,
      flags: { [MODULE_ID]: { [FLAGS.PIN]: pin } },
    });

    const [update] = planMigration([tile(v4)]);
    const migrated: any = update[`flags.${MODULE_ID}.${FLAGS.PIN}`];
    expect(migrated.v).toBe(5);
    expect(migrated.display.font).toBeNull();
    expect(planMigration([tile(migrated)])).toEqual([]);
  });
});

describe("the preset", () => {
  const withFamily = (family: unknown) =>
    validatePreset({ id: "mine", params: { type: { family } } });

  it("is schema 3, and a preset without a face reads as the card's own", () => {
    expect(PRESET_SCHEMA_VERSION).toBe(3);
    const { preset, warnings } = validatePreset({ id: "old", schemaVersion: 2 });
    expect(preset!.params.type).toEqual({ family: null });
    expect(warnings).toEqual([]);
  });

  it("keeps a valid face", () => {
    expect(withFamily("IM Fell English").preset!.params.type.family).toBe("IM Fell English");
  });

  it.each(HOSTILE)("refuses %s with the preset's own warning", (family) => {
    const { preset, warnings } = withFamily(family);
    expect(preset!.params.type.family).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("DP.preset.warn.badFont");
  });

  it("sets the shipped presets in generic families only, the ones each look calls for", () => {
    const families = Object.fromEntries(CORE_PRESETS.map((p) => [p.id, p.params.type.family]));
    expect(families).toMatchObject({
      "crt-scanlines": "monospace",
      "projected-readout": "monospace",
      "tagged-object": "monospace",
      "signal-loss": "monospace",
      "aged-parchment": "serif",
      "sealed-and-wax": "serif",
      none: null,
      glitch: null,
    });
    for (const family of Object.values(families)) {
      if (family !== null) expect(GENERICS).toContain(family);
    }
  });

  it("is not an effect variable: the dressing never carries it", () => {
    const crt = getCorePreset("crt-scanlines")!;
    expect(Object.keys(presetToCssVars(crt))).not.toContain("--dp-font");
  });
});

describe("the card", () => {
  const card = (over: Record<string, unknown> = {}) =>
    cardHtml({
      title: "Telegram",
      bodyHtml: "<p>STOP</p>",
      showTitle: true,
      paper: "parchment",
      fontPx: 14,
      padPx: 20,
      effectId: "crt-scanlines",
      ...over,
    });

  it("carries the face as a quoted stack, after the effect's own properties", () => {
    const html = card({ font: "Special Elite", effectStyle: "--dp-i:1" });
    const style = /style="([^"]*)"/.exec(html)![1];
    expect(style).toContain(
      "--dp-font:&quot;Special Elite&quot;, &quot;Signika&quot;, &quot;Palatino Linotype&quot;"
    );
    expect(style.indexOf("--dp-font")).toBeGreaterThan(style.indexOf("--dp-i:1"));
  });

  it("carries nothing for the house face", () => {
    expect(card()).not.toContain("--dp-font");
    expect(card({ font: null })).not.toContain("--dp-font");
  });

  it("emits nothing for a name handed to it unvalidated", () => {
    for (const font of HOSTILE) expect(card({ font }), font).not.toContain("--dp-font");
  });

  it("keeps its face where the dressing drops every effect variable", () => {
    const preset = getCorePreset("crt-scanlines")!;
    for (const [tier, level] of [
      ["L2b", "off"],
      ["L1", "full"],
      ["L2b", "reduced"],
    ] as const) {
      const dressed = dressing({ preset, intensity: 1, seed: 1, tier, level, baked: false });
      const html = card({
        font: preset.params.type.family,
        effectStyle: dressed.style,
        effectAttrs: dressed.attrs,
      });
      expect(html, `${tier} ${level}`).toContain(MONOSPACE_ATTR);
    }
  });
});
