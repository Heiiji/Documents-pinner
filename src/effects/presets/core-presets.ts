/**
 * The shipped preset library.
 *
 * PURE: frozen constants, no Foundry globals. These are read-only in the Preset Studio
 * — duplicating is the only way to edit one — so a broken user preset always has a
 * working ancestor to fall back to.
 *
 * Every preset below is expressible in the closed parameter schema. That was the
 * design constraint on the schema, and it is why there is no free-form CSS escape
 * hatch: a preset must be safe to paste in from a stranger.
 *
 * `cost` is deliberately NOT authored here. It is derived by `estimateCost()` on load,
 * so a careless parameter edit cannot leave an expensive effect labelled cheap.
 */

import { defaultPreset, withComputedCost, type DpPreset } from "../preset-schema";

const presets: DpPreset[] = [
  defaultPreset({
    id: "none",
    label: "DP.preset.none",
    motion: "none",
    reveal: { animation: "fade", durationMs: 300, sound: null },
  }),

  defaultPreset({
    id: "aged-parchment",
    label: "DP.preset.agedParchment",
    motion: "none",
    reveal: { animation: "fade", durationMs: 600, sound: null },
    params: {
      // Entirely bakeable into the texture: zero per-frame cost, and it survives a
      // future PIXI major version untouched. The best quality/effort ratio we ship.
      tint: { color: "#c8a86a", amount: 0.35, blend: "multiply" },
      // Procedural, not a file: an SVG rendered as an image cannot fetch anything,
      // so a real texture would appear in the reader and be missing from the prop.
      // `textures.ts` generates it from these parameters instead.
      surface: { texture: null, blend: "multiply", opacity: 0.35 },
      noise: { amount: 0.5, scale: 1.1 },
      edge: { style: "deckled", amount: 0.5 },
      frame: { style: "none", thickness: 0, radius: 2, color: "#8a6a3a" },
      shadow: { x: 0, y: 3, blur: 10, opacity: 0.45 },
    },
  }),

  defaultPreset({
    id: "torn-edges",
    label: "DP.preset.tornEdges",
    motion: "none",
    reveal: { animation: "fade", durationMs: 500, sound: null },
    params: {
      edge: { style: "torn", amount: 0.85 },
      shadow: { x: 0, y: 2, blur: 6, opacity: 0.4 },
    },
  }),

  defaultPreset({
    id: "sealed-and-wax",
    label: "DP.preset.sealedAndWax",
    motion: "none",
    reveal: { animation: "materialise", durationMs: 700, sound: null },
    params: {
      surface: { texture: null, blend: "multiply", opacity: 0.2 },
      noise: { amount: 0.35, scale: 1.6 },
      edge: { style: "deckled", amount: 0.3 },
      frame: { style: "plain", thickness: 1, radius: 2, color: "#6b2f2f" },
      shadow: { x: 1, y: 4, blur: 12, opacity: 0.5 },
    },
  }),

  defaultPreset({
    id: "bloodstained",
    label: "DP.preset.bloodstained",
    motion: "none",
    reveal: { animation: "materialise", durationMs: 800, sound: null },
    params: {
      tint: { color: "#7a1f1f", amount: 0.22, blend: "multiply" },
      surface: { texture: null, blend: "multiply", opacity: 0.7 },
      noise: { amount: 0.3, scale: 1 },
      edge: { style: "torn", amount: 0.5 },
      shadow: { x: 0, y: 2, blur: 8, opacity: 0.45 },
    },
  }),

  defaultPreset({
    id: "out-of-focus",
    label: "DP.preset.outOfFocus",
    motion: "none",
    reveal: { animation: "fade", durationMs: 400, sound: null },
    params: {
      // On the canvas tier this is a mip-bias sample: one texture tap, the cheapest
      // good-looking effect available. It is also what drives the focus interaction —
      // unfocused props are soft and sharpen when you lean in to read them.
      blur: 3.5,
      shadow: { x: 0, y: 2, blur: 10, opacity: 0.35 },
    },
  }),

  defaultPreset({
    id: "arcane-glow",
    label: "DP.preset.arcaneGlow",
    motion: "loop",
    reveal: { animation: "materialise", durationMs: 900, sound: null },
    params: {
      tint: { color: "#8f7fff", amount: 0.18, blend: "screen" },
      glow: { color: "#8f7fff", radius: 18, opacity: 0.55, pulseHz: 0.35 },
      frame: { style: "rune", thickness: 2, radius: 6, color: "#8f7fff" },
      shadow: { x: 0, y: 2, blur: 12, opacity: 0.4 },
    },
  }),

  defaultPreset({
    id: "holographic-frame",
    label: "DP.preset.holographicFrame",
    motion: "loop",
    reveal: { animation: "materialise", durationMs: 700, sound: null },
    params: {
      // The CSS rendition (conic-gradient sweep over an @property angle, blended with
      // color-dodge) looks better than the shader one and costs a tenth of the effort.
      tint: { color: "#7fdfff", amount: 0.3, blend: "screen" },
      glow: { color: "#7fdfff", radius: 14, opacity: 0.5, pulseHz: 0.4 },
      scanlines: { spacing: 3, opacity: 0.16, speedPxPerSec: 6 },
      noise: { amount: 0.06, scale: 1 },
      flicker: { amount: 0.1, hz: 2 },
      frame: { style: "holo", thickness: 2, radius: 10, color: "#7fdfff" },
      shadow: { x: 0, y: 0, blur: 16, opacity: 0.3 },
    },
  }),

  defaultPreset({
    id: "crt-scanlines",
    label: "DP.preset.crtScanlines",
    motion: "loop",
    reveal: { animation: "fade", durationMs: 350, sound: null },
    params: {
      tint: { color: "#9fffd0", amount: 0.22, blend: "screen" },
      glow: { color: "#9fffd0", radius: 10, opacity: 0.35, pulseHz: 0 },
      chroma: { offset: 1.2, angle: 0 },
      scanlines: { spacing: 3, opacity: 0.3, speedPxPerSec: 9 },
      noise: { amount: 0.08, scale: 1.2 },
      flicker: { amount: 0.14, hz: 3 },
      frame: { style: "plain", thickness: 2, radius: 8, color: "#2a4a3a" },
      shadow: { x: 0, y: 0, blur: 14, opacity: 0.35 },
    },
  }),

  defaultPreset({
    id: "glitch",
    label: "DP.preset.glitch",
    motion: "loop",
    reveal: { animation: "materialise", durationMs: 450, sound: null },
    params: {
      // GLSL clearly wins here on the canvas tier: hashed row displacement plus an RGB
      // split. The `seed` lives on the pin, not in the preset, so every client at the
      // table glitches identically.
      //
      // The tint and frame are STATIC identity, carried deliberately so the preset
      // still reads as a glitching screen when a player has reduced motion enabled.
      // Without them, freezing the animation leaves a blank card.
      tint: { color: "#6fd7ff", amount: 0.14, blend: "screen" },
      frame: { style: "plain", thickness: 1, radius: 3, color: "#2b4658" },
      chroma: { offset: 3.5, angle: 0 },
      jitter: { amount: 4, hz: 12 },
      scanlines: { spacing: 2, opacity: 0.12, speedPxPerSec: 24 },
      noise: { amount: 0.12, scale: 1.5 },
      flicker: { amount: 0.25, hz: 8 },
      warp: { amount: 3, hz: 6 },
      shadow: { x: 0, y: 0, blur: 6, opacity: 0.3 },
    },
  }),
];

/** Shipped presets, deep-frozen so nothing can mutate the library at runtime. */
export const CORE_PRESETS: readonly DpPreset[] = Object.freeze(
  presets
    .map(withComputedCost)
    .map((p) => Object.freeze({ ...p, params: Object.freeze(p.params) }) as DpPreset)
);

export const CORE_PRESET_IDS: readonly string[] = Object.freeze(CORE_PRESETS.map((p) => p.id));

export const DEFAULT_PRESET_ID = "aged-parchment";

export function getCorePreset(id: string): DpPreset | undefined {
  return CORE_PRESETS.find((p) => p.id === id);
}
