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

import { g } from "../fvtt";
import * as settings from "../settings";
import { resolveAutoLevel, type EffectsLevel } from "./EffectRegistry";

/** A rolling frame-rate sample, so `auto` reflects the machine rather than a guess. */
let fps = 60;
let frames = 0;
let windowStart = 0;

/** Feed one frame. Called from the single ticker in `PropManager`. */
export function sampleFrame(now: number): void {
  if (!windowStart) windowStart = now;
  frames++;

  const elapsed = now - windowStart;
  if (elapsed < 1000) return;

  // A rolling average rather than an instantaneous rate: one long frame while a texture
  // uploads must not be able to demote every prop on the scene.
  fps = fps * 0.6 + (frames / (elapsed / 1000)) * 0.4;
  frames = 0;
  windowStart = now;
}

export function sampledFps(): number {
  return Math.round(fps);
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
 * The level to render at right now.
 *
 * Not cached: it is read once per rasterisation, not per frame, and caching it would
 * mean a user toggling reduced motion mid-session saw no change until a reload.
 */
export function currentLevel(): EffectsLevel {
  const setting = settings.get("effectsLevel");
  if (setting !== "auto") return setting;

  return resolveAutoLevel({
    prefersReducedMotion: prefersReducedMotion(),
    photosensitive: photosensitive(),
    hardwareConcurrency: navigator.hardwareConcurrency,
    // Absent in WebKit entirely, so it must stay optional rather than defaulting low —
    // assuming the worst would permanently reduce effects for every Safari user.
    deviceMemory: (navigator as any).deviceMemory,
    fps: sampledFps(),
  });
}

/** Whether motion is allowed at all. The stylesheet gates on `data-dp-level`. */
export function motionAllowed(): boolean {
  return currentLevel() === "full";
}
