/**
 * Effect preset schema, normalisation and validation.
 *
 * PURE: no Foundry globals. Validators return i18n KEYS, never prose, so localisation
 * happens at the edge and the rules stay testable under Node.
 *
 * A preset is a closed, declarative parameter object. There is deliberately NO
 * free-form CSS field: presets are meant to be exported, pasted into Discord and
 * imported by strangers, so a shared preset must have no injection surface and no way
 * to reach outside its own card. Every shipped effect was constrained to be
 * expressible in the parameters below — that was the design rule for the schema.
 *
 * Forward compatibility: unknown parameters are DROPPED WITH A WARNING rather than
 * rejected, so a preset authored in a future version degrades instead of failing.
 */

import { num, oneOf, warnUnknownKeys } from "../normalise";
import type { DpMode, DpNotice } from "../types/dp";

export const PRESET_SCHEMA_VERSION = 1;

export type DpMotion = "none" | "loop" | "onReveal";
export type DpCost = "low" | "medium" | "high";
export type DpEdgeStyle = "none" | "torn" | "burnt" | "deckled" | "singed";
export type DpFrameStyle = "none" | "holo" | "gilt" | "rune" | "plain";
export type DpRevealAnimation = "none" | "fade" | "materialise";

/** CSS mix-blend-mode values we allow. Anything else is rejected. */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export type DpBlend = (typeof BLEND_MODES)[number];

export interface DpPresetParams {
  tint: { color: string; amount: number; blend: DpBlend };
  glow: { color: string; radius: number; opacity: number; pulseHz: number };
  /** Gaussian blur radius in scene pixels, so it scales physically with the canvas. */
  blur: number;
  chroma: { offset: number; angle: number };
  scanlines: { spacing: number; opacity: number; speedPxPerSec: number };
  jitter: { amount: number; hz: number };
  noise: { amount: number; scale: number };
  flicker: { amount: number; hz: number };
  warp: { amount: number; hz: number };
  edge: { style: DpEdgeStyle; amount: number };
  frame: { style: DpFrameStyle; thickness: number; radius: number; color: string };
  surface: { texture: string | null; blend: DpBlend; opacity: number };
  shadow: { x: number; y: number; blur: number; opacity: number };
}

export interface DpPreset {
  id: string;
  schemaVersion: number;
  /** An i18n key for shipped presets, a literal for user-authored ones. */
  label: string;
  author: "core" | "user";
  modes: DpMode[];
  motion: DpMotion;
  cost: DpCost;
  reveal: { animation: DpRevealAnimation; durationMs: number; sound: string | null };
  params: DpPresetParams;
}

export interface ValidationResult {
  /** `null` only when the input was not an object at all. */
  preset: DpPreset | null;
  errors: DpNotice[];
  warnings: DpNotice[];
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function defaultParams(): DpPresetParams {
  return {
    tint: { color: "#ffffff", amount: 0, blend: "normal" },
    glow: { color: "#ffffff", radius: 0, opacity: 0, pulseHz: 0 },
    blur: 0,
    chroma: { offset: 0, angle: 0 },
    scanlines: { spacing: 3, opacity: 0, speedPxPerSec: 0 },
    jitter: { amount: 0, hz: 0 },
    noise: { amount: 0, scale: 1 },
    flicker: { amount: 0, hz: 0 },
    warp: { amount: 0, hz: 0 },
    edge: { style: "none", amount: 0 },
    frame: { style: "none", thickness: 0, radius: 0, color: "#ffffff" },
    surface: { texture: null, blend: "multiply", opacity: 0 },
    shadow: { x: 0, y: 2, blur: 8, opacity: 0.35 },
  };
}

/**
 * Build a preset from partial overrides. `params` accepts a partial map of GROUPS —
 * each group given must be complete, so a typo cannot silently drop a sibling field
 * back to its default without the compiler noticing.
 */
export function defaultPreset(
  overrides: Partial<Omit<DpPreset, "params">> & { params?: Partial<DpPresetParams> } = {}
): DpPreset {
  return {
    id: "none",
    schemaVersion: PRESET_SCHEMA_VERSION,
    label: "DP.preset.none",
    author: "core",
    modes: ["pin", "prop"],
    motion: "none",
    cost: "low",
    reveal: { animation: "fade", durationMs: 400, sound: null },
    ...overrides,
    params: { ...defaultParams(), ...(overrides.params ?? {}) },
  };
}

function colour(value: unknown, fallback: string, warnings: DpNotice[], path: string): string {
  if (typeof value !== "string") return fallback;
  if (!HEX.test(value)) {
    warnings.push({ key: "DP.preset.warn.badColour", data: { path, value: String(value) } });
    return fallback;
  }
  return value.toLowerCase();
}

function normaliseParams(raw: unknown, warnings: DpNotice[]): DpPresetParams {
  const d = defaultParams();
  if (!raw || typeof raw !== "object") return d;
  const p = raw as Record<string, any>;
  warnUnknownKeys(p, Object.keys(d), warnings, "params");

  const grp = (name: string): Record<string, unknown> =>
    p[name] && typeof p[name] === "object" ? p[name] : {};

  for (const name of Object.keys(d) as (keyof DpPresetParams)[]) {
    const value = d[name];
    if (value !== null && typeof value === "object") {
      warnUnknownKeys(grp(name), Object.keys(value), warnings, `params.${name}`);
    }
  }

  return {
    tint: {
      color: colour(grp("tint").color, d.tint.color, warnings, "params.tint.color"),
      amount: num(grp("tint").amount, d.tint.amount, 0, 1),
      blend: oneOf(grp("tint").blend, BLEND_MODES, d.tint.blend, warnings, "params.tint.blend"),
    },
    glow: {
      color: colour(grp("glow").color, d.glow.color, warnings, "params.glow.color"),
      radius: num(grp("glow").radius, d.glow.radius, 0, 200),
      opacity: num(grp("glow").opacity, d.glow.opacity, 0, 1),
      pulseHz: num(grp("glow").pulseHz, d.glow.pulseHz, 0, 10),
    },
    blur: num(p.blur, d.blur, 0, 64),
    chroma: {
      offset: num(grp("chroma").offset, d.chroma.offset, 0, 32),
      angle: num(grp("chroma").angle, d.chroma.angle, -360, 360),
    },
    scanlines: {
      spacing: num(grp("scanlines").spacing, d.scanlines.spacing, 1, 64),
      opacity: num(grp("scanlines").opacity, d.scanlines.opacity, 0, 1),
      speedPxPerSec: num(grp("scanlines").speedPxPerSec, d.scanlines.speedPxPerSec, -240, 240),
    },
    jitter: {
      amount: num(grp("jitter").amount, d.jitter.amount, 0, 32),
      hz: num(grp("jitter").hz, d.jitter.hz, 0, 60),
    },
    noise: {
      amount: num(grp("noise").amount, d.noise.amount, 0, 1),
      scale: num(grp("noise").scale, d.noise.scale, 0.1, 16),
    },
    flicker: {
      amount: num(grp("flicker").amount, d.flicker.amount, 0, 1),
      hz: num(grp("flicker").hz, d.flicker.hz, 0, 30),
    },
    warp: {
      amount: num(grp("warp").amount, d.warp.amount, 0, 64),
      hz: num(grp("warp").hz, d.warp.hz, 0, 30),
    },
    edge: {
      style: oneOf(
        grp("edge").style,
        ["none", "torn", "burnt", "deckled", "singed"] as const,
        d.edge.style,
        warnings,
        "params.edge.style"
      ),
      amount: num(grp("edge").amount, d.edge.amount, 0, 1),
    },
    frame: {
      style: oneOf(
        grp("frame").style,
        ["none", "holo", "gilt", "rune", "plain"] as const,
        d.frame.style,
        warnings,
        "params.frame.style"
      ),
      thickness: num(grp("frame").thickness, d.frame.thickness, 0, 32),
      radius: num(grp("frame").radius, d.frame.radius, 0, 64),
      color: colour(grp("frame").color, d.frame.color, warnings, "params.frame.color"),
    },
    surface: {
      texture:
        typeof grp("surface").texture === "string" ? (grp("surface").texture as string) : null,
      blend: oneOf(
        grp("surface").blend,
        BLEND_MODES,
        d.surface.blend,
        warnings,
        "params.surface.blend"
      ),
      opacity: num(grp("surface").opacity, d.surface.opacity, 0, 1),
    },
    shadow: {
      x: num(grp("shadow").x, d.shadow.x, -64, 64),
      y: num(grp("shadow").y, d.shadow.y, -64, 64),
      blur: num(grp("shadow").blur, d.shadow.blur, 0, 128),
      opacity: num(grp("shadow").opacity, d.shadow.opacity, 0, 1),
    },
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Normalise arbitrary input — a shipped constant, a world setting, or JSON pasted by a
 * user — into a valid preset. Only a non-object input is unrecoverable.
 */
export function validatePreset(input: unknown): ValidationResult {
  const errors: DpNotice[] = [];
  const warnings: DpNotice[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { preset: null, errors: [{ key: "DP.preset.error.notAnObject" }], warnings };
  }
  const raw = input as Record<string, any>;

  const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
  if (!ID_RE.test(id)) {
    errors.push({ key: "DP.preset.error.badId", data: { value: String(raw.id ?? "") } });
  }

  const version = Number(raw.schemaVersion);
  if (Number.isFinite(version) && version > PRESET_SCHEMA_VERSION) {
    warnings.push({
      key: "DP.preset.warn.futureVersion",
      data: { found: version, supported: PRESET_SCHEMA_VERSION },
    });
  }

  const modes: DpMode[] = Array.isArray(raw.modes)
    ? (raw.modes.filter((m: unknown) => m === "pin" || m === "prop") as DpMode[])
    : ["pin", "prop"];

  const preset: DpPreset = {
    id: ID_RE.test(id) ? id : "invalid",
    schemaVersion: PRESET_SCHEMA_VERSION,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id || "invalid",
    author: raw.author === "core" ? "core" : "user",
    modes: modes.length ? modes : ["pin", "prop"],
    motion: oneOf(raw.motion, ["none", "loop", "onReveal"] as const, "none", warnings, "motion"),
    cost: oneOf(raw.cost, ["low", "medium", "high"] as const, "low", warnings, "cost"),
    reveal: {
      animation: oneOf(
        raw.reveal?.animation,
        ["none", "fade", "materialise"] as const,
        "fade",
        warnings,
        "reveal.animation"
      ),
      durationMs: num(raw.reveal?.durationMs, 400, 0, 10_000),
      sound: typeof raw.reveal?.sound === "string" ? raw.reveal.sound : null,
    },
    params: normaliseParams(raw.params, warnings),
  };

  return { preset: errors.length ? null : withComputedCost(preset), errors, warnings };
}

/**
 * A rough per-frame cost, shown to users as a three-bar meter and used by the runtime
 * perf guard.
 *
 * This is the SINGLE SOURCE OF TRUTH for `cost`: `withComputedCost` overwrites whatever
 * a preset declared. An authored label would drift the moment someone tweaked a
 * parameter, and a meter that lies about what is expensive is worse than no meter.
 *
 * Monotonic in every input, so nudging any slider can only move the score one way.
 */
export function estimateCost(preset: DpPreset): { score: number; tier: DpCost } {
  const p = preset.params;
  // Animation has a fixed cost (a live compositor layer) on top of a per-frequency one.
  const animated = preset.motion === "loop" ? 1 : 0;
  const hz = p.glow.pulseHz + p.flicker.hz + p.jitter.hz + p.warp.hz;

  const score =
    p.blur * 1.5 +
    p.glow.radius * 0.35 * (p.glow.opacity > 0 ? 1 : 0) +
    p.chroma.offset * 2.5 +
    p.warp.amount * 4 +
    p.noise.amount * 12 +
    p.scanlines.opacity * 10 +
    p.jitter.amount * 1.5 +
    (p.edge.style === "none" ? 0 : 3) +
    (p.frame.style === "holo" ? 6 : p.frame.style === "none" ? 0 : 1.5) +
    animated * (6 + hz * 0.75);

  const tier: DpCost = score < 12 ? "low" : score < 32 ? "medium" : "high";
  return { score: Math.round(score * 100) / 100, tier };
}

/** Stamp the derived cost onto a preset. Applied on every load and every edit. */
export function withComputedCost(preset: DpPreset): DpPreset {
  return { ...preset, cost: estimateCost(preset).tier };
}
