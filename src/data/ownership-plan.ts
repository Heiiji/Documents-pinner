/**
 * Reversible ownership synchronisation.
 *
 * PURE: no Foundry globals, no I/O. Every function takes the source document's
 * current `ownership` record plus the stored ledger and returns a *plan* — the diff
 * to apply and the ledger to store. The impure caller performs the write.
 *
 * Why a ledger at all: revealing a pinned journal to players is far more useful if it
 * also puts the document in their sidebar, which means raising ownership. But that is
 * a destructive edit to data the GM owns, so it must be exactly reversible — including
 * when several pins reference the same document, and including when the GM edits the
 * permissions by hand in between. Hence reference counting plus a baseline snapshot.
 *
 * The invariants, in order of importance:
 *   1. We never LOWER an ownership level that was already higher than what we need.
 *   2. A deliberate GM edit always wins; we detect it and step aside rather than revert.
 *   3. Releasing every holder restores the exact pre-module state, absent keys included.
 */

import { DELETE_PREFIX, LEDGER_VERSION, OWNERSHIP } from "../const";
import type { DpGrantLedger, DpNotice } from "../types/dp";

/** A Foundry ownership record: `{ default: 0, "<userId>": 2 }`. */
export type OwnershipRecord = Record<string, number>;

/** A diff to merge into `doc.update({ ownership: ... })`. May contain `-=key` deletions. */
export type OwnershipDiff = Record<string, number | null>;

export interface OwnershipPlan {
  /** `null` when nothing needs writing. */
  ownership: OwnershipDiff | null;
  /** The ledger to store, or `null` to unset the flag entirely. */
  ledger: DpGrantLedger | null;
  /** i18n keys for notifications the caller should surface. Never prose. */
  notices: DpNotice[];
}

export function emptyLedger(): DpGrantLedger {
  return { v: LEDGER_VERSION, baseline: {}, granted: {}, holders: {}, overridden: [] };
}

function clone(ledger: DpGrantLedger | null): DpGrantLedger {
  if (!ledger) return emptyLedger();
  return {
    v: ledger.v ?? LEDGER_VERSION,
    baseline: { ...ledger.baseline },
    granted: { ...ledger.granted },
    holders: Object.fromEntries(
      Object.entries(ledger.holders ?? {}).map(([k, v]) => [k, { ...v }])
    ),
    overridden: [...(ledger.overridden ?? [])],
  };
}

function maxHolderLevel(holders: Record<string, number> | undefined): number {
  const levels = Object.values(holders ?? {});
  return levels.length ? Math.max(...levels) : OWNERSHIP.NONE;
}

function isEmpty(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length === 0;
}

/** Every ownership key this anchor currently holds a grant on. */
export function keysHeldBy(ledger: DpGrantLedger | null, anchorUuid: string): string[] {
  if (!ledger) return [];
  return Object.entries(ledger.holders ?? {})
    .filter(([, holders]) => anchorUuid in holders)
    .map(([key]) => key);
}

/**
 * Raise ownership on `keys` on behalf of `anchorUuid`.
 *
 * The first grant on a key snapshots the pre-existing value into `baseline`, encoding
 * an absent per-user key as `null` so release can delete it again rather than writing
 * a spurious NONE.
 */
export function planGrant(
  current: OwnershipRecord,
  stored: DpGrantLedger | null,
  req: { anchorUuid: string; keys: readonly string[]; level: number }
): OwnershipPlan {
  const ledger = clone(stored);
  const diff: OwnershipDiff = {};

  for (const key of req.keys) {
    if (!(key in ledger.baseline)) {
      ledger.baseline[key] = key in current ? current[key] : null;
    }
    ledger.holders[key] = { ...(ledger.holders[key] ?? {}), [req.anchorUuid]: req.level };

    const base = ledger.baseline[key] ?? OWNERSHIP.NONE;
    // Invariant 1: never lower an already-higher level.
    const value = Math.max(base, maxHolderLevel(ledger.holders[key]));

    if (current[key] !== value) diff[key] = value;
    ledger.granted[key] = value;
  }

  return {
    ownership: isEmpty(diff) ? null : diff,
    ledger,
    notices: [],
  };
}

/**
 * Drop this anchor's claim on `keys` (default: every key it holds).
 *
 * When the last holder of a key goes away we restore the baseline — but only if the
 * value we wrote is still the value that is there. If the GM changed it by hand in the
 * meantime, invariant 2 applies: leave it alone, drop our bookkeeping, and say so.
 */
export function planRelease(
  current: OwnershipRecord,
  stored: DpGrantLedger | null,
  anchorUuid: string,
  keys?: readonly string[]
): OwnershipPlan {
  if (!stored) return { ownership: null, ledger: null, notices: [] };

  const ledger = clone(stored);
  const diff: OwnershipDiff = {};
  const notices: DpNotice[] = [];
  const targets = keys ?? keysHeldBy(ledger, anchorUuid);

  for (const key of targets) {
    const holders = ledger.holders[key];
    if (!holders || !(anchorUuid in holders)) continue;

    delete holders[anchorUuid];

    // Someone else still wants this key: recompute the required level.
    if (!isEmpty(holders)) {
      const base = ledger.baseline[key] ?? OWNERSHIP.NONE;
      const value = Math.max(base, maxHolderLevel(holders));
      if (current[key] !== ledger.granted[key]) {
        notices.push({ key: "DP.notice.ownershipOverridden", data: { ownershipKey: key } });
        if (!ledger.overridden.includes(key)) ledger.overridden.push(key);
      } else if (current[key] !== value) {
        diff[key] = value;
        ledger.granted[key] = value;
      }
      continue;
    }

    // Last holder released.
    delete ledger.holders[key];
    const wroteValue = ledger.granted[key];
    const base = ledger.baseline[key];

    if (current[key] !== wroteValue) {
      // Invariant 2: the GM edited it under us. Their edit stands.
      notices.push({ key: "DP.notice.ownershipOverridden", data: { ownershipKey: key } });
    } else if (base === null || base === undefined) {
      // Invariant 3: the key did not exist before us, so delete it rather than zero it.
      diff[`${DELETE_PREFIX}${key}`] = null;
    } else if (current[key] !== base) {
      diff[key] = base;
    }

    delete ledger.granted[key];
    delete ledger.baseline[key];
    ledger.overridden = ledger.overridden.filter((k) => k !== key);
  }

  const exhausted = isEmpty(ledger.holders);
  return {
    ownership: isEmpty(diff) ? null : diff,
    ledger: exhausted ? null : ledger,
    notices,
  };
}

/**
 * Fold a manual ownership edit into the ledger, so a later release stays exact.
 *
 * Called from `updateJournalEntry` &c. on the acting GM's client, with the raw
 * `changed.ownership` sub-document (which may carry `-=key` deletions).
 */
export function planRebase(
  stored: DpGrantLedger | null,
  changedOwnership: Record<string, number | null>
): { ledger: DpGrantLedger | null; notices: DpNotice[] } {
  if (!stored) return { ledger: null, notices: [] };

  const ledger = clone(stored);
  const notices: DpNotice[] = [];

  for (const [rawKey, rawValue] of Object.entries(changedOwnership)) {
    const deleted = rawKey.startsWith(DELETE_PREFIX);
    const key = deleted ? rawKey.slice(DELETE_PREFIX.length) : rawKey;
    const next: number | null = deleted ? null : rawValue;

    const held = key in ledger.holders && !isEmpty(ledger.holders[key]);
    if (!held) {
      // We do not hold this key; if we are tracking a baseline for it, just rebase.
      if (key in ledger.baseline) ledger.baseline[key] = next;
      continue;
    }

    const granted = ledger.granted[key];
    if (next === null) {
      // The GM removed a key we were holding: a hard override.
      ledger.baseline[key] = null;
      delete ledger.granted[key];
      if (!ledger.overridden.includes(key)) ledger.overridden.push(key);
      notices.push({ key: "DP.notice.ownershipOverridden", data: { ownershipKey: key } });
    } else if (next > granted) {
      // The GM raised it above what we asked for.
      //
      // The BASELINE moves with it, and that is the whole point. Adopting the raise into
      // `granted` alone left the baseline where it was, so a later release saw
      // `current === granted`, did not classify it as an override, and restored the old
      // baseline — silently reverting a deliberate GM edit, and, when the baseline was
      // `null` because the key had not existed before us, DELETING the player's ownership
      // outright. Invariant 2 says a deliberate GM edit always wins; this is what makes
      // that true for a raise as well as for a lowering.
      //
      // No notice: nothing was lost, so there is nothing to warn a GM about. The key is
      // still recorded in `overridden` so the ledger remembers a manual edit touched it.
      ledger.baseline[key] = next;
      ledger.granted[key] = next;
      if (!ledger.overridden.includes(key)) ledger.overridden.push(key);
    } else if (next < granted) {
      // The GM lowered it under us. That becomes both the new floor and the new ceiling.
      ledger.baseline[key] = next;
      ledger.granted[key] = next;
      if (!ledger.overridden.includes(key)) ledger.overridden.push(key);
      notices.push({ key: "DP.notice.ownershipOverridden", data: { ownershipKey: key } });
    }
  }

  return { ledger, notices };
}

/**
 * Move an anchor from one key set to another in a single plan — the common case when
 * a GM flips a pin's audience. Grant first, then release what is no longer needed, so
 * a key present in both sets is never transiently revoked.
 */
export function planRetarget(
  current: OwnershipRecord,
  stored: DpGrantLedger | null,
  req: { anchorUuid: string; keys: readonly string[]; level: number }
): OwnershipPlan {
  const granted = planGrant(current, stored, req);

  const nowHeld = new Set(req.keys);
  const stale = keysHeldBy(granted.ledger, req.anchorUuid).filter((k) => !nowHeld.has(k));
  if (!stale.length) return granted;

  // Apply the grant diff to a working copy so release sees the post-grant state.
  const afterGrant: OwnershipRecord = { ...current };
  for (const [k, v] of Object.entries(granted.ownership ?? {})) {
    if (k.startsWith(DELETE_PREFIX)) delete afterGrant[k.slice(DELETE_PREFIX.length)];
    else if (v !== null) afterGrant[k] = v;
  }

  const released = planRelease(afterGrant, granted.ledger, req.anchorUuid, stale);
  const ownership = { ...(granted.ownership ?? {}), ...(released.ownership ?? {}) };

  return {
    ownership: isEmpty(ownership) ? null : ownership,
    ledger: released.ledger,
    notices: released.notices,
  };
}
