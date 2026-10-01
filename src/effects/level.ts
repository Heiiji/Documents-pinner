/**
 * The effects level, resolved for this client.
 *
 * IMPURE: reads the setting, the media query, Foundry's photosensitive setting and a
 * sampled frame rate. The POLICY is pure and lives in `EffectRegistry.resolveAutoLevel`
 * — everything here just gathers the signals.
 *
 * Two of those signals are not negotiable, and neither is a performance measure:
 * `prefers-reduced-motion` is a stated preference, and `core.photosensitiveMode` is a
 * seizure risk. Glitch and scanlines are genuine photosensitivity hazards, so they stop
 * on a fast machine just as firmly as on a slow one.
 *
 * `core.photosensitiveMode` is read defensively. It exists in v14 — the probe
 * confirmed it — but reading a core setting that a future version renames would throw
 * inside a render path, and failing open there would mean showing a flashing prop to
 * someone who asked not to see one. The catch resolves to the SAFE answer.
 */

import { cv, g } from "../fvtt";
import * as settings from "../settings";
import { resolveAutoLevel, slowFrameRate, type EffectsLevel } from "./EffectRegistry";

/**
 * A gap between two frames longer than this MAY be a pause rather than a slow frame.
 *
 * The ticker runs on `requestAnimationFrame`, which the browser stops while the tab is
 * hidden or the window occluded. Folded into the window, two seconds on a character sheet
 * in another tab read as two seconds of one frame each — a client holding 60 fps sampled
 * 44, and the perf guard demoted every prop on the scene for the rest of it.
 *
 * Only MAY: see `isPause`. A machine whose every frame takes longer than this is not
 * pausing, it is the slowest client there is.
 */
export const PAUSE_MS = 250;

/** A rolling frame-rate sample, so `auto` reflects the machine rather than a guess. */
let fps = 60;
let frames = 0;
let windowStart = 0;
let lastFrame = 0;
/** The gap before this frame's, and whether the page was hidden at the last frame. */
let lastGap = 0;
let lastHidden = false;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

/**
 * Whether a gap is a pause to be left out, or a frame to be counted.
 *
 * A long gap is a pause when the page is hidden or was at the last frame — some browsers
 * keep a hidden tab's frames at one a second — or when it stands alone between short
 * gaps: a tab-away, a single hitch. A run of long gaps is a slow machine, and counting it
 * is the whole point: read as pauses, a client under 4 fps never closed a sample, stayed
 * at the 60 fps it started on, and never degraded at all.
 */
function isPause(gap: number, previousGap: number, hidden: boolean): boolean {
  return gap > PAUSE_MS && (hidden || previousGap <= PAUSE_MS);
}

/**
 * Feed one frame. Called from the single ticker in `PropManager`.
 *
 * Returns whether this frame closed a sample window, so a reader that acts on the rate
 * acts once per new sample rather than sixty times on the same one.
 */
export function sampleFrame(now: number): boolean {
  const gap = now - lastFrame;
  const hidden = pageHidden();
  const pause = isPause(gap, lastGap, hidden || lastHidden);
  lastFrame = now;
  lastGap = gap;
  lastHidden = hidden;
  if (!windowStart || pause) {
    // A pause starts the window over; it is never averaged in.
    windowStart = now;
    frames = 0;
    return false;
  }
  frames++;

  const elapsed = now - windowStart;
  if (elapsed < 1000) return false;

  // A rolling average rather than an instantaneous rate: one long frame while a texture
  // uploads must not be able to demote every prop on the scene.
  fps = fps * 0.6 + (frames / (elapsed / 1000)) * 0.4;
  frames = 0;
  windowStart = now;
  return true;
}

export function sampledFps(): number {
  return Math.round(fps);
}

/**
 * The frame rate the canvas is allowed, from core's "Maximum framerate" setting.
 *
 * Core writes it to the ticker (foundry.mjs 14.367, 117030) and reads it back the same way
 * with 60 as the fallback (145781); 0 is PIXI's "uncapped".
 */
export function frameCap(): number {
  const cap = Number(cv()?.app?.ticker?.maxFPS);
  return Number.isFinite(cap) && cap > 0 ? cap : 60;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function photosensitive(): boolean {
  try {
    return g()?.settings?.get("core", "photosensitiveMode") === true;
  } catch {
    // The setting is gone or renamed. Answering "no" here would show a flashing prop
    // to someone who asked not to see one, so an unknown answer means yes.
    return true;
  }
}

/**
 * Whether the frame rate read as slow the last time `auto` was answered.
 *
 * Remembered so the answer holds while the rate sits between the line down and the line
 * back up — see `slowFrameRate`. Only the frame rate's verdict, never the level: a
 * reduced-motion preference switched off must not leave a fast client reduced.
 */
let wasSlow = false;

/**
 * The level to render at right now.
 *
 * Not cached: it is read once per rasterisation, not per frame, and caching it would
 * mean a user toggling reduced motion mid-session saw no change until a reload.
 */
export function currentLevel(): EffectsLevel {
  const setting = settings.get("effectsLevel");
  if (setting !== "auto") return setting;

  const fps = sampledFps();
  const maxFps = frameCap();
  wasSlow = slowFrameRate(fps, maxFps, wasSlow);
  return resolveAutoLevel({
    prefersReducedMotion: prefersReducedMotion(),
    photosensitive: photosensitive(),
    hardwareConcurrency: navigator.hardwareConcurrency,
    // Absent in WebKit entirely, so it must stay optional rather than defaulting low —
    // assuming the worst would permanently reduce effects for every Safari user.
    deviceMemory: (navigator as any).deviceMemory,
    fps,
    maxFps,
    wasSlow,
  });
}

/** Whether motion is allowed at all. The stylesheet gates on `data-dp-level`. */
export function motionAllowed(): boolean {
  return currentLevel() === "full";
}
