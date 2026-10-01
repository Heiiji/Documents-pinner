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
 * Above them, one anchor's syncs and releases run one at a time (`syncQueue`), so the
 * audience a sync grants is the last one the pin was given, whatever order its reads
 * resolve in. Two queues, each waiting only on the one below it; neither is the pin's own
 * write queue, which waits on them.
 */

import { DELETE_PREFIX, FLAGS, MODULE_ID } from "../const";
import { logger } from "../log";
import {
  forcedDeletion,
  forcedReplacement,
  g,
  internal,
  isGM,
  isOurs,
  isPrimaryGM,
  notify,
  ns,
  playerIds,
  resolveUuid,
} from "../fvtt";
import type { DpGrantLedger, DpPinFlags } from "../types/dp";
import { grantKeysFor } from "./audience";
import {
  keysHeldBy,
  planRebase,
  planRelease,
  planRetarget,
  readLedger,
  serialiseLedger,
  type OwnershipPlan,
} from "./ownership-plan";
import { enqueue } from "./PinStore";
import { readPin } from "./PinData";
import { describeSource } from "../sources/describe";
import { adapterForDoc, type GrantTarget } from "../sources/index";
import { isPackUuid } from "../sources/uuid";

const log = logger("grants");

function ledgerOf(doc: any): DpGrantLedger | null {
  return readLedger(doc?.flags?.[MODULE_ID]?.[FLAGS.GRANTS]);
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

  if (plan.ownership) data.ownership = ownershipWrite(doc?.ownership ?? {}, plan.ownership);
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
 * The ownership half of a plan, in a form v14 accepts.
 *
 * v14 validates an ownership change key by key BEFORE applying it: every key must be a
 * user id and every value a permission level. A deletion — `-=id`, or a `ForcedDeletion`
 * value — fails that, and core drops the WHOLE update, ledger included: an error toast,
 * and a promise that resolves as if it had worked. Measured by running 14.367's own
 * update path: `{ali: ForcedDeletion}` and `{"-=ali": null}` both rejected, a
 * `ForcedReplacement` of the full record accepted. So on v14 no release that removed a
 * player's entry ever landed, and that is the common case: a player with no entry of
 * their own before the pin, whose grant has to be deleted, not lowered.
 *
 * Core's own permission dialog writes the full record for the same reason, and a plan
 * that deletes does the same. One that only sets levels stays a plain diff, which merges.
 */
export function ownershipWrite(
  current: Record<string, number>,
  diff: Record<string, number | null>
): unknown {
  const deletes = Object.keys(diff).some((key) => key.startsWith(DELETE_PREFIX));
  if (!deletes) return diff;

  const next: Record<string, number> = { ...current };
  for (const [key, value] of Object.entries(diff)) {
    if (key.startsWith(DELETE_PREFIX)) delete next[key.slice(DELETE_PREFIX.length)];
    else if (value !== null) next[key] = value;
  }
  // A core without operators is one that still takes the `-=` keys.
  return forcedReplacement(next) ?? diff;
}

/**
 * Put the ledger on the document as a REPLACEMENT rather than a merge.
 *
 * `Document#update` merges nested objects, so writing the ledger as one could never
 * REMOVE a key from it — a phantom holder then made every later release report a GM
 * override that never happened and restore nothing. The 0.2 answer was to unset and
 * re-set the flag in one update, reasoned from v13's merge and never traced against v14,
 * where it was wrong twice over (see `readLedger`): the pair is diffed rather than
 * applied in order, and every anchor-UUID key in the ledger is expanded into nesting.
 *
 * So the ledger is stored as a string. A string is replaced whole by every core, carries
 * no dotted keys to expand, and needs no operator that a core version might not have.
 */
function writeLedger(
  data: Record<string, unknown>,
  doc: any,
  ledger: OwnershipPlan["ledger"]
): void {
  const path = `flags.${MODULE_ID}.${FLAGS.GRANTS}`;
  if (ledger) {
    data[path] = serialiseLedger(ledger);
    return;
  }
  if (doc?.flags?.[MODULE_ID]?.[FLAGS.GRANTS] !== undefined) data[path] = forcedDeletion() ?? null;
}

/**
 * Where one anchor's grant lands, and at what level: the source's adapter says (for a
 * journal, the page the pin shows and LIMITED on its journal beside it — DESIGN A22).
 */
function grantTargets(named: any, pageId: string | null, level: number): GrantTarget[] {
  return adapterForDoc(named).grantTargets(named, pageId, level);
}

/**
 * Every document a grant for this source can sit on — for a journal, itself and each of
 * its pages. A pin's grants never leave that family, so this is the whole set a stale
 * grant can be found in without walking the world. Changing the pin's DOCUMENT is the one
 * move that leaves it, and `syncAnchor` takes the old uuid for exactly that.
 */
function familyOf(doc: any): any[] {
  return doc ? adapterForDoc(doc).family(doc) : [];
}

/** Compendium ownership is role-based and pack-wide: there is no per-user grant to make. */
const grantable = (doc: any) => !!doc?.update && !doc.pack;

/**
 * The document a grant could sit on, or null. A compendium uuid is answered from the uuid
 * alone: loading the document from the server, on every audience change, only to learn
 * that a pack grants nothing was a round trip per reveal.
 */
function worldDocument(uuid: string | null | undefined): Promise<any> {
  return isPackUuid(uuid) ? Promise.resolve(null) : resolveUuid(uuid);
}

async function grantOn(doc: any, anchor: string, keys: string[], level: number): Promise<void> {
  await enqueue(`grants:${doc.uuid}`, async () => {
    const plan = planRetarget({ ...(doc.ownership ?? {}) }, ledgerOf(doc), {
      anchorUuid: anchor,
      keys,
      level,
    });
    await applyPlan(doc, plan);
  });
}

async function releaseOn(doc: any, anchor: string): Promise<void> {
  if (!grantable(doc)) return;
  await enqueue(`grants:${doc.uuid}`, async () => {
    // Read inside the queue, so a grant still in flight on this document is seen. Most of
    // a journal's pages hold nothing for this anchor, and asking them must cost no write.
    const stored = ledgerOf(doc);
    if (!keysHeldBy(stored, anchor).length) return;
    await applyPlan(doc, planRelease({ ...(doc.ownership ?? {}) }, stored, anchor));
  });
}

/**
 * The ownership keys a pin asks to hold: its audience's, or none while access is off.
 *
 * One answer for the two places that need it — what `syncAnchor` grants, and what the
 * `ready` sweep checks every holder against — so the sweep can never keep a grant a sync
 * would have taken back.
 */
function wantedKeys(pin: DpPinFlags): string[] {
  return pin.audience.ownershipSync.enabled ? grantKeysFor(pin.audience, playerIds()) : [];
}

/**
 * The queue one anchor's syncs and releases wait in.
 *
 * Its own, NOT the anchor's write queue (`PinStore.queueKey`): the verbs await a sync after
 * their write, and the bulk delete releases inside its turn in the write queue, so a sync
 * queued on the write queue would wait for the very task waiting for it — A22's deadlock,
 * which reports nothing and never ends. A sync only ever waits on the `grants:` queues
 * below it, and nothing in those waits on a sync.
 */
const syncQueue = (anchorDoc: any): string => `sync:${anchorDoc?.uuid ?? ""}`;

/**
 * Whether the anchor has been deleted since its sync was asked for.
 *
 * Core takes a deleted tile off its scene's collection and leaves the document object as
 * it was, flags and all (foundry.mjs 14.368, `#handleDeleteDocuments` 81362-81375), so the
 * payload cannot say; the scene can. A tile with no scene to ask is taken to be there.
 */
function anchorGone(anchorDoc: any): boolean {
  const tiles = anchorDoc?.parent?.tiles;
  if (typeof tiles?.get !== "function" || !anchorDoc?.id) return false;
  return !tiles.get(anchorDoc.id, { invalid: true });
}

/**
 * Bring a source document's ownership in line with one anchor's audience.
 *
 * Retarget rather than release-then-grant, so a user present in both the old and the
 * new audience is never transiently revoked — which on a live table would show up as
 * the journal blinking out of a player's sidebar mid-sentence. The same order holds
 * across documents: every target is granted before anything is released, so choosing
 * another page never leaves the player holding neither.
 *
 * `previousUuid` is the document the pin named before a retarget. Its family is swept
 * too, since the payload no longer names it and nothing else could find it.
 *
 * One at a time per anchor, reading the pin when its turn comes (A29). A sync read the pin
 * and then awaited its document, so two syncs of one anchor — two quick chip clicks, or the
 * `ready` sweep beside a resumed edit hold — reached the `grants:` queues in whatever order
 * those reads resolved, and the first one's audience could be written last: Ali's grant
 * landing after Ali-and-Ben's took Ben's back. A sync whose anchor was deleted before its
 * turn grants nothing and releases what the anchor held: granting on behalf of a pin that no
 * longer exists is a grant nothing will ever take back.
 */
export async function syncAnchor(
  anchorDoc: any,
  previousUuid: string | null = null
): Promise<void> {
  if (!isGM()) return;
  return enqueue(syncQueue(anchorDoc), () => syncNow(anchorDoc, previousUuid));
}

async function syncNow(anchorDoc: any, previousUuid: string | null): Promise<void> {
  const pin = readPin(anchorDoc);
  if (!pin) return;

  const anchor = anchorDoc.uuid;
  const named = pin.source.kind === "document" ? await worldDocument(pin.source.uuid) : null;
  const own = grantable(named) ? named : null;

  const keys = anchorGone(anchorDoc) ? [] : wantedKeys(pin);
  const targets = keys.length
    ? grantTargets(own, pin.source.pageId, pin.audience.ownershipSync.level)
    : [];
  for (const target of targets) await grantOn(target.doc, anchor, keys, target.level);

  const previous =
    previousUuid && previousUuid !== pin.source.uuid ? await worldDocument(previousUuid) : null;
  const kept = new Set(targets.map((target) => target.doc.uuid));
  const seen = new Set<string>();
  for (const doc of [...familyOf(own), ...familyOf(previous)]) {
    if (kept.has(doc.uuid) || seen.has(doc.uuid)) continue;
    seen.add(doc.uuid);
    await releaseOn(doc, anchor);
  }
}

/**
 * Drop every claim an anchor holds. Called when a pin is deleted or unpinned.
 *
 * In the anchor's sync queue, after any sync already in it: a release that overtook a sync
 * still reading its document found nothing to release, and the grant landed after it.
 */
export async function releaseAnchor(anchorDoc: any, sourceUuid?: string | null): Promise<void> {
  if (!isGM()) return;

  // Both of these are read SYNCHRONOUSLY, before the first await: `onPreDeleteTile` calls
  // this while the tile is about to stop existing, and the ledger is keyed by the
  // anchor's uuid.
  const uuid = sourceUuid ?? readPin(anchorDoc)?.source.uuid ?? null;
  const anchor = anchorDoc?.uuid ?? "";

  return enqueue(syncQueue(anchorDoc), async () => {
    for (const doc of familyOf(await worldDocument(uuid))) await releaseOn(doc, anchor);
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
 * Grant a pin's access when core brings it back: Ctrl+Z of its deletion, a paste.
 *
 * `onPreDeleteTile` gave the grant back when the tile went. The undo restored the pin with
 * its audience revealed and nothing in the ledger, and the `ready` sweep walks the ledger's
 * holders, so it never noticed: a player the pin was for saw it, and its sheet refused them,
 * until its audience next changed. Synced on the primary GM alone, since every client sees
 * the hook; the module's own creations sync themselves.
 */
export function onCreateTile(doc: any, options: any): void {
  if (isOurs(options) || !isPrimaryGM()) return;
  const pin = readPin(doc);
  if (!pin || doc?.hidden === true || pin.audience.kind === "hidden") return;
  void syncAnchor(doc).catch((error) => log.warn(`could not grant ${doc?.uuid}`, error));
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

    const { ledger, notices } = planRebase(stored, ownershipChange(changed.ownership, stored));
    const data: Record<string, unknown> = {};
    writeLedger(data, doc, ledger);
    // Caught here, as `applyPlan` catches its own: the update hook that calls this cannot
    // await it, and a refusal surfaced only as an unhandled rejection.
    try {
      if (Object.keys(data).length) await doc.update(data, internal());
    } catch (error) {
      log.warn(`the ledger on ${doc?.uuid} could not follow a permission edit`, error);
      return;
    }
    for (const notice of notices) notify(notice, "warn");
  });
}

/**
 * A core ownership change, in the `{key: level, "-=key": null}` form `planRebase` reads.
 *
 * v14 hands the update hook operators, not `-=` keys. A deleted key arrives as a
 * `ForcedDeletion` value, and core's own ownership dialog writes the WHOLE record as a
 * `ForcedReplacement` — in which a player the GM just removed is simply absent. Read as a
 * plain diff that removal was no change at all: the ledger went on recording a grant the
 * GM had taken away, and only noticed at the next release. Absence only means removal
 * inside a replacement, and only for keys the ledger is tracking, which is all a rebase
 * needs.
 *
 * What this does NOT change is the planner's rule for a re-sync: syncing a pin grants what
 * its audience asks for, so a player the GM removed by hand and left in the pin's audience
 * is granted again the next time that pin is synced.
 */
export function ownershipChange(
  changed: any,
  stored: DpGrantLedger
): Record<string, number | null> {
  const operators = ns("data.operators");
  const Deletion = operators?.ForcedDeletion;
  const Replacement = operators?.ForcedReplacement;

  if (typeof Replacement === "function" && changed instanceof Replacement) {
    const full: Record<string, number> = { ...(operators.DataFieldOperator?.get?.(changed) ?? {}) };
    const out: Record<string, number | null> = { ...full };
    const tracked = new Set([
      ...Object.keys(stored.holders),
      ...Object.keys(stored.granted),
      ...Object.keys(stored.baseline),
    ]);
    for (const key of tracked) if (!(key in full)) out[`${DELETE_PREFIX}${key}`] = null;
    return out;
  }

  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(changed ?? {})) {
    if (typeof Deletion === "function" && value instanceof Deletion)
      out[`${DELETE_PREFIX}${key}`] = null;
    else out[key] = value as number | null;
  }
  return out;
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
 *
 * It also NARROWS. Until 0.3.4 a pin showing one page granted its level on the whole
 * journal; `grantTargets` now puts it on the page and LIMITED on the journal. A world
 * holds grants made the old way, and a pin whose audience is never touched again would
 * keep handing out the whole journal forever — so a holder recorded above the level its
 * anchor's target asks for is re-synced, which moves the grant where it belongs.
 *
 * And it REVOKES (A29). It used to ask only whether a holder's anchor still pointed here,
 * never whether the anchor still wanted that key. A reload in the middle of "Hide all" —
 * the tiles written hidden, their releases not yet landed — left players holding OBSERVER
 * on documents behind hidden pins, and every sweep after found the holders' anchors alive
 * and pointing here, and kept them. A holder whose key its anchor no longer asks for
 * (`wantedKeys`: hidden, access off, a narrower list, a user deleted or made a GM) is now
 * re-synced too, which releases it with the ledger's own rules: the baseline comes back,
 * and a GM's hand edit stands (A25: hiding was always meant to release). A compendium pin
 * holds no ledger, so there is nothing of its to find.
 */
export async function reconcile(): Promise<number> {
  if (!isPrimaryGM()) return 0;

  // Anchor uuid -> the tile, the level it may hold on each document it targets, and the
  // keys it asks to hold. A live anchor is not enough; what matters is whether it still
  // points at the document holding the grant, and still wants it. Resolved synchronously:
  // a grant never sits in a compendium, and loading packs to learn that at `ready` would
  // cost more than the sweep.
  const anchors = new Map<
    string,
    { tile: any; source: string | null; levels: Map<string, number>; keys: Set<string> }
  >();
  for (const scene of g()?.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      const pin = readPin(tile);
      if (!pin) continue;
      // `describeSource`, the one reader of core's synchronous cache: a world document, or
      // null — for a compendium source always, whatever the cache holds.
      const named = pin.source.kind === "document" ? describeSource(pin.source).doc : null;
      const targets = grantTargets(
        grantable(named) ? named : null,
        pin.source.pageId,
        pin.audience.ownershipSync.level
      );
      anchors.set(tile.uuid, {
        tile,
        source: pin.source.uuid,
        levels: new Map(targets.map((target) => [target.doc.uuid, target.level])),
        keys: new Set(wantedKeys(pin)),
      });
    }
  }

  let repaired = 0;
  const narrow = new Set<string>();
  const revoke = new Set<string>();
  for (const source of sourcesWithLedger()) {
    const stored = ledgerOf(source);
    if (!stored) continue;

    const orphans = new Set<string>();
    for (const [key, holders] of Object.entries(stored.holders ?? {})) {
      for (const [anchorUuid, level] of Object.entries(holders)) {
        const anchor = anchors.get(anchorUuid);
        // The document the pin names is always its own, as it always was; a page or a
        // journal beside it is its own when `grantTargets` says so.
        const target = anchor?.levels.get(source.uuid);
        if (!anchor || (target === undefined && anchor.source !== source.uuid)) {
          orphans.add(anchorUuid);
        } else if (!anchor.keys.has(key)) {
          revoke.add(anchorUuid);
        } else if (target !== undefined && level > target) {
          narrow.add(anchorUuid);
        }
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

  // One sync per anchor, whichever of the two brought it here: a sync grants what the pin
  // asks for, where it asks for it, and releases the rest.
  for (const anchorUuid of new Set([...revoke, ...narrow])) {
    const tile = anchors.get(anchorUuid)?.tile;
    if (tile) await syncAnchor(tile);
  }
  if (narrow.size) {
    notify({ key: "DP.notice.grantsNarrowed", data: { count: narrow.size } }, "info");
  }
  if (revoke.size) {
    notify({ key: "DP.notice.grantsRevoked", data: { count: revoke.size } }, "warn");
  }
  return repaired;
}

/**
 * Every world document that carries a ledger.
 *
 * The collections a pin's source can be in — journals and their pages, actors, items —
 * and scenes and tables beside them, which cost nothing to check.
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
