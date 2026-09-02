/**
 * What a card actually wears.
 *
 * PURE. Turns a preset plus a level-of-detail rung plus an accessibility level into
 * the exact set of CSS custom properties and data attributes the card carries. Both
 * rendering tiers go through it, which is what keeps a rasterised prop and its focus
 * reader looking like the same object.
 *
 * **Implementation preference: baked > shader > CSS**, and in this module "baked"
 * means *rasterised into the texture*. A prop's pixels are produced by drawing HTML,
 * so tint, grain, stains, edge shape, frame, shadow and static scanlines are all
 * simply CSS at rasterisation time: they cost nothing per frame, they survive a future
 * PIXI major untouched, and they need no shader at all. Only genuine MOTION needs
 * anything else, and only the focused reader — one element — ever runs it.
 *
 * That is also why every preset keeps its identity under `reduced`. The static half is
 * the whole look; motion is a garnish on top. If reduced motion produced grey boxes,
 * GMs would tell their players to switch the setting off, and the accessibility
 * feature would have made things worse.
 */

import { presetToCssVars, presetToDataAttrs, reduceCssVars, type CssVars } from "./preset-css";
import type { DpPreset } from "./preset-schema";
import {
  edgeMaskDataUri,
  grainDataUri,
  scanlineGradient,
  stainDataUri,
  type EdgeStyle,
} from "./textures";
import type { LodTier } from "../canvas/lod";

export type EffectsLevel = "full" | "reduced" | "off";

export interface EffectContext {
  preset: DpPreset;
  /** Per-pin intensity, 0–1. */
  intensity: number;
  /** Per-pin seed, so every client's grain and tears land on the same pixels. */
  seed: number;
  tier: LodTier;
  level: EffectsLevel;
  /**
   * Whether the result is being rasterised into a texture rather than mounted live.
   * Baked output drops everything animated, because a texture cannot animate.
   */
  baked: boolean;
  /** Per-pin animation rate, 0–4. Scales every duration the preset emits. */
  speed?: number;
  /** Per-pin motion choice. `none` is as still as a reduced-motion client. */
  motion?: DpMotion;
}

/** What a pin may ask of a preset's motion. Mirrors `MOTIONS` in the pin schema. */
export type DpMotion = "loop" | "none";

export interface EffectDressing {
  vars: CssVars;
  attrs: Record<string, string>;
  /** Ready to paste into a `style` attribute. */
  style: string;
}

/**
 * The effect's strength for a tier.
 *
 * Half at the coarse rung rather than none: an effect that switched off at a distance
 * would make props visibly change identity as a GM zoomed out, which reads as a bug.
 */
function tierIntensity(tier: LodTier, intensity: number): number {
  switch (tier) {
    case "L2a":
      return intensity * 0.5;
    case "L2b":
    case "L3":
      return intensity;
    default:
      return 0;
  }
}

/**
 * The procedural layers, as `data:` URIs.
 *
 * Generated rather than fetched so they behave identically inside the rasteriser,
 * where nothing can be loaded, and in the DOM, where it could — see `textures.ts`.
 */
function proceduralLayers(context: EffectContext): CssVars {
  const p = context.preset.params;
  const out: CssVars = {};

  out["--dp-grain-img"] =
    p.noise.amount > 0
      ? `url('${grainDataUri({ scale: p.noise.scale, opacity: p.noise.amount, seed: context.seed })}')`
      : "none";

  // A stain is the surface layer's procedural form. A preset that names a real file
  // keeps it — a user's own texture is theirs — and this only fills in when there is
  // none, which is the case for every shipped preset.
  out["--dp-surface-img"] =
    p.surface.opacity > 0 && !p.surface.texture
      ? `url('${stainDataUri({
          opacity: p.surface.opacity,
          seed: context.seed + 11,
          color: p.tint.color,
          scale: 1,
        })}')`
      : (presetToCssVars(context.preset, 1)["--dp-surface-img"] ?? "none");

  out["--dp-edge-mask"] = edgeMaskDataUri(
    p.edge.style as EdgeStyle,
    p.edge.amount,
    context.seed + 3
  );

  // Static scanlines are TEXTURE, not motion: they survive `reduced` and are baked in.
  out["--dp-scan-img"] = scanlineGradient(p.scanlines.spacing, p.scanlines.opacity);

  // A negative delay starts the sweep mid-cycle. Seeded, so every client at the table
  // sees the same phase — and DIFFERENT per pin, so twenty props do not sweep in
  // lockstep. Lockstep is not merely uglier: it is a periodic full-screen luminance
  // change, which is the one thing an effect this animated must not produce.
  out["--dp-hud-sweep-delay"] =
    p.hud.sweepSec > 0
      ? `${-Math.round(((context.seed % 97) / 97) * p.hud.sweepSec * 1e4) / 1e4}s`
      : "0s";

  return out;
}

/**
 * The pin's OWN motion settings, applied on top of the preset's.
 *
 * `effect.speed` and `effect.motion` were offered by the Pin Studio, validated by the
 * schema and stored on every pin — and read by nothing at all. The preset's `motion` and
 * its own frequencies decided everything, so both sliders moved and nothing happened.
 *
 * `none` freezes, exactly as a reduced-motion client does. `speed` scales every duration:
 * a preset that pulses once a second at speed 1 pulses twice at speed 2, and a speed of
 * zero is simply another way to say "still".
 */
function applyPinMotion(vars: CssVars, speed: number, motion: DpMotion): CssVars {
  if (motion === "none" || !(speed > 0)) return freeze(vars);
  if (speed === 1) return vars;

  const out: CssVars = { ...vars };
  for (const [key, value] of Object.entries(out)) {
    if (!key.endsWith("-dur")) continue;
    const seconds = Number.parseFloat(value);
    if (Number.isFinite(seconds)) out[key] = `${Math.round((seconds / speed) * 1e4) / 1e4}s`;
  }
  return out;
}

/**
 * Everything animated, silenced.
 *
 * Applied for `reduced`, for a baked texture, and for the coarse tier. It is the same
 * silencing in all three cases, so it is written once.
 */
function freeze(vars: CssVars): CssVars {
  return { ...reduceCssVars(vars), "--dp-motion": "0" };
}

export function dressing(context: EffectContext): EffectDressing {
  const attrs = {
    ...presetToDataAttrs(context.preset),
    "data-dp-tier": context.tier,
    "data-dp-level": context.level,
  };

  if (context.level === "off" || context.tier === "L0" || context.tier === "L1") {
    return { vars: { "--dp-i": "0", "--dp-motion": "0" }, attrs, style: "--dp-i:0;--dp-motion:0" };
  }

  let vars: CssVars = {
    ...presetToCssVars(context.preset, tierIntensity(context.tier, context.intensity)),
    ...proceduralLayers(context),
  };

  // The pin's own motion choice, before the two rules that can override it.
  vars = applyPinMotion(vars, context.speed ?? 1, context.motion ?? "loop");

  // A texture cannot animate, and neither can a reduced-motion client. Both take the
  // same static rendition, which is why a baked prop and a reduced one look alike.
  if (context.baked || context.level === "reduced") vars = freeze(vars);

  return { vars, attrs, style: toStyle(vars) };
}

export function toStyle(vars: CssVars): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

/**
 * Resolve the `auto` effects level from the machine in front of the user.
 *
 * Every input is a signal that this client will struggle, and any one of them is
 * enough: a user who has asked for reduced motion has asked, a four-core machine with
 * four gigabytes is a laptop running a browser and a VTT, and a measured frame rate
 * below 40 is the ground truth that overrides the guesses.
 *
 * Pure: everything it needs is injected, so the policy is testable without a browser.
 */
export function resolveAutoLevel(signals: {
  prefersReducedMotion: boolean;
  photosensitive: boolean;
  hardwareConcurrency: number | undefined;
  deviceMemory: number | undefined;
  fps: number | undefined;
}): EffectsLevel {
  // Photosensitive mode is not a performance signal and is not negotiable: glitch and
  // scanlines are seizure hazards, so motion stops regardless of how fast the machine is.
  if (signals.photosensitive || signals.prefersReducedMotion) return "reduced";
  if ((signals.hardwareConcurrency ?? 8) <= 4) return "reduced";
  if ((signals.deviceMemory ?? 8) <= 4) return "reduced";
  if ((signals.fps ?? 60) < 40) return "reduced";
  return "full";
}
