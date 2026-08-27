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
  if (plan.ledger) data[`flags.${MODULE_ID}.${FLAGS.GRANTS}`] = plan.ledger;
  else if (ledgerOf(doc)) data[`flags.${MODULE_ID}.${DELETE_PREFIX}${FLAGS.GRANTS}`] = null;

  if (Object.keys(data).length) await doc.update(data, internal());
  for (const notice of plan.notices) notify(notice, "warn");
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

  const uuid = sourceUuid ?? readPin(anchorDoc)?.source.uuid ?? null;
  const source = await resolveUuid(uuid);
  if (!source?.update || source.pack) return;

  await enqueue(`grants:${source.uuid}`, async () => {
    const plan = planRelease({ ...(source.ownership ?? {}) }, ledgerOf(source), anchorDoc.uuid);
    await applyPlan(source, plan);
  });
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

  const stored = ledgerOf(doc);
  if (!stored) return;

  await enqueue(`grants:${doc.uuid}`, async () => {
    const { ledger, notices } = planRebase(stored, changed.ownership);
    await doc.update(
      ledger
        ? { [`flags.${MODULE_ID}.${FLAGS.GRANTS}`]: ledger }
        : { [`flags.${MODULE_ID}.${DELETE_PREFIX}${FLAGS.GRANTS}`]: null },
      internal()
    );
    for (const notice of notices) notify(notice, "warn");
  });
}

/**
 * The `ready` sweep.
 *
 * Repairs the three states the ledger cannot reach on its own: the module was disabled
 * while pins were deleted, a scene holding anchors was removed, or a write was
 * interrupted mid-flight. Each is the same fault — a holder entry naming an anchor
 * that no longer exists — so one pass fixes all three.
 *
 * Runs on the primary GM only, and reports what it repaired rather than doing it
 * quietly: an orphaned grant is a player still holding permission they should not.
 */
export async function reconcile(): Promise<number> {
  if (!isPrimaryGM()) return 0;

  const liveAnchors = new Set<string>();
  for (const scene of g()?.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      if (tile?.flags?.[MODULE_ID]?.[FLAGS.PIN]) liveAnchors.add(tile.uuid);
    }
  }

  let repaired = 0;
  for (const source of sourcesWithLedger()) {
    const stored = ledgerOf(source);
    if (!stored) continue;

    const orphans = new Set<string>();
    for (const holders of Object.values(stored.holders ?? {})) {
      for (const anchorUuid of Object.keys(holders)) {
        if (!liveAnchors.has(anchorUuid)) orphans.add(anchorUuid);
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
