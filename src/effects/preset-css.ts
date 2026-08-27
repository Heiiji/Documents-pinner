/**
 * Preset -> CSS custom properties.
 *
 * PURE: no Foundry globals, no DOM. This is the highest-value unit test in the module
 * because every visual regression starts here.
 *
 * Design rule: emit the BASE values plus a single `--dp-i` multiplier, and let the
 * stylesheet do the multiplication in `calc()`. Dragging the intensity slider is then
 * one custom-property write, and because the properties are registered with
 * `@property` (and therefore typed) the browser interpolates them on the compositor
 * instead of us running a JS ticker.
 *
 * Frequencies are converted to durations here rather than in CSS, since `calc()`
 * cannot invert a number into a <time>.
 */

import type { DpPreset } from "./preset-schema";

export type CssVars = Record<string, string>;

/** Every property this module writes. Anything outside this set is a bug. */
export const VAR_PREFIX = "--dp-";

function secondsFromHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return "0s";
  return `${round(1 / hz)}s`;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * A file path is about to be interpolated into a `url()`, so anything that could end
 * the url token or start a new declaration is rejected outright. Presets are shared
 * between strangers; this is the one place a string from a preset reaches CSS.
 */
export function safeUrl(path: string | null): string {
  if (!path || typeof path !== "string") return "none";
  if (/["'()\\\s;{}]|url\(|javascript:|expression/i.test(path)) return "none";
  return `url("${path}")`;
}

/**
 * Convert a preset into custom properties.
 *
 * `intensity` is emitted as `--dp-i` and NOT pre-multiplied into the other values, so
 * that changing it later is a single write.
 */
export function presetToCssVars(preset: DpPreset, intensity = 1): CssVars {
  const p = preset.params;
  const i = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 1));
  const animated = preset.motion === "loop" ? 1 : 0;

  return {
    "--dp-i": String(round(i)),
    "--dp-motion": String(animated),

    "--dp-tint": p.tint.color,
    "--dp-tint-amt": String(round(p.tint.amount)),
    "--dp-tint-blend": p.tint.blend,

    "--dp-glow": p.glow.color,
    "--dp-glow-r": `${round(p.glow.radius)}px`,
    "--dp-glow-op": String(round(p.glow.opacity)),
    "--dp-glow-dur": secondsFromHz(p.glow.pulseHz),

    "--dp-blur": `${round(p.blur)}px`,

    "--dp-chroma": `${round(p.chroma.offset)}px`,
    "--dp-chroma-angle": `${round(p.chroma.angle)}deg`,

    "--dp-scan-gap": `${round(p.scanlines.spacing)}px`,
    "--dp-scan-op": String(round(p.scanlines.opacity)),
    // A full cycle is one gap travelled at the configured speed.
    "--dp-scan-dur":
      p.scanlines.speedPxPerSec === 0
        ? "0s"
        : `${round(Math.abs(p.scanlines.spacing / p.scanlines.speedPxPerSec))}s`,

    "--dp-jitter": `${round(p.jitter.amount)}px`,
    "--dp-jitter-dur": secondsFromHz(p.jitter.hz),

    "--dp-noise": String(round(p.noise.amount)),
    "--dp-noise-scale": String(round(p.noise.scale)),

    "--dp-flicker": String(round(p.flicker.amount)),
    "--dp-flicker-dur": secondsFromHz(p.flicker.hz),

    "--dp-warp": String(round(p.warp.amount)),
    "--dp-warp-dur": secondsFromHz(p.warp.hz),

    "--dp-edge-amt": String(round(p.edge.amount)),

    "--dp-frame": p.frame.color,
    "--dp-frame-w": `${round(p.frame.thickness)}px`,
    "--dp-frame-r": `${round(p.frame.radius)}px`,

    "--dp-surface-img": safeUrl(p.surface.texture),
    "--dp-surface-op": String(round(p.surface.opacity)),
    "--dp-surface-blend": p.surface.blend,

    "--dp-shadow-x": `${round(p.shadow.x)}px`,
    "--dp-shadow-y": `${round(p.shadow.y)}px`,
    "--dp-shadow-blur": `${round(p.shadow.blur)}px`,
    "--dp-shadow-op": String(round(p.shadow.opacity)),
  };
}

/**
 * Style variants that CSS cannot select on through a custom property. These become
 * `data-` attributes on the card element so stylesheets can match them.
 */
export function presetToDataAttrs(preset: DpPreset): Record<string, string> {
  return {
    "data-dp-preset": preset.id,
    "data-dp-edge": preset.params.edge.style,
    "data-dp-frame": preset.params.frame.style,
    "data-dp-motion": preset.motion,
  };
}

/**
 * The reduced-effects rendition: keep static identity — tint, frame, texture, edge
 * shape — and drop only motion and the expensive per-pixel work.
 *
 * This distinction is the whole point of the accessibility setting. If reduced motion
 * turned every prop into a grey box, GMs would tell their players to switch it off.
 */
export function reduceCssVars(vars: CssVars): CssVars {
  const out: CssVars = { ...vars };
  out["--dp-motion"] = "0";
  for (const key of Object.keys(out)) {
    if (key.endsWith("-dur")) out[key] = "0s";
  }
  out["--dp-warp"] = "0";
  out["--dp-chroma"] = "0px";
  out["--dp-jitter"] = "0px";
  out["--dp-flicker"] = "0";
  return out;
}

/** The `off` rendition: no effect layer at all, just the card. */
export function disabledCssVars(): CssVars {
  return { "--dp-i": "0", "--dp-motion": "0" };
}

/**
 * The style attribute for a gallery swatch.
 *
 * PURE, and the reason both galleries were name-only: the swatch markup carried a preset
 * id and nothing anywhere styled from it, so every swatch in the HUD and the Pin Studio
 * was the same beige rectangle and a GM could not tell Glitch from Torn Edges without
 * applying it to a real pin and looking at the map.
 *
 * Motion is frozen. A grid of ten swatches all animating at once is a photosensitivity
 * hazard and a distraction from the one question a swatch answers — what does this
 * preset LOOK like — so the static rendition is exactly what is shown, which is also the
 * rendition a `reduced` client would get.
 */
export function swatchStyle(preset: DpPreset): string {
  const vars = reduceCssVars(presetToCssVars(preset, 1));
  return Object.entries(vars)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}
