/**
 * The typeface: a name that reaches CSS from a stranger's preset.
 *
 * Every card was set in Signika, Foundry's interface font — a ransom note, a telegram and
 * a terminal readout all looked like the settings dialog. A preset and a pin can now name
 * a face, and because a preset is pasted in from anywhere (DESIGN §7), the name has one
 * way in and one way out: the normaliser refuses anything that is not a plain family
 * name, and `fontStack` re-checks and quotes it on its way into the card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it.each([
    "Modesto Condensed",
    "Amiri",
    "IM Fell English SC",
    "Noto Sans JP",
    "d'Artagnan",
    "Special_Elite-2.0",
  ])("accepts the family name %s as it is", (name) => {
    expect(read(name)).toEqual({ value: name, warnings: [] });
  });

  it("accepts every generic family, matched as CSS matches the keyword", () => {
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

describe("fontStack — the one formatter", () => {
  it("expands a generic to a curated stack that ends on the keyword", () => {
    for (const generic of GENERIC_FAMILIES) {
      const stack = fontStack(generic)!;
      expect(stack.endsWith(`, ${generic}`)).toBe(true);
    }
    expect(fontStack("monospace")).toBe(
      `ui-monospace, "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace`
    );
  });

  it("quotes a registered face and falls back to the house stack, never the browser's", () => {
    expect(fontStack("Modesto Condensed")).toBe(`"Modesto Condensed", ${HOUSE_STACK}`);
  });

  it("re-checks what it is given: a name the normaliser would refuse is never emitted", () => {
    for (const value of HOSTILE) expect(fontStack(value), value).toBeNull();
  });

  it("is null for 'not chosen'", () => {
    for (const value of [null, undefined, "", "   "]) expect(fontStack(value)).toBeNull();
  });

  it("uses exactly the house stack card.css falls back to", () => {
    const css = readFileSync(join(ROOT, "styles", "card.css"), "utf8");
    expect(css).toContain(`font-family: var(--dp-font, ${HOUSE_STACK});`);
  });
});

describe("fontChoices", () => {
  it("offers the generics first, then the world's faces sorted and de-duplicated", () => {
    expect(fontChoices(["Signika", "Amiri", "Signika", "Bruno Ace"])).toEqual([
      ...GENERIC_FAMILIES,
      "Amiri",
      "Bruno Ace",
      "Signika",
    ]);
  });

  it("drops a registered name it could not emit, and one that spells a generic", () => {
    expect(fontChoices(['Evil"; }', "a,b", "Serif", 42, null, "Amiri"])).toEqual([
      ...GENERIC_FAMILIES,
      "Amiri",
    ]);
  });
});

describe("the picker's options", () => {
  const label = (name: string) => fontLabel(name, (key) => `[${key}]`);

  it("labels a generic by what it is for and a face by its own name", () => {
    expect(label("sans-serif")).toBe("[DP.font.sansSerif]");
    expect(label("monospace")).toBe("[DP.font.monospace]");
    expect(label("Amiri")).toBe("Amiri");
  });

  it("draws every option in its own face, escaped, with the empty choice first", () => {
    const markup = fontOptionsMarkup(fontChoices(["Amiri"]), "Amiri", "From the effect", label);
    expect(markup.startsWith('<option value="">From the effect</option>')).toBe(true);
    expect(markup).toContain(
      `<option value="Amiri" style="font-family:&quot;Amiri&quot;, &quot;Signika&quot;, ` +
        `&quot;Palatino Linotype&quot;, Palatino, Georgia, serif" selected>Amiri</option>`
    );
    expect(markup.match(/ selected/g)).toHaveLength(1);
  });

  it("keeps a stored face that is no longer on offer rather than showing 'not chosen'", () => {
    const markup = fontOptionsMarkup(fontChoices([]), "Retired Face", "From the effect", label);
    expect(markup).toContain('<option value="Retired Face"');
    expect(markup).toMatch(/value="Retired Face"[^>]* selected/);
    expect(markup).not.toMatch(/value="" selected/);
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
