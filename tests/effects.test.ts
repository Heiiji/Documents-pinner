import { describe, expect, it } from "vitest";
import {
  dressing,
  resolveAutoLevel,
  toStyle,
  type EffectContext,
} from "../src/effects/EffectRegistry";
import { CORE_PRESETS, getCorePreset } from "../src/effects/presets/core-presets";
import {
  edgeMaskDataUri,
  grainDataUri,
  scanlineGradient,
  stainDataUri,
} from "../src/effects/textures";

const context = (over: Partial<EffectContext> = {}): EffectContext => ({
  preset: getCorePreset("aged-parchment")!,
  intensity: 1,
  seed: 42,
  tier: "L2b",
  level: "full",
  baked: false,
  ...over,
});

describe("textures", () => {
  it("generates data URIs, which are the only thing the rasteriser can load", () => {
    expect(grainDataUri()).toMatch(/^data:image\/svg\+xml,/);
    expect(stainDataUri()).toMatch(/^data:image\/svg\+xml,/);
    expect(edgeMaskDataUri("torn", 0.8)).toMatch(/^url\('data:image\/svg\+xml,/);
  });

  it("wraps a mask in single quotes, so it survives a double-quoted style attribute", () => {
    const mask = edgeMaskDataUri("torn", 0.8);
    expect(mask).not.toContain('"');
    expect(mask.endsWith("')")).toBe(true);
  });

  it("percent-encodes the characters a data URI cannot carry raw", () => {
    const uri = grainDataUri();
    expect(uri).not.toContain("<");
    expect(uri).not.toContain(">");
    expect(uri).not.toContain('"');
    expect(uri).not.toContain(" ");
    expect(uri).toContain("%3Csvg");
  });

  it("is deterministic, so every client's grain lands on the same pixels", () => {
    expect(grainDataUri({ seed: 7 })).toBe(grainDataUri({ seed: 7 }));
    expect(grainDataUri({ seed: 7 })).not.toBe(grainDataUri({ seed: 8 }));
  });

  it("uses feTurbulence statically only — no SMIL, nothing to re-evaluate per frame", () => {
    // Static attributes such as feColorMatrix's `values` are fine; what is banned is
    // anything that would make the browser recompute the filter on a timeline.
    for (const uri of [grainDataUri(), stainDataUri(), edgeMaskDataUri("torn", 1)]) {
      const decoded = decodeURIComponent(uri);
      expect(decoded).toContain("feTurbulence");
      expect(decoded).not.toContain("<animate");
      expect(decoded).not.toContain("<set");
      expect(decoded).not.toContain("dur=");
    }
  });

  it("coarsens the grain as the scale grows", () => {
    const fine = decodeURIComponent(grainDataUri({ scale: 0.5 }));
    const coarse = decodeURIComponent(grainDataUri({ scale: 4 }));
    const freq = (s: string) => Number(/baseFrequency="([\d.]+)"/.exec(s)?.[1]);
    expect(freq(coarse)).toBeLessThan(freq(fine));
  });

  it("returns none for an edge that is not shaped, rather than an empty mask", () => {
    expect(edgeMaskDataUri("none", 1)).toBe("none");
    expect(edgeMaskDataUri("torn", 0)).toBe("none");
  });

  it("gives each edge style a physically different profile", () => {
    const scale = (style: any) =>
      Number(/scale="([\d.]+)"/.exec(decodeURIComponent(edgeMaskDataUri(style, 1)))?.[1]);
    expect(scale("torn")).toBeGreaterThan(scale("deckled"));
    expect(scale("burnt")).toBeGreaterThan(scale("singed"));
  });

  it("clamps a hostile colour out of the stain rather than interpolating it", () => {
    const uri = decodeURIComponent(stainDataUri({ color: "red;}html{display:none" }));
    expect(uri).toContain("#6b1c12");
    expect(uri).not.toContain("display:none");
  });

  it("emits scanlines as a gradient, and nothing at all when they are off", () => {
    expect(scanlineGradient(3, 0.2)).toContain("repeating-linear-gradient");
    expect(scanlineGradient(3, 0)).toBe("none");
  });
});

describe("dressing", () => {
  it("emits nothing at the culled and silhouette tiers", () => {
    for (const tier of ["L0", "L1"] as const) {
      expect(dressing(context({ tier })).vars["--dp-i"], tier).toBe("0");
    }
  });

  it("halves the intensity at the coarse tier rather than switching the effect off", () => {
    expect(Number(dressing(context({ tier: "L2a" })).vars["--dp-i"])).toBe(0.5);
    expect(Number(dressing(context({ tier: "L2b" })).vars["--dp-i"])).toBe(1);
  });

  it("stops all motion for a baked texture, because a texture cannot animate", () => {
    const baked = dressing(context({ preset: getCorePreset("glitch")!, baked: true }));
    expect(baked.vars["--dp-motion"]).toBe("0");
    for (const [key, value] of Object.entries(baked.vars)) {
      if (key.endsWith("-dur")) expect(value, key).toBe("0s");
    }
  });

  it("keeps static identity under reduced — the whole point of the setting", () => {
    const full = dressing(context({ preset: getCorePreset("crt-scanlines")! }));
    const reduced = dressing(
      context({ preset: getCorePreset("crt-scanlines")!, level: "reduced" })
    );

    expect(reduced.vars["--dp-motion"]).toBe("0");
    // Tint, grain, edge shape and static scanlines all survive.
    expect(reduced.vars["--dp-tint"]).toBe(full.vars["--dp-tint"]);
    expect(reduced.vars["--dp-scan-img"]).toBe(full.vars["--dp-scan-img"]);
    expect(reduced.vars["--dp-grain-img"]).toBe(full.vars["--dp-grain-img"]);
    expect(reduced.vars["--dp-edge-mask"]).toBe(full.vars["--dp-edge-mask"]);
  });

  it("strips everything when effects are off", () => {
    const off = dressing(context({ level: "off" }));
    expect(off.vars).toEqual({ "--dp-i": "0", "--dp-motion": "0" });
  });

  it("carries the tier and level as attributes the stylesheet can select on", () => {
    const { attrs } = dressing(context({ tier: "L2a", level: "reduced" }));
    expect(attrs["data-dp-tier"]).toBe("L2a");
    expect(attrs["data-dp-level"]).toBe("reduced");
    expect(attrs["data-dp-preset"]).toBe("aged-parchment");
  });

  it("produces a style string that is valid to paste into an attribute", () => {
    const style = dressing(context()).style;
    expect(style).toMatch(/^--dp-[\w-]+:/);
    expect(style).not.toContain('"');
    expect(style.split(";").every((d) => d.includes(":"))).toBe(true);
  });

  it("gives every shipped preset a visible rendition under reduced", () => {
    // The contract from DESIGN §7: if reduced motion produced grey boxes, GMs would
    // tell their players to switch it off.
    for (const preset of CORE_PRESETS) {
      if (preset.id === "none") continue;
      const { vars } = dressing(context({ preset, level: "reduced" }));
      const carriesSomething =
        Number(vars["--dp-tint-amt"]) > 0 ||
        vars["--dp-grain-img"] !== "none" ||
        vars["--dp-edge-mask"] !== "none" ||
        vars["--dp-scan-img"] !== "none" ||
        vars["--dp-surface-img"] !== "none" ||
        parseFloat(vars["--dp-frame-w"]) > 0 ||
        parseFloat(vars["--dp-glow-r"]) > 0 ||
        // The AR family carries its identity here; without this the sum clears zero on
        // tint and glow alone and the check passes with the overlay deleted.
        Number(vars["--dp-hud-op"]) > 0 ||
        parseFloat(vars["--dp-blur"]) > 0;
      expect(carriesSomething, `${preset.id} collapsed to a blank card`).toBe(true);
    }
  });

  /**
   * Twenty props sweeping in lockstep is a periodic full-screen luminance change, which
   * is a photosensitivity concern rather than a cosmetic one. The phase comes from the
   * pin's seed, so every client at the table agrees and no two pins agree with each other.
   */
  it("gives each prop a deterministic sweep phase from its seed", () => {
    const preset = getCorePreset("projected-readout")!;
    const delay = (seed: number) =>
      dressing(context({ preset, seed })).vars["--dp-hud-sweep-delay"];

    expect(delay(42)).toBe(delay(42));
    expect(delay(42)).not.toBe(delay(43));
    expect(parseFloat(delay(42))).toBeLessThanOrEqual(0);
    // A preset with no sweep has no phase to offset.
    expect(
      dressing(context({ preset: getCorePreset("aged-parchment")! })).vars["--dp-hud-sweep-delay"]
    ).toBe("0s");
  });

  it("never references a file for a shipped preset's surface", () => {
    for (const preset of CORE_PRESETS) {
      const { vars } = dressing(context({ preset }));
      for (const key of ["--dp-surface-img", "--dp-grain-img", "--dp-edge-mask"]) {
        const value = vars[key] ?? "none";
        expect(value === "none" || value.includes("data:"), `${preset.id} ${key}`).toBe(true);
      }
    }
  });
});

describe("toStyle", () => {
  it("joins declarations without a trailing separator", () => {
    expect(toStyle({ "--a": "1", "--b": "2" })).toBe("--a:1;--b:2");
  });
});

describe("resolveAutoLevel", () => {
  const signals = {
    prefersReducedMotion: false,
    photosensitive: false,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    fps: 60,
  };

  it("runs full on a capable machine with no preference set", () => {
    expect(resolveAutoLevel(signals)).toBe("full");
  });

  it("honours a stated reduced-motion preference above everything", () => {
    expect(resolveAutoLevel({ ...signals, prefersReducedMotion: true })).toBe("reduced");
  });

  it("honours photosensitive mode even on a fast machine — it is a hazard, not a cost", () => {
    expect(resolveAutoLevel({ ...signals, photosensitive: true, fps: 144 })).toBe("reduced");
  });

  it("reduces on a small machine", () => {
    expect(resolveAutoLevel({ ...signals, hardwareConcurrency: 4 })).toBe("reduced");
    expect(resolveAutoLevel({ ...signals, deviceMemory: 4 })).toBe("reduced");
  });

  it("lets a measured frame rate override the guesses", () => {
    expect(resolveAutoLevel({ ...signals, fps: 30 })).toBe("reduced");
  });

  it("assumes capable when a browser does not report a signal at all", () => {
    // Safari reports neither deviceMemory nor a useful concurrency hint; assuming the
    // worst there would permanently reduce effects for every Safari user.
    expect(
      resolveAutoLevel({ ...signals, deviceMemory: undefined, hardwareConcurrency: undefined })
    ).toBe("full");
  });
});

/**
 * `effect.speed` and `effect.motion` were written by the Pin Studio, validated by the
 * schema, stored on every pin — and read by nothing. The preset's own motion and
 * frequencies decided everything, so both controls moved and nothing changed.
 */
describe("the pin's own motion settings", () => {
  const animated = CORE_PRESETS.find((p) => p.motion === "loop")!;
  const base = {
    preset: animated,
    intensity: 1,
    seed: 1,
    tier: "L2b" as const,
    level: "full" as const,
    baked: false,
  };

  const durations = (vars: Record<string, string>) =>
    Object.entries(vars)
      .filter(([k]) => k.endsWith("-dur"))
      .map(([, v]) => Number.parseFloat(v))
      .filter((n) => n > 0);

  it("halves every duration at double speed", () => {
    const normal = durations(dressing({ ...base, speed: 1 }).vars);
    const fast = durations(dressing({ ...base, speed: 2 }).vars);

    expect(normal.length).toBeGreaterThan(0);
    expect(fast).toEqual(normal.map((d) => Math.round((d / 2) * 1e4) / 1e4));
  });

  it("stops motion entirely when the pin asks for none", () => {
    const still = dressing({ ...base, motion: "none" }).vars;
    expect(still["--dp-motion"]).toBe("0");
  });

  it("treats a speed of zero as still, rather than as an infinite duration", () => {
    expect(dressing({ ...base, speed: 0 }).vars["--dp-motion"]).toBe("0");
  });

  it("leaves the preset alone at speed 1, so nothing drifts by default", () => {
    const explicit = dressing({ ...base, speed: 1, motion: "loop" }).vars;
    const implicit = dressing(base).vars;
    expect(explicit).toEqual(implicit);
  });
});
