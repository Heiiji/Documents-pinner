/**
 * The typeface: a name that reaches CSS from a stranger's preset, and where it is kept.
 *
 * Every card was set in Signika, Foundry's interface font — a ransom note, a telegram and
 * a terminal readout all looked like the settings dialog. A preset and a pin can now name
 * a face, and because a preset is pasted in from anywhere (DESIGN §7), the name has one
 * way in and one way out: the normaliser refuses anything that is not a plain family
 * name, and `fontStack` re-checks and quotes it on its way into the card.
 *
 * The rule alone, then the pin payload, the preset and the card markup that carry it.
 * The resolver, the measure, the inliner and both Studios are driven in `typeface-world`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLAGS, MODULE_ID, SCHEMA_VERSION } from "../src/const";
import { planMigration } from "../src/data/migrations";
import { defaultPin, freezeMetrics, validatePin } from "../src/data/pin-schema";
import { PRESET_SCHEMA_VERSION, validatePreset } from "../src/effects/preset-schema";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";
import {
  FONT_NAME,
  GENERIC_FAMILIES,
  HOUSE_STACK,
  fontChoices,
  fontFamily,
  fontLabel,
  fontOptionsMarkup,
  fontStack,
} from "../src/effects/typeface";
import { cardHtml } from "../src/render/CardTemplate";
import type { DpNotice } from "../src/types/dp";

const ROOT = join(import.meta.dirname, "..");

/** Strings that must never reach a stylesheet, each one a different way out of a quote. */
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

describe("fontFamily", () => {
  const read = (value: unknown) => {
    const warnings: DpNotice[] = [];
    return { value: fontFamily(value, warnings, "display.font", "DP.pin.warn.badFont"), warnings };
  };

  it("accepts a family name as it is, and every generic as CSS matches the keyword", () => {
    for (const name of [
      "Modesto Condensed",
      "Amiri",
      "IM Fell English SC",
      "Noto Sans JP",
      "d'Artagnan",
      "Special_Elite-2.0",
    ]) {
      expect(read(name), name).toEqual({ value: name, warnings: [] });
    }
    for (const generic of GENERIC_FAMILIES) {
      expect(read(generic).value).toBe(generic);
      expect(read(generic.toUpperCase()).value).toBe(generic);
    }
  });

  it("reads null, undefined and an empty string as 'not chosen', silently", () => {
    for (const value of [null, undefined, ""])
      expect(read(value)).toEqual({ value: null, warnings: [] });
  });

  it.each(HOSTILE)("refuses %s with a warning", (value) => {
    const { value: out, warnings } = read(value);
    expect(out).toBeNull();
    expect(warnings).toEqual([
      { key: "DP.pin.warn.badFont", data: { path: "display.font", value: value.slice(0, 64) } },
    ]);
  });

  it("refuses a value that is not a string at all", () => {
    for (const value of [12, true, { family: "Arial" }, ["Arial"]]) {
      expect(read(value).value).toBeNull();
      expect(read(value).warnings).toHaveLength(1);
    }
  });
});

describe("FONT_NAME", () => {
  it("admits nothing that can end a quoted CSS string or open a token", () => {
    for (const ch of [
      `"`,
      "\\",
      ";",
      ",",
      "(",
      ")",
      "{",
      "}",
      "[",
      "]",
      ":",
      "/",
      "<",
      ">",
      "\n",
    ]) {
      expect(FONT_NAME.test(`A${ch}B`), JSON.stringify(ch)).toBe(false);
    }
  });
});

describe("fontStack — the one formatter", () => {
  it("expands a generic to a curated stack, and quotes a face over the house stack, never the browser's", () => {
    for (const generic of GENERIC_FAMILIES) {
      expect(fontStack(generic)!.endsWith(`, ${generic}`), generic).toBe(true);
    }
    expect(fontStack("monospace")).toBe(
      `ui-monospace, "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace`
    );
    expect(fontStack("Modesto Condensed")).toBe(`"Modesto Condensed", ${HOUSE_STACK}`);
  });

  it("uses exactly the house stack card.css falls back to", () => {
    const css = readFileSync(join(ROOT, "styles", "card.css"), "utf8");
    expect(css).toContain(`font-family: var(--dp-font, ${HOUSE_STACK});`);
  });
});

describe("the picker", () => {
  const label = (name: string) => fontLabel(name, (key) => `[${key}]`);

  it("offers the generics first, then the world's faces it can emit, sorted and de-duplicated", () => {
    expect(
      fontChoices([
        "Signika",
        "Amiri",
        "Signika",
        "Bruno Ace",
        'Evil"; }',
        "a,b",
        "Serif",
        42,
        null,
      ])
    ).toEqual([...GENERIC_FAMILIES, "Amiri", "Bruno Ace", "Signika"]);
  });

  it("draws every option in its own face, escaped, labelled by what a generic is for", () => {
    const markup = fontOptionsMarkup(fontChoices(["Amiri"]), "Amiri", "From the effect", label);
    expect(markup.startsWith('<option value="">From the effect</option>')).toBe(true);
    expect(markup).toContain(
      `<option value="Amiri" style="font-family:&quot;Amiri&quot;, &quot;Signika&quot;, ` +
        `&quot;Palatino Linotype&quot;, Palatino, Georgia, serif" selected>Amiri</option>`
    );
    expect(markup.match(/ selected/g)).toHaveLength(1);
    // A key has no hyphen: `sans-serif` is labelled by `DP.font.sansSerif`.
    expect(markup).toContain(">[DP.font.sansSerif]</option>");
  });

  it("keeps a stored face that is no longer on offer rather than showing 'not chosen'", () => {
    const markup = fontOptionsMarkup(fontChoices([]), "Retired Face", "From the effect", label);
    expect(markup).toMatch(/value="Retired Face"[^>]* selected/);
    expect(markup).not.toMatch(/value="" selected/);
  });
});

describe("the pin payload", () => {
  const withFont = (font: unknown) =>
    validatePin({ ...defaultPin(), display: { ...defaultPin().display, font } });

  it("keeps a valid face, and refuses a hostile one with the pin's own warning", () => {
    expect(withFont("Amiri").pin.display.font).toBe("Amiri");
    expect(withFont("monospace").pin.display.font).toBe("monospace");
    const { pin, warnings } = withFont('Arial"; }');
    expect(pin.display.font).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("DP.pin.warn.badFont");
  });

  /** Version 5 added a pin's own face and its own reveal sound; `null` is "the preset's". */
  it("reads a version 4 payload with neither of its own, and migrates it once", () => {
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
    delete v4.effect.revealSound;

    const { pin, warnings } = validatePin(v4);
    expect(SCHEMA_VERSION).toBe(5);
    expect(pin.v).toBe(SCHEMA_VERSION);
    expect(pin.display.font).toBeNull();
    expect(pin.effect.revealSound).toBeNull();
    expect(warnings).toEqual([]);

    const tile = (payload: unknown) => ({
      id: "a",
      x: 0,
      y: 0,
      width: 400,
      height: 560,
      rotation: 0,
      flags: { [MODULE_ID]: { [FLAGS.PIN]: payload } },
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

  it("keeps a valid face, and refuses a hostile one with the preset's own warning", () => {
    expect(withFamily("IM Fell English").preset!.params.type.family).toBe("IM Fell English");
    const { preset, warnings } = withFamily("a,b");
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
      if (family !== null) expect(GENERIC_FAMILIES).toContain(family);
    }
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

  it("carries the face as a quoted stack after the effect's own properties, and none of the house's", () => {
    const html = card({ font: "Special Elite", effectStyle: "--dp-i:1" });
    const style = /style="([^"]*)"/.exec(html)![1];
    expect(style).toContain(
      "--dp-font:&quot;Special Elite&quot;, &quot;Signika&quot;, &quot;Palatino Linotype&quot;"
    );
    expect(style.indexOf("--dp-font")).toBeGreaterThan(style.indexOf("--dp-i:1"));

    expect(card()).not.toContain("--dp-font");
    expect(card({ font: null })).not.toContain("--dp-font");
  });

  it("emits nothing for a name handed to it unvalidated", () => {
    for (const font of HOSTILE) expect(card({ font }), font).not.toContain("--dp-font");
  });
});
