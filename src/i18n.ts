/**
 * Localisation helper.
 *
 * Safe to call outside Foundry (in tests, or before `i18nInit`): it falls back to the
 * key itself rather than throwing, so a pure module can format a notice without
 * knowing whether a game exists.
 */

import type { DpNotice } from "./types/dp";

declare const game: any;

const PREFIX = "DP.";

export function t(key: string, data: Record<string, unknown> = {}): string {
  const full = key.startsWith(PREFIX) ? key : `${PREFIX}${key}`;
  const i18n = typeof game !== "undefined" ? game?.i18n : null;
  if (!i18n?.format) return full;
  return Object.keys(data).length ? i18n.format(full, data) : i18n.localize(full);
}

/**
 * Whether this module's tables define a key.
 *
 * Core's own `has` where there is one (foundry.mjs 205151, fallback language included);
 * else the old comparison, which works because `localize` hands back a key it does not
 * know unchanged — and fails for a key whose translation happens to be the key itself.
 */
export function hasKey(key: string): boolean {
  const full = key.startsWith(PREFIX) ? key : `${PREFIX}${key}`;
  const i18n = typeof game !== "undefined" ? game?.i18n : null;
  if (typeof i18n?.has === "function") return i18n.has(full) === true;
  if (!i18n?.localize) return false;
  return i18n.localize(full) !== full;
}

/**
 * A translation where one exists, else the fallback — for values that come from the
 * world rather than from this module, such as a page type a system added. Showing the
 * raw `text` or `pdf` to a French GM was the alternative.
 */
export function tOr(key: string, fallback: string): string {
  return hasKey(key) ? t(key) : fallback;
}

/** Format a notice returned by a pure module. */
export function tn(notice: DpNotice): string {
  return t(notice.key, notice.data ?? {});
}
