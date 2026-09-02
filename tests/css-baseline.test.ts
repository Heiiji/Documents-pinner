/**
 * The stylesheets, against a stated browser baseline — and against themselves.
 *
 * `assets.test.ts` asks whether the module is namespaced and internally consistent. This
 * file asks two different questions, and they are the ones nothing could answer before:
 *
 *   1. Is every CSS construct in `styles/` inside the browsers this module CLAIMS?
 *      The module ships plain CSS with no build step, no autoprefixer and no browserslist,
 *      so nothing anywhere records what it needs — the answer lived in a comment naming
 *      one engine, and one of the features that comment cited as a justification is used
 *      nowhere.
 *   2. Does everything the effect emitter produces actually get used? Custom properties
 *      and data attributes were written onto every card and read by no rule, while
 *      comments elsewhere described them as the mechanism the module runs on. Rules for
 *      things that do not exist are worse than no rules: they make a reviewer believe a
 *      mechanism is in place.
 *
 * Nothing here is hard-coded to today's stylesheets. Every set is derived at test time
 * from the real emitter and the real files, so this keeps working as both change.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dressing } from "../src/effects/EffectRegistry";
import { presetToCssVars, presetToDataAttrs } from "../src/effects/preset-css";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";

const ROOT = join(import.meta.dirname, "..");

/**
 * The browsers this module supports, and why these numbers.
 *
 * Both numbers are the newest CSS feature the module actually uses, and this test found
 * one of them: the Chromium floor is **120**, not 117, because unprefixed `mask-image` is
 * what the torn and burnt silhouettes are made of and Chromium shipped CSS masking without
 * the `-webkit-` prefix in 120 — later than `@starting-style` and `transition-behavior`,
 * which are what set the Firefox floor at **129**. ESR 140 clears that; ESR 128 does not.
 *
 * Neither number constrains the desktop app, which is Electron 40 / Chromium 144. They
 * are for people who open the world in a browser.
 *
 * Safari is deliberately absent. Nobody has measured it since A17, and stating a number
 * nobody has run would be exactly the over-claim that amendment is about.
 */
const BASELINE = { chrome: 120, firefox: 129 };

/**
 * Every CSS construct this module uses, and the version each engine shipped it in.
 *
 * A construct found in the stylesheets and NOT listed here FAILS. That inverts the
 * maintenance burden on purpose: reaching for a new feature makes you record what it
 * costs, rather than silently widening the baseline and finding out from a user.
 */
const FEATURES: { name: string; test: RegExp; chrome: number; firefox: number }[] = [
  { name: "@layer", test: /@layer\b/, chrome: 99, firefox: 97 },
  { name: "@import … layer()", test: /@import[^;]*\blayer\(/, chrome: 99, firefox: 115 },
  { name: "@property", test: /@property\b/, chrome: 85, firefox: 128 },
  { name: "@starting-style", test: /@starting-style\b/, chrome: 117, firefox: 129 },
  { name: "@media", test: /@media\b/, chrome: 1, firefox: 1 },
  { name: "@keyframes", test: /@keyframes\b/, chrome: 43, firefox: 16 },
  {
    name: "transition-behavior",
    test: /allow-discrete|transition-behavior/,
    chrome: 117,
    firefox: 129,
  },
  { name: ":has()", test: /:has\(/, chrome: 105, firefox: 121 },
  { name: ":where()", test: /:where\(/, chrome: 88, firefox: 78 },
  { name: "nesting", test: /^\s*&[\s.:[>+~,{]/m, chrome: 112, firefox: 117 },
  { name: "color-mix()", test: /color-mix\(/, chrome: 111, firefox: 113 },
  { name: "content-visibility", test: /content-visibility\s*:/, chrome: 85, firefox: 125 },
  { name: "contain-intrinsic-size", test: /contain-intrinsic-size\s*:/, chrome: 83, firefox: 107 },
  {
    name: "individual transforms",
    test: /^\s*(translate|scale|rotate)\s*:/m,
    chrome: 104,
    firefox: 72,
  },
  {
    name: "logical properties",
    test: /(inline|block)-size\s*:|inset-(inline|block)/,
    chrome: 87,
    firefox: 66,
  },
  {
    name: "mask-image",
    test: /mask-image\s*:|mask-size\s*:|mask-repeat\s*:/,
    chrome: 120,
    firefox: 53,
  },
  { name: "mix-blend-mode", test: /mix-blend-mode\s*:/, chrome: 41, firefox: 32 },
  { name: "isolation", test: /isolation\s*:/, chrome: 41, firefox: 36 },
  { name: "gap in flexbox", test: /^\s*gap\s*:/m, chrome: 84, firefox: 63 },
  { name: "conic-gradient", test: /conic-gradient\(/, chrome: 69, firefox: 83 },
  { name: "backdrop-filter", test: /backdrop-filter\s*:/, chrome: 76, firefox: 103 },
  { name: "@container", test: /@container\b/, chrome: 105, firefox: 110 },
  {
    name: "scroll-driven animation",
    test: /animation-timeline|view-timeline|scroll\(|view\(/,
    chrome: 115,
    firefox: 999,
  },
  { name: "oklch()", test: /oklch\(/, chrome: 111, firefox: 113 },
  { name: "text-wrap: balance", test: /text-wrap\s*:/, chrome: 114, firefox: 121 },
  { name: "field-sizing", test: /field-sizing\s*:/, chrome: 123, firefox: 999 },
  {
    name: "anchor positioning",
    test: /anchor-name|position-anchor|anchor\(/,
    chrome: 125,
    firefox: 999,
  },
  { name: "element()", test: /\belement\(/, chrome: 999, firefox: 4 },
];

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * Comments stripped, always.
 *
 * Load-bearing: without it a property or an attribute passes this file's checks on the
 * strength of a comment saying it is dead, which is how `data-dp-fx` survived a rule
 * describing it as matched by nothing.
 */
const decomment = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

const FILES = cssFiles(join(ROOT, "styles"));
const CSS = decomment(FILES.map((f) => readFileSync(f, "utf8")).join("\n"));

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Every `--dp-*` the effect system writes onto a card, derived rather than listed.
 *
 * Both producers, because they emit different sets: `presetToCssVars` is the preset's own
 * parameters and `dressing` adds the procedural layers on top.
 */
function emittedVars(): string[] {
  const found = new Set<string>();
  for (const preset of CORE_PRESETS) {
    for (const key of Object.keys(presetToCssVars(preset))) found.add(key);
    const dressed = dressing({
      preset,
      intensity: 1,
      seed: 1,
      tier: "L2b",
      level: "full",
      baked: false,
    });
    for (const key of Object.keys(dressed.vars)) found.add(key);
  }
  return [...found].sort();
}

function emittedAttrs(): string[] {
  const found = new Set<string>();
  for (const preset of CORE_PRESETS) {
    for (const key of Object.keys(presetToDataAttrs(preset))) found.add(key);
  }
  return [...found].sort();
}

/**
 * Emitted, read by nothing, and kept on purpose — each with the reason.
 *
 * Every entry is ALSO asserted still to be unconsumed, so it cannot rot: the day
 * something starts reading one of these, the test fails on the stale entry and forces
 * the note to be removed rather than left describing a state that has passed.
 */
const UNCONSUMED_BY_DESIGN: Record<string, string> = {
  "--dp-warp": "warp has no rendition on any tier; it is in the schema and nothing draws it",
  "--dp-warp-dur": "as --dp-warp",
  "--dp-chroma-angle": "chroma is drawn as a horizontal text-shadow; the angle is unused",
  "--dp-edge-amt": "the amount is baked into the generated mask, not read at paint time",
  "data-dp-edge": "the edge SHAPE is the mask; the attribute is for a future selector",
  "data-dp-frame": "no frame style has a CSS rendition yet — see the AR family's own marks",
};

describe("the CSS baseline", () => {
  it("uses no construct that is newer than the browsers this module claims", () => {
    const tooNew = FEATURES.filter(
      (f) => f.test.test(CSS) && (f.chrome > BASELINE.chrome || f.firefox > BASELINE.firefox)
    ).map((f) => `${f.name} (chrome ${f.chrome}, firefox ${f.firefox})`);

    expect(
      tooNew,
      `these reach past the stated baseline (chrome ${BASELINE.chrome}, firefox ${BASELINE.firefox}).\n` +
        `Either raise BASELINE deliberately and say so in the README, or do not use them:\n` +
        tooNew.join("\n")
    ).toEqual([]);
  });

  it("recognises every at-rule and selector-level feature it finds", () => {
    // A cheap proxy for "did someone reach for something nobody priced": every at-rule in
    // the stylesheets must be one FEATURES knows about.
    const atRules = new Set([...CSS.matchAll(/@[a-z-]+/g)].map((m) => m[0]));
    const known = new Set(
      FEATURES.flatMap((f) => [...(f.name.match(/@[a-z-]+/g) ?? [])]).concat(["@charset"])
    );
    const unknown = [...atRules].filter((rule) => !known.has(rule));

    expect(
      unknown,
      `unknown CSS at-rules: add each to FEATURES with the version every engine shipped ` +
        `it in, or remove it.\n${unknown.join("\n")}`
    ).toEqual([]);
  });

  it("declares nested selectors as CSS, never as Sass", () => {
    // `&--modifier` is parent CONCATENATION, which native nesting does not have. The
    // whole rule is invalid and dropped, in every engine — three shipped selectors were
    // written that way and had never applied. Muscle memory; it will happen again.
    const sass = FILES.flatMap((file) => {
      const text = decomment(readFileSync(file, "utf8"));
      return [...text.matchAll(/^\s*&[^\s.:[>+~,{)]/gm)].map(
        (m) => `${file.slice(ROOT.length + 1)}: ${m[0].trim()}…`
      );
    });

    expect(
      sass,
      `Sass-style parent concatenation. Native nesting has no '&--suffix'; the selector ` +
        `is invalid and the rule is dropped. Write the class name out in full.\n${sass.join("\n")}`
    ).toEqual([]);
  });

  it("never uses backdrop-filter, which costs more than every effect combined", () => {
    // DESIGN §6.2. Over a WebGL canvas it forces a per-frame readback of the composited
    // backdrop.
    expect(CSS).not.toMatch(/backdrop-filter\s*:/);
  });

  it("never animates the generated textures' feTurbulence", () => {
    // DESIGN §6.2, asserted where the SVG is built rather than where it is used: animating
    // baseFrequency or seed is a full CPU-side filter re-evaluation every frame.
    const textures = readFileSync(join(ROOT, "src", "effects", "textures.ts"), "utf8");
    expect(textures).not.toContain("<animate");
  });
});

describe("what the effect system emits", () => {
  const SOURCES = tsFiles(join(ROOT, "src"))
    // The emitters themselves name every property they write, so including them would
    // make every property look consumed by definition.
    .filter((f) => !/preset-css\.ts$|EffectRegistry\.ts$/.test(f))
    .map((f) => decomment(readFileSync(f, "utf8")))
    .join("\n");

  it("has a consumer for every custom property it writes", () => {
    const orphans = emittedVars().filter(
      (name) =>
        !CSS.includes(`var(${name}`) &&
        !SOURCES.includes(`"${name}"`) &&
        !(name in UNCONSUMED_BY_DESIGN)
    );

    expect(
      orphans,
      `written onto every card and read by nothing — in CSS via var(), or in TypeScript ` +
        `by the Canvas2D baker. Either use it, delete it, or add it to ` +
        `UNCONSUMED_BY_DESIGN with the reason.\n${orphans.join("\n")}`
    ).toEqual([]);
  });

  it("has a selector for every data attribute it writes", () => {
    const orphans = emittedAttrs().filter(
      (name) => !CSS.includes(name) && !(name in UNCONSUMED_BY_DESIGN)
    );

    expect(
      orphans,
      `emitted onto every card and matched by no selector.\n${orphans.join("\n")}`
    ).toEqual([]);
  });

  it("keeps the allowlist honest: every entry is still unconsumed", () => {
    const stale = Object.keys(UNCONSUMED_BY_DESIGN).filter((name) =>
      name.startsWith("--")
        ? CSS.includes(`var(${name}`) || SOURCES.includes(`"${name}"`)
        : CSS.includes(name)
    );

    expect(
      stale,
      `these are listed as unconsumed and are now read. Delete the entry — the note ` +
        `describes a state that has passed.\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
