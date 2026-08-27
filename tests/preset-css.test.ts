import { describe, expect, it } from "vitest";
import { defaultPreset } from "../src/effects/preset-schema";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";
import {
  VAR_PREFIX,
  disabledCssVars,
  presetToCssVars,
  presetToDataAttrs,
  reduceCssVars,
  safeUrl,
} from "../src/effects/preset-css";

describe("presetToCssVars", () => {
  it("emits only namespaced custom properties", () => {
    for (const preset of CORE_PRESETS) {
      for (const key of Object.keys(presetToCssVars(preset))) {
        expect(key.startsWith(VAR_PREFIX), `${preset.id} -> ${key}`).toBe(true);
      }
    }
  });

  it("emits string values only, never undefined or NaN", () => {
    for (const preset of CORE_PRESETS) {
      for (const [k, v] of Object.entries(presetToCssVars(preset))) {
        expect(typeof v, `${preset.id} ${k}`).toBe("string");
        expect(v, `${preset.id} ${k}`).not.toMatch(/NaN|undefined|null/);
      }
    }
  });

  it("passes intensity through as --dp-i without pre-multiplying anything else", () => {
    const preset = defaultPreset({ id: "z", params: { blur: 8 } });
    const full = presetToCssVars(preset, 1);
    const half = presetToCssVars(preset, 0.5);

    expect(full["--dp-i"]).toBe("1");
    expect(half["--dp-i"]).toBe("0.5");
    // The base value is identical; only the multiplier moved. That is what makes the
    // intensity slider a single custom-property write.
    expect(half["--dp-blur"]).toBe(full["--dp-blur"]);
  });

  it("clamps a nonsensical intensity", () => {
    const p = defaultPreset({ id: "z" });
    expect(presetToCssVars(p, -5)["--dp-i"]).toBe("0");
    expect(presetToCssVars(p, 99)["--dp-i"]).toBe("1");
    expect(presetToCssVars(p, NaN)["--dp-i"]).toBe("1");
  });

  it("converts frequencies to durations and zero to a disabled animation", () => {
    const p = defaultPreset({
      id: "z",
      params: { flicker: { amount: 0.5, hz: 4 }, glow: { color: "#fff", radius: 1, opacity: 1, pulseHz: 0 } },
    });
    const vars = presetToCssVars(p);
    expect(vars["--dp-flicker-dur"]).toBe("0.25s");
    expect(vars["--dp-glow-dur"]).toBe("0s");
  });

  it("derives the scanline travel duration from spacing and speed", () => {
    const p = defaultPreset({
      id: "z",
      params: { scanlines: { spacing: 6, opacity: 0.5, speedPxPerSec: 12 } },
    });
    expect(presetToCssVars(p)["--dp-scan-dur"]).toBe("0.5s");
  });

  it("treats a negative scanline speed as a positive duration", () => {
    const p = defaultPreset({
      id: "z",
      params: { scanlines: { spacing: 6, opacity: 0.5, speedPxPerSec: -12 } },
    });
    expect(presetToCssVars(p)["--dp-scan-dur"]).toBe("0.5s");
  });

  it("flags motion only for looping presets", () => {
    expect(presetToCssVars(defaultPreset({ id: "z", motion: "loop" }))["--dp-motion"]).toBe("1");
    expect(presetToCssVars(defaultPreset({ id: "z", motion: "none" }))["--dp-motion"]).toBe("0");
    expect(presetToCssVars(defaultPreset({ id: "z", motion: "onReveal" }))["--dp-motion"]).toBe("0");
  });
});

describe("safeUrl", () => {
  it("wraps a plain asset path", () => {
    expect(safeUrl("papers/parchment-01.webp")).toBe('url("papers/parchment-01.webp")');
  });

  it("returns none for an absent texture", () => {
    expect(safeUrl(null)).toBe("none");
    expect(safeUrl("")).toBe("none");
  });

  it("refuses anything that could break out of the url token", () => {
    const attacks = [
      'x.webp"); background: url("evil',
      "x.webp'); color: red; --a: (",
      "x.webp) ; }",
      "javascript:alert(1)",
      "url(evil)",
      "a\\22 b.webp",
      "has space.webp",
      "a;b.webp",
      "a{b}.webp",
    ];
    for (const a of attacks) {
      expect(safeUrl(a), a).toBe("none");
    }
  });

  it("never lets a hostile preset reach CSS through the surface texture", () => {
    const evil = defaultPreset({
      id: "z",
      params: { surface: { texture: '");}html{display:none', blend: "normal", opacity: 1 } },
    });
    expect(presetToCssVars(evil)["--dp-surface-img"]).toBe("none");
  });
});

describe("presetToDataAttrs", () => {
  it("exposes the variants CSS cannot select through a custom property", () => {
    const attrs = presetToDataAttrs(CORE_PRESETS.find((p) => p.id === "holographic-frame")!);
    expect(attrs).toEqual({
      "data-dp-preset": "holographic-frame",
      "data-dp-edge": "none",
      "data-dp-frame": "holo",
      "data-dp-motion": "loop",
    });
  });
});

describe("accessibility renditions", () => {
  it("reduced keeps static identity but stops every animation", () => {
    const holo = CORE_PRESETS.find((p) => p.id === "holographic-frame")!;
    const full = presetToCssVars(holo);
    const reduced = reduceCssVars(full);

    // Identity survives: this is the whole point of the setting.
    expect(reduced["--dp-tint"]).toBe(full["--dp-tint"]);
    expect(reduced["--dp-frame"]).toBe(full["--dp-frame"]);
    expect(reduced["--dp-surface-img"]).toBe(full["--dp-surface-img"]);
    expect(reduced["--dp-glow-r"]).toBe(full["--dp-glow-r"]);

    // Motion does not.
    expect(reduced["--dp-motion"]).toBe("0");
    for (const [k, v] of Object.entries(reduced)) {
      if (k.endsWith("-dur")) expect(v, k).toBe("0s");
    }
    expect(reduced["--dp-chroma"]).toBe("0px");
    expect(reduced["--dp-warp"]).toBe("0");
  });

  it("reduced never turns a preset into a blank card", () => {
    for (const preset of CORE_PRESETS) {
      if (preset.id === "none") continue;
      const reduced = reduceCssVars(presetToCssVars(preset));
      const identity =
        Number(reduced["--dp-tint-amt"]) +
        Number(reduced["--dp-surface-op"]) +
        parseFloat(reduced["--dp-frame-w"]) +
        Number(reduced["--dp-edge-amt"]) +
        Number(reduced["--dp-glow-op"]) +
        // Static noise and static scanlines are texture, not motion: reduced keeps them.
        Number(reduced["--dp-noise"]) +
        Number(reduced["--dp-scan-op"]) +
        parseFloat(reduced["--dp-blur"]);
      expect(identity, preset.id).toBeGreaterThan(0);
    }
  });

  it("off collapses to nothing at all", () => {
    expect(disabledCssVars()).toEqual({ "--dp-i": "0", "--dp-motion": "0" });
  });

  it("does not mutate the vars it reduces", () => {
    const vars = presetToCssVars(CORE_PRESETS[9]);
    const snapshot = JSON.stringify(vars);
    reduceCssVars(vars);
    expect(JSON.stringify(vars)).toBe(snapshot);
  });
});
