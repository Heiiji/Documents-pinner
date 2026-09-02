import { describe, expect, it } from "vitest";
import {
  BLEND_MODES,
  PRESET_SCHEMA_VERSION,
  defaultParams,
  defaultPreset,
  estimateCost,
  validatePreset,
  withComputedCost,
} from "../src/effects/preset-schema";
import {
  CORE_PRESETS,
  CORE_PRESET_IDS,
  DEFAULT_PRESET_ID,
  getCorePreset,
} from "../src/effects/presets/core-presets";

describe("the shipped library", () => {
  it("ships the documented presets", () => {
    expect(CORE_PRESET_IDS).toEqual([
      "none",
      "aged-parchment",
      "torn-edges",
      "sealed-and-wax",
      "bloodstained",
      "out-of-focus",
      "arcane-glow",
      "holographic-frame",
      "crt-scanlines",
      "glitch",
      "projected-readout",
      "tagged-object",
      "signal-loss",
    ]);
  });

  it("validates every shipped preset without a single warning or error", () => {
    for (const preset of CORE_PRESETS) {
      const r = validatePreset(preset);
      expect(r.errors, `${preset.id} errors`).toEqual([]);
      expect(r.warnings, `${preset.id} warnings`).toEqual([]);
      expect(r.preset).not.toBeNull();
    }
  });

  it("assigns each preset the cost tier it was designed for", () => {
    // Documents intent: if a parameter edit moves a preset across a tier boundary,
    // that is a deliberate decision and this test should be updated knowingly.
    const expected: Record<string, string> = {
      none: "low",
      "aged-parchment": "low",
      "torn-edges": "low",
      "sealed-and-wax": "low",
      bloodstained: "low",
      "out-of-focus": "low",
      "arcane-glow": "medium",
      "holographic-frame": "medium",
      "crt-scanlines": "medium",
      glitch: "high",
      // Derived, not chosen. `signal-loss` crosses 32 on its own arithmetic because it
      // is the only preset carrying four independent animations.
      "projected-readout": "medium",
      "tagged-object": "medium",
      "signal-loss": "high",
    };
    for (const preset of CORE_PRESETS) {
      expect(preset.cost, preset.id).toBe(expected[preset.id]);
    }
  });

  it("marks every static preset as motionless and every animated one as loop", () => {
    const animated = [
      "arcane-glow",
      "holographic-frame",
      "crt-scanlines",
      "glitch",
      "projected-readout",
      "tagged-object",
      "signal-loss",
    ];
    for (const p of CORE_PRESETS) {
      expect(p.motion, p.id).toBe(animated.includes(p.id) ? "loop" : "none");
    }
  });

  it("defaults to a cheap, static, always-readable preset", () => {
    const d = getCorePreset(DEFAULT_PRESET_ID);
    expect(d).toBeDefined();
    expect(d!.cost).toBe("low");
    expect(d!.motion).toBe("none");
  });

  it("is frozen against runtime mutation", () => {
    const p = CORE_PRESETS[1];
    expect(() => {
      (p.params as any).blur = 99;
    }).toThrow();
  });
});

describe("validatePreset", () => {
  it("rejects a non-object outright", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      const r = validatePreset(bad);
      expect(r.preset).toBeNull();
      expect(r.errors[0].key).toBe("DP.preset.error.notAnObject");
    }
  });

  it("rejects a missing or malformed id", () => {
    for (const id of [undefined, "", "Has Spaces", "UPPER!", "-leading", "x".repeat(80)]) {
      const r = validatePreset({ id });
      expect(r.preset, String(id)).toBeNull();
      expect(r.errors.map((e) => e.key)).toContain("DP.preset.error.badId");
    }
  });

  it("drops an unknown parameter with a warning rather than failing", () => {
    const r = validatePreset({ id: "x", params: { holoRainbow: 3, blur: 2 } });
    expect(r.preset).not.toBeNull();
    expect(r.preset!.params.blur).toBe(2);
    expect((r.preset!.params as any).holoRainbow).toBeUndefined();
    expect(r.warnings.map((w) => w.key)).toContain("DP.preset.warn.unknownParam");
  });

  it("warns about a preset authored by a future version but still loads it", () => {
    const r = validatePreset({ id: "x", schemaVersion: PRESET_SCHEMA_VERSION + 5 });
    expect(r.preset).not.toBeNull();
    expect(r.warnings.map((w) => w.key)).toContain("DP.preset.warn.futureVersion");
    expect(r.preset!.schemaVersion).toBe(PRESET_SCHEMA_VERSION);
  });

  it("clamps every numeric parameter into range", () => {
    const r = validatePreset({
      id: "x",
      params: {
        blur: 9999,
        tint: { amount: -3 },
        glow: { radius: -10, opacity: 5 },
        noise: { scale: 0 },
      },
    });
    const p = r.preset!.params;
    expect(p.blur).toBe(64);
    expect(p.tint.amount).toBe(0);
    expect(p.glow.radius).toBe(0);
    expect(p.glow.opacity).toBe(1);
    expect(p.noise.scale).toBe(0.1);
  });

  it("falls back on a malformed colour and says so", () => {
    const r = validatePreset({
      id: "x",
      params: { tint: { color: "red; background: url(evil)" } },
    });
    expect(r.preset!.params.tint.color).toBe(defaultParams().tint.color);
    expect(r.warnings.map((w) => w.key)).toContain("DP.preset.warn.badColour");
  });

  it("accepts every documented blend mode and rejects anything else", () => {
    for (const blend of BLEND_MODES) {
      expect(
        validatePreset({ id: "x", params: { tint: { blend } } }).preset!.params.tint.blend
      ).toBe(blend);
    }
    const r = validatePreset({ id: "x", params: { tint: { blend: "plaid" } } });
    expect(r.preset!.params.tint.blend).toBe("normal");
    expect(r.warnings.map((w) => w.key)).toContain("DP.preset.warn.badEnum");
  });

  it("marks imported presets as user-authored so they never masquerade as shipped", () => {
    expect(validatePreset({ id: "x", author: "core" }).preset!.author).toBe("core");
    expect(validatePreset({ id: "x" }).preset!.author).toBe("user");
  });

  it("recomputes cost rather than trusting what the file claimed", () => {
    const r = validatePreset({ id: "x", cost: "high", params: {} });
    expect(r.preset!.cost).toBe("low");
  });

  it("round-trips a shipped preset through JSON unchanged", () => {
    for (const preset of CORE_PRESETS) {
      const r = validatePreset(JSON.parse(JSON.stringify(preset)));
      expect(r.preset, preset.id).toEqual(preset);
    }
  });
});

describe("estimateCost", () => {
  it("scores an empty preset at zero", () => {
    expect(estimateCost(defaultPreset({ id: "z" })).score).toBe(0);
  });

  it("is monotonic in blur radius", () => {
    const at = (blur: number) => estimateCost(defaultPreset({ id: "z", params: { blur } })).score;
    expect(at(0)).toBeLessThan(at(4));
    expect(at(4)).toBeLessThan(at(16));
  });

  it("is monotonic in animation frequency", () => {
    const at = (hz: number) =>
      estimateCost(
        defaultPreset({
          id: "z",
          motion: "loop",
          params: { flicker: { amount: 0.5, hz } },
        })
      ).score;
    expect(at(1)).toBeLessThan(at(10));
  });

  it("charges for animation itself, not only for its rate", () => {
    const still = estimateCost(defaultPreset({ id: "z", motion: "none" })).score;
    const loop = estimateCost(defaultPreset({ id: "z", motion: "loop" })).score;
    expect(loop).toBeGreaterThan(still);
  });

  it("does not charge for a glow with zero opacity", () => {
    const invisible = defaultPreset({
      id: "z",
      params: { glow: { color: "#fff", radius: 40, opacity: 0, pulseHz: 0 } },
    });
    expect(estimateCost(invisible).score).toBe(0);
  });

  it("withComputedCost overwrites a wrong label", () => {
    const lying = defaultPreset({ id: "z", cost: "high" });
    expect(withComputedCost(lying).cost).toBe("low");
  });
});
