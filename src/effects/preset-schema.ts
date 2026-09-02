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

export const PRESET_SCHEMA_VERSION = 2;

export type DpMotion = "none" | "loop" | "onReveal";
export type DpCost = "low" | "medium" | "high";
export type DpEdgeStyle = "none" | "torn" | "burnt" | "deckled" | "singed";
export type DpFrameStyle = "none" | "holo" | "gilt" | "rune" | "plain";
export type DpRevealAnimation = "none" | "fade" | "materialise";

/**
 * The overlay's corner geometry, and its projected grid.
 *
 * Two closed enums rather than free geometry, for the reason the whole schema is closed:
 * a preset is meant to be pasted in from a stranger. Nothing in `hud` ever becomes a
 * string in CSS — the shapes are selected by data attribute and every gradient is a
 * literal in the stylesheet — so `safeUrl()` remains the only path from a preset string
 * into a style.
 */
export type DpHudMarks = "none" | "brackets" | "corners" | "callout";
export type DpHudGrid = "none" | "square" | "hatch" | "dot";

export const HUD_MARKS = ["none", "brackets", "corners", "callout"] as const;
export const HUD_GRIDS = ["none", "square", "hatch", "dot"] as const;

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
  /**
   * The projected overlay: corner geometry, a grid, and one slow band of light.
   *
   * `sweepSec` is SECONDS where every other rate here is a frequency, and deliberately:
   * a nine-second pass is 0.11 Hz, which the Preset Studio's sliders cannot reach — and
   * emitting it as a `-dur` property is what makes `reduceCssVars` silence it with no
   * new code at all. The accessibility hook falls out of the naming convention.
   */
  hud: {
    color: string;
    /** Master strength for every hud layer, 0–1. Zero switches the whole thing off. */
    opacity: number;
    marks: DpHudMarks;
    grid: DpHudGrid;
    /** Grid pitch in CARD pixels, like every other length here. */
    pitch: number;
    /** Hairline weight in card pixels. A mark's arm is nine times this. */
    weight: number;
    /** Seconds per sweep pass. Zero is still — the sweep is the only motion here. */
    sweepSec: number;
  };
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
  /**
   * The paper stock this effect is drawn on, applied to the pin when it is chosen.
   *
   * The one field here that reaches OUTSIDE the effect and into the pin, and it is a
   * deliberate exception: "Projected Readout" on parchment is a tinted sheet of paper,
   * not a projection, and a GM who never finds the Appearance tab's paper dropdown would
   * only ever see the wrong half of the idea. Null means "leave the stock alone", which
   * is every preset that ships without one.
   *
   * A shared preset can therefore change a setting the GM made. The value is validated
   * against the known stock ids like any other enum, so the worst a hostile preset can
   * do is print a legible card on a different paper — a nuisance, not a way in.
   */
  paper: string | null;
  params: DpPresetParams;
}

export interface ValidationResult {
  /** `null` only when the input was not an object at all. */
  preset: DpPreset | null;
  errors: DpNotice[];
  warnings: DpNotice[];
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * The paper stocks a preset may ask for.
 *
 * Duplicated from `render/CardTemplate.PAPERS` rather than imported, because this module
 * is PURE and that one is not — and kept honest by a test that compares the two lists.
 * `null` is always allowed and means "leave the pin's own stock alone".
 */
export const PAPER_STOCKS = [
  "parchment",
  "vellum",
  "paper",
  "linen",
  "slate",
  "bloodied",
  "projection",
] as const;

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
    // Entirely off, so every preset written before this group existed renders exactly as
    // it did — which is what makes the version bump invisible to a world that has one.
    hud: {
      color: "#ffffff",
      opacity: 0,
      marks: "none",
      grid: "none",
      pitch: 24,
      weight: 1,
      sweepSec: 0,
    },
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
    paper: null,
    ...overrides,
    params: { ...defaultParams(), ...(overrides.params ?? {}) },
  };
}

/**
 * A known paper stock, or `null` for "leave the pin's own stock alone".
 *
 * Not `oneOf`: null is a real value here rather than a missing one, so it must not warn,
 * and `oneOf`'s fallback cannot be null. An UNKNOWN stock does warn and becomes null —
 * this is the one field that reaches out of the effect and into the pin, so a value this
 * version does not recognise has to leave the GM's own choice standing rather than print
 * on a stock that does not exist.
 */
function paperStock(value: unknown, warnings: DpNotice[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && (PAPER_STOCKS as readonly string[]).includes(value)) {
    return value;
  }
  warnings.push({ key: "DP.preset.warn.badEnum", data: { path: "paper", value: String(value) } });
  return null;
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
    hud: {
      color: colour(grp("hud").color, d.hud.color, warnings, "params.hud.color"),
      opacity: num(grp("hud").opacity, d.hud.opacity, 0, 1),
      marks: oneOf(grp("hud").marks, HUD_MARKS, d.hud.marks, warnings, "params.hud.marks"),
      grid: oneOf(grp("hud").grid, HUD_GRIDS, d.hud.grid, warnings, "params.hud.grid"),
      pitch: num(grp("hud").pitch, d.hud.pitch, 2, 128),
      weight: num(grp("hud").weight, d.hud.weight, 0, 8),
      sweepSec: num(grp("hud").sweepSec, d.hud.sweepSec, 0, 60),
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
    paper: paperStock(raw.paper, warnings),
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
    // The grid is a full-card repeating gradient; the marks are four corner gradients on
    // one element, so the grid is priced above them. The sweep is a flat charge for its
    // existence rather than its rate: it is a transform on a composited layer, so a
    // shorter period costs no more, and a model that pretended otherwise would push
    // authors towards slow sweeps for the wrong reason.
    (p.hud.marks === "none" ? 0 : 2) +
    (p.hud.grid === "none" ? 0 : 3) +
    p.hud.opacity * 4 +
    (p.hud.sweepSec > 0 ? 3 : 0) +
    animated * (6 + hz * 0.75);

  const tier: DpCost = score < 12 ? "low" : score < 32 ? "medium" : "high";
  return { score: Math.round(score * 100) / 100, tier };
}

/** Stamp the derived cost onto a preset. Applied on every load and every edit. */
export function withComputedCost(preset: DpPreset): DpPreset {
  return { ...preset, cost: estimateCost(preset).tier };
}
