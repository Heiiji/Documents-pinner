/**
 * Applying the ownership ledger.
 *
 * IMPURE. `ownership-plan.ts` decides what should happen; this file performs it. The
 * split is deliberate — the rules are the part that must be exactly right and exactly
 * reversible, so they live somewhere a unit test can reach them.
 *
 * Everything here is GM-only. Players never write ownership, and the module never asks
 * them to: revealing content does not require it (`Journal.show(doc, { force })`
 * displays a document regardless of permission), so the ledger exists to put a revealed
 * journal in a player's sidebar and keep it there, not to make the reveal possible.
 *
 * Writes are serialised per SOURCE document, not per anchor: two pins of the same
 * journal being revealed in the same gesture would otherwise each read the ledger,
 * add their own holder and write back, and the slower would erase the faster's claim.
 */

import { DELETE_PREFIX, FLAGS, MODULE_ID } from "../const";
import { logger } from "../log";
import { g, internal, isGM, isOurs, isPrimaryGM, notify, playerIds, resolveUuid } from "../fvtt";
import type { DpGrantLedger } from "../types/dp";
import { grantKeysFor } from "./audience";
import {
  keysHeldBy,
  planRebase,
  planRelease,
  planRetarget,
  type OwnershipPlan,
} from "./ownership-plan";
import { enqueue } from "./PinStore";
import { readPin } from "./PinData";

const log = logger("grants");

function ledgerOf(doc: any): DpGrantLedger | null {
  return (doc?.flags?.[MODULE_ID]?.[FLAGS.GRANTS] as DpGrantLedger) ?? null;
}

/**
 * Write a plan's two halves — the ownership diff and the ledger — as ONE update.
 *
 * They must land together: an ownership change without its ledger entry is a grant
 * nothing will ever release, and a ledger entry without its ownership change is a
 * release that will restore a value that was never written.
 */
async function applyPlan(doc: any, plan: OwnershipPlan): Promise<void> {
  const data: Record<string, unknown> = {};

  if (plan.ownership) data.ownership = plan.ownership;
  writeLedger(data, doc, plan.ledger);

  if (Object.keys(data).length) {
    try {
      await doc.update(data, internal());
      log.debug(
        `ownership on ${doc?.uuid}: ${JSON.stringify(plan.ownership ?? {})}` +
          `${plan.ledger ? "" : " (ledger cleared)"}`
      );
    } catch (error) {
      // A failed ownership write is invisible otherwise: the GM sees the pin revealed
      // and the player cannot open it, with nothing anywhere saying why. Every UI caller
      // reaches this through `void`, so the report has to happen here.
      log.warn(`ownership write failed for ${doc?.uuid}`, error);
      notify({ key: "DP.notice.ownershipWriteFailed" }, "error");
      return;
    }
  }
  for (const notice of plan.notices) notify(notice, "warn");
}

/**
 * Put the ledger on the document as a REPLACEMENT rather than a merge.
 *
 * `Document#update` deep-merges nested plain objects — the module depends on that
 * everywhere else — so writing the whole ledger object could never REMOVE a key from it.
 * `planRetarget` correctly emits `{ben: 2, "-=ali": null}` for the ownership half, but
 * the ledger half kept `holders: { ali: {...}, ben: {...} }` forever: a phantom holder
 * naming a user whose ownership entry no longer existed, which then made every later
 * release report a GM override that never happened, restore nothing, and grow
 * `overridden` — and which `reconcile` cannot repair, because the anchor is alive and so
 * the entry is not an orphan.
 *
 * Deleted and re-set in ONE update rather than in two, because the ownership diff and the
 * ledger must land together: ownership without its ledger entry is a grant nothing will
 * ever release, and a ledger without its ownership change is a release that restores a
 * value that was never written. Dotted paths cannot express this — the `holders` sub-keys
 * are anchor UUIDs, which contain dots — and `{recursive: false}` cannot be used either,
 * because the ownership half in the same update is a diff that NEEDS the merge.
 */
function writeLedger(
  data: Record<string, unknown>,
  doc: any,
  ledger: OwnershipPlan["ledger"]
): void {
  const path = `flags.${MODULE_ID}.${FLAGS.GRANTS}`;
  const unset = `flags.${MODULE_ID}.${DELETE_PREFIX}${FLAGS.GRANTS}`;
  const stored = ledgerOf(doc);

  if (!ledger) {
    if (stored) data[unset] = null;
    return;
  }
  // Insertion order is the contract: the deletion is expanded and merged before the
  // value beside it, so the stored ledger is whatever the plan says and nothing older.
  if (stored) data[unset] = null;
  data[path] = ledger;
}

/**
 * Bring a source document's ownership in line with one anchor's audience.
 *
 * Retarget rather than release-then-grant, so a user present in both the old and the
 * new audience is never transiently revoked — which on a live table would show up as
 * the journal blinking out of a player's sidebar mid-sentence.
 */
export async function syncAnchor(anchorDoc: any): Promise<void> {
  if (!isGM()) return;

  const pin = readPin(anchorDoc);
  if (!pin) return;
  if (pin.source.kind !== "document" || !pin.source.uuid) return;

  const source = await resolveUuid(pin.source.uuid);
  if (!source?.update) return;

  // Compendium ownership is role-based and pack-wide; there is no per-user grant to
  // make, so the pin still reveals content but the sidebar half simply does not apply.
  if (source.pack) return;

  const anchor = anchorDoc.uuid;
  await enqueue(`grants:${source.uuid}`, async () => {
    const current = { ...(source.ownership ?? {}) };
    const stored = ledgerOf(source);

    const keys = pin.audience.ownershipSync.enabled ? grantKeysFor(pin.audience, playerIds()) : [];

    const plan = keys.length
      ? planRetarget(current, stored, {
          anchorUuid: anchor,
          keys,
          level: pin.audience.ownershipSync.level,
        })
      : planRelease(current, stored, anchor);

    await applyPlan(source, plan);
  });
}

/** Drop every claim an anchor holds. Called when a pin is deleted or unpinned. */
export async function releaseAnchor(anchorDoc: any, sourceUuid?: string | null): Promise<void> {
  if (!isGM()) return;

  // Both of these are read SYNCHRONOUSLY, before the first await: `onPreDeleteTile` calls
  // this while the tile is about to stop existing, and the ledger is keyed by the
  // anchor's uuid.
  const uuid = sourceUuid ?? readPin(anchorDoc)?.source.uuid ?? null;
  const anchor = anchorDoc?.uuid ?? "";

  const source = await resolveUuid(uuid);
  if (!source?.update || source.pack) return;

  await enqueue(`grants:${source.uuid}`, async () => {
    const plan = planRelease({ ...(source.ownership ?? {}) }, ledgerOf(source), anchor);
    await applyPlan(source, plan);
  });
}

/**
 * Release an anchor's grant when its tile is deleted by ANY gesture.
 *
 * `releaseAnchor` was reachable only from `api.deletePin`/`api.unpin`, which only the
 * Pinboard and the Pin Studio call. So a GM who selected the tile on the Tiles layer and
 * pressed Delete — or pressed Ctrl+Z, or deleted it from the v14 Placeables sidebar —
 * left the player holding OBSERVER on that journal indefinitely, with the pin gone and
 * nothing to take it back from. `reconcile` repairs it only at the next `ready`, and only
 * on the primary GM's client.
 *
 * DESIGN §10.8 keeps anchors as ordinary Tiles precisely so other tooling can act on
 * them, which makes this a mainline path rather than an edge case.
 *
 * `preDelete` and not `delete`: the pin flag has to still be readable.
 */
export function onPreDeleteTile(doc: any, options: any): void {
  if (!isGM() || isOurs(options)) return;
  if (!readPin(doc)) return;
  void releaseAnchor(doc);
}

/**
 * Fold a GM's manual permission edit into the ledger.
 *
 * Wired to `updateJournalEntry` and friends. Only the acting GM rebases: every client
 * sees the hook, but the ledger is one shared document and N clients writing the same
 * rebase is N-1 conflicting writes.
 */
export async function onSourceOwnershipEdited(
  doc: any,
  changed: any,
  options: any,
  userId: string
): Promise<void> {
  if (!changed?.ownership) return;
  if (!isGM() || g()?.user?.id !== userId) return;
  if (isOurs(options)) return;

  await enqueue(`grants:${doc.uuid}`, async () => {
    // Read INSIDE the queue, like `syncAnchor` and `releaseAnchor` do. Reading it out
    // here raced every in-flight grant: the hook fires while a `syncAnchor` is still
    // writing, the ledger does not exist yet, and the rebase was dropped on the floor.
    const stored = ledgerOf(doc);
    if (!stored) return;

    const { ledger, notices } = planRebase(stored, changed.ownership);
    const data: Record<string, unknown> = {};
    writeLedger(data, doc, ledger);
    if (Object.keys(data).length) await doc.update(data, internal());
    for (const notice of notices) notify(notice, "warn");
  });
}

/**
 * The `ready` sweep.
 *
 * Repairs the states the ledger cannot reach on its own: the module was disabled while
 * pins were deleted, a scene holding anchors was removed, a write was interrupted
 * mid-flight — and, since a pin's source became changeable, an anchor that is alive and
 * no longer points here.
 *
 * That last one is worth naming, because it is the reason this function is not what it
 * was. Until `api.retarget` existed, a pin's source was immutable, so "this holder is
 * stale" and "this holder's anchor is gone" were the same question and the liveness test
 * answered both. A retargeted anchor passes the liveness test and points somewhere else,
 * which would have left the old document granted to a player forever with no pin anywhere
 * naming it — and nothing in the module able to notice.
 *
 * Runs on the primary GM only, and reports what it repaired rather than doing it
 * quietly: an orphaned grant is a player still holding permission they should not.
 */
export async function reconcile(): Promise<number> {
  if (!isPrimaryGM()) return 0;

  // Anchor uuid -> the source uuid it currently names. A live anchor is not enough; what
  // matters is whether it still points at the document holding the grant.
  const anchorSources = new Map<string, string | null>();
  for (const scene of g()?.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      const pin = readPin(tile);
      if (pin) anchorSources.set(tile.uuid, pin.source.uuid);
    }
  }

  let repaired = 0;
  for (const source of sourcesWithLedger()) {
    const stored = ledgerOf(source);
    if (!stored) continue;

    const orphans = new Set<string>();
    for (const holders of Object.values(stored.holders ?? {})) {
      for (const anchorUuid of Object.keys(holders)) {
        // Exact comparison against what `syncAnchor` resolves, which keeps the
        // entry-source / page-source asymmetry correct with no special case.
        if (anchorSources.get(anchorUuid) !== source.uuid) orphans.add(anchorUuid);
      }
    }
    if (!orphans.size) continue;

    // Release one orphan at a time so each sees the state the previous one left.
    for (const anchorUuid of orphans) {
      const plan = planRelease(
        { ...(source.ownership ?? {}) },
        ledgerOf(source),
        anchorUuid,
        keysHeldBy(ledgerOf(source), anchorUuid)
      );
      await applyPlan(source, plan);
      repaired++;
    }
  }

  if (repaired) {
    notify({ key: "DP.notice.ledgerRepaired", data: { count: repaired } }, "warn");
  }
  return repaired;
}

/**
 * Every world document that carries a ledger.
 *
 * Only the collections a v1 pin can target are walked. Actors, items and tables become
 * sources through the adapter interface later, and this list grows with it.
 */
function sourcesWithLedger(): any[] {
  const game = g();
  const collections = [game?.journal, game?.scenes, game?.tables, game?.actors, game?.items];
  const found: any[] = [];

  for (const collection of collections) {
    for (const doc of collection?.contents ?? []) {
      if (doc?.flags?.[MODULE_ID]?.[FLAGS.GRANTS]) found.push(doc);
      // A journal's grants can also sit on an individual page.
      for (const page of doc?.pages?.contents ?? []) {
        if (page?.flags?.[MODULE_ID]?.[FLAGS.GRANTS]) found.push(page);
      }
    }
  }
  return found;
}
