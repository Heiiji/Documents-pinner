/**
 * Normalisation primitives shared by the declarative schemas.
 *
 * PURE: no Foundry globals, at import time or inside a function body.
 *
 * Every helper here is TOTAL — it returns the fallback instead of throwing. Both
 * callers parse data that may have been authored by a stranger, hand-edited into a
 * flag, or written by a future version of this module, and the failure mode has to be
 * a working default rather than an exception on the canvas mid-session.
 *
 * Warnings are collected as i18n keys so a caller can surface them; a value that could
 * not be understood is never silently identical to one that was simply absent.
 */

import type { DpNotice } from "./types/dp";

/** Control characters, stripped from every string that reaches markup. */
// eslint-disable-next-line no-control-regex -- matching them is the entire point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** A finite number clamped into `[min, max]`, or `fallback` if it is not a number. */
export function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** As `num`, rounded. Used for seeds and counts, where a fraction is meaningless. */
export function int(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(num(value, fallback, min, max));
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A trimmed string capped at `maxLength`, with control characters stripped: these
 * strings reach tooltips, labels and `data-` attributes, and a stray newline or NUL
 * arriving from a flag should not be able to disturb the markup around it.
 */
export function str(value: unknown, fallback: string, maxLength = 256): string {
  if (typeof value !== "string") return fallback;
  return value.replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  warnings: DpNotice[],
  path: string,
  warnKey = "DP.preset.warn.badEnum"
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  if (value !== undefined) {
    warnings.push({ key: warnKey, data: { path, value: String(value) } });
  }
  return fallback;
}

/**
 * A de-duplicated list of non-empty strings.
 *
 * Bounded on both axes: these lists are user ids read straight out of a flag, and an
 * unbounded one would be walked on every visibility test, once per prop, per frame.
 */
export function stringList(value: unknown, maxItems = 512, maxLength = 64): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const clean = str(entry, "", maxLength);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Warn about keys we do not understand, then leave the caller to drop them. */
export function warnUnknownKeys(
  input: Record<string, unknown>,
  known: readonly string[],
  warnings: DpNotice[],
  path: string,
  warnKey = "DP.preset.warn.unknownParam"
): void {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) {
      warnings.push({ key: warnKey, data: { path: path ? `${path}.${key}` : key } });
    }
  }
}

/** Longer than any real path; a value past it is dropped rather than truncated. */
const MAX_SOUND_PATH = 1024;

/** A URL scheme: `https:`, `data:`, `javascript:`, anything at all. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A sound's path, or `null`: the ONE same-origin rule for every sound this module plays.
 *
 * A path relative to the server — `worlds/keep/sounds/seal.ogg`, core's `sounds/lock.wav`
 * — and nothing that could leave it. No scheme at all, `https:` included: a preset is
 * pasted in from a stranger (DESIGN §7), and a sound that fetched from their server on
 * every reveal would be a beacon reporting the table's play to them. No leading pair of
 * slashes either way round: `//host` is protocol-relative, and a browser reads `\\host`
 * the same, backslashes being slashes to its URL parser. Controls are stripped BEFORE the
 * test, as that parser strips tabs and newlines, so `/\n/host` cannot slip past as a path.
 *
 * Used by the preset and pin normalisers and again by the player at the moment of play.
 */
export function soundPath(
  value: unknown,
  warnings: DpNotice[],
  path: string,
  warnKey: string
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const clean = typeof value === "string" ? value.replace(CONTROL_CHARS, "").trim() : "";
  if (typeof value === "string" && !clean) return null;
  if (
    !clean ||
    clean.length > MAX_SOUND_PATH ||
    HAS_SCHEME.test(clean) ||
    /^[\\/]{2}/.test(clean)
  ) {
    warnings.push({ key: warnKey, data: { path, value: String(value).slice(0, 64) } });
    return null;
  }
  return clean;
}

/** A plain object, or an empty one — so a caller can index it without a guard. */
export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
