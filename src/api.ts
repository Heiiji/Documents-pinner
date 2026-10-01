/**
 * The module's verbs: the façade every surface calls, and `publicApi()`, the same verbs
 * handed to other modules.
 *
 * IMPURE, and deliberately the only orchestration layer: every surface — the HUD, the
 * Pinboard, the keybindings, the drop handler, the chat command, and other modules
 * through `game.modules.get("documents-pinner").api` — calls the same functions here.
 * A verb implemented twice is a verb that behaves differently depending on which
 * button you pressed, and visibility is exactly the place a GM cannot afford that.
 *
 * Nothing here decides anything. The rules live in the pure modules; this file resolves
 * documents, reads settings, and sequences the two writes a reveal actually needs — the
 * anchor's payload and the source's ownership — in that order, so a client that sees
 * the pin appear can already open it.
 *
 * Not everything it offers is written here (A29). What a user may do with a pin is
 * `data/access` — questions the canvas asks of every prop, which need none of the verbs.
 * The audience write every visibility verb ends in is `api/set-audience`, the one door to
 * a ping is `api/ping`, and the scene's script — the board's row facts and Reveal next —
 * is `api/reveal-next`. This file re-exports every name that moved, so its callers, its
 * tests and the public API read them here as they always did; nothing under `api/`
 * imports this file, so the re-exports make no import cycle.
 */

import { MODULE_ID, PLACEHOLDER_TEXTURE } from "./const";
import { cv, g, internal, isGM, notify, ns, playerIds } from "./fvtt";
import { logger } from "./log";
import * as audience from "./data/audience";
import * as store from "./data/PinStore";
import { readPin } from "./data/PinData";
import { canUserOpen, canUserSee, readsInPlace } from "./data/access";
import {
  DEFAULT_MARGIN_EM,
  defaultPin,
  defaultTypeSize,
  documentSource,
  freezeMetrics,
  naturalSize,
  type PinPatch,
} from "./data/pin-schema";
import { releaseAnchor, syncAnchor } from "./data/ownership-sync";
import { findPreset } from "./effects/preset-library";
import { resolveCard } from "./render/ContentResolver";
import * as settings from "./settings";
import { centreOf, docPositionFor } from "./canvas/transform";
import { adapterFor, adapterForDoc, canOpenShown, isRefusal } from "./sources/index";
import { packFacts, packLockedHere, packOf, packReadableBy } from "./sources/packs";
import { parseSourceUuid } from "./sources/uuid";
import {
  adapterOf,
  labelFor,
  resolveSource,
  sourceFromDocument,
  sourceFromDropData,
  warnIfPlayersCannotRead,
} from "./sources/view";
import { onViewedScene, pingAt } from "./api/ping";
import { revealNext } from "./api/reveal-next";
import { changeAudience, revealsUnopenable, setAudience } from "./api/set-audience";
import type { DpAudience, DpMode, DpPinFlags, DpSource } from "./types/dp";

declare const Hooks: any;

const log = logger("api");

/**
 * Run a change nobody awaits, and say when it fails.
 *
 * Pin Studio's controls and buttons, and the config sheet's switch, fire a write and move
 * on. One that rejected — the pin deleted under the gesture by another GM or by Ctrl+Z, an
 * update core refused — surfaced only as "Uncaught (in promise)" in the console, and the
 * render meant to follow it never ran, so the window went on showing the change as made.
 * The failure is logged and the GM told, and `after` runs either way.
 */
export function fireAndReport(task: unknown, after?: () => unknown): void {
  void Promise.resolve(task)
    .catch((error: unknown) => {
      log.warn("a change could not be saved", error);
      notify({ key: "DP.notice.writeFailed" }, "error");
    })
    .finally(() => void after?.());
}

// ---------------------------------------------------------------------------
// Sources — `sources/view.ts`, re-exported: the API reads them here, as it always did.
// ---------------------------------------------------------------------------

export {
  dropOutcome,
  fieldChoices,
  grantScope,
  labelFor,
  labelForSource,
  pageChoices,
  pageChoicesFor,
  resolveSource,
  shownSource,
  sourceFromDocument,
  sourceFromDropData,
  type FieldChoices,
  type GrantScope,
} from "./sources/view";

// ---------------------------------------------------------------------------
// Access — `data/access.ts`, re-exported: who may see a pin and open what it shows.
// ---------------------------------------------------------------------------

export { canUserOpen, canUserSee, isRevealed } from "./data/access";

// ---------------------------------------------------------------------------
// The scene's script — `api/reveal-next.ts`, re-exported: the board's row facts and
// Reveal next, which plays the board's order with the board open or closed.
// ---------------------------------------------------------------------------

export { revealNext, rowFacts } from "./api/reveal-next";

// ---------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------

export interface PinPlacement {
  x: number;
  y: number;
  mode?: DpMode;
  width?: number;
  height?: number;
  rotation?: number;
  elevation?: number;
  effectId?: string;
  audienceKind?: DpAudience["kind"];
  /** Type size in scene px; defaults to what a natural-size prop on this grid derives. */
  typeSize?: number;
  /** Margin in em of the type size. */
  margin?: number;
  /**
   * `x, y` name the centre — which is the point a TileDocument stores on v14 — rather
   * than the top-left corner. The ghost and a Note both hand over a centre.
   */
  centred?: boolean;
}

/**
 * Create a pin on a scene.
 *
 * The stored payload defaults to hidden; the world's default audience is applied here,
 * on top, where a GM placing a pin can see the result. That order is deliberate — see
 * the note in `pin-schema.ts`.
 */
export async function pinAt(scene: any, source: DpSource, at: PinPlacement): Promise<any> {
  if (!isGM() || !scene || refused(source)) return null;

  const mode = at.mode ?? settings.get("defaultMode");
  const grid = scene.grid?.size ?? 100;
  const natural = naturalSize(mode, grid);
  const width = at.width ?? natural.width;
  const height = at.height ?? natural.height;

  const kind = at.audienceKind ?? settings.get("defaultAudience");
  const pin: DpPinFlags = {
    ...defaultPin(),
    mode,
    source,
    // Stored from the start, in BOTH modes, so a pin that later becomes a prop already
    // knows its type and a prop's first resize is a change of window, never of zoom.
    display: {
      ...defaultPin().display,
      typeSize: at.typeSize ?? defaultTypeSize(grid),
      margin: at.margin ?? DEFAULT_MARGIN_EM,
    },
    audience: audience.makeAudience({
      kind,
      ownershipSync: {
        // An actor's pin starts with it off: a poster reads in place without any grant,
        // and a grant lists the NPC in every sidebar it reaches (DESIGN A28, D2).
        enabled: adapterOf(source).syncOnCreate && settings.get("defaultOwnershipSync"),
        level: 2,
      },
    }),
    effect: { ...defaultPin().effect, id: at.effectId ?? settings.get("lastPreset") },
  };

  // The document's point is the tile's centre, so a centred placement stores the point
  // as given and a corner placement moves in by half a box. It used to be the other way
  // round, and every ghost-placed prop landed with its frame half a card from its paper.
  const position = at.centred
    ? { x: at.x, y: at.y }
    : docPositionFor({ x: at.x, y: at.y, width, height });
  const anchor = await store.place(scene, pin, {
    x: position.x,
    y: position.y,
    width,
    height,
    rotation: at.rotation ?? 0,
    elevation: at.elevation ?? 0,
    sort: nextSort(scene),
    texture: anchorTexture(source),
  });

  if (anchor) {
    await syncAnchor(anchor);
    if (source.uuid) await settings.set("lastSourceUuid", source.uuid);
    warnIfPlayersCannotRead(source);
  }
  return anchor;
}

/**
 * DESIGN A28's D3 at every door: an item an actor owns, or a token's own actor, is refused
 * to an API caller as its drop, its header and the picker refuse it — with the same notice,
 * and nothing written. Their ownership is their parent's, so no grant could follow, and a
 * card of an owned item was drawn all the same.
 */
function refused(source: DpSource): boolean {
  if (source?.kind !== "document") return false;
  const name = parseSourceUuid(source.uuid)?.documentName;
  const outcome = name ? adapterFor(name)?.fromDrop({ type: name, uuid: source.uuid }) : null;
  if (!isRefusal(outcome)) return false;
  notify({ key: outcome.refused }, "info");
  return true;
}

/** New pins land at the end of the reveal order, which is where a GM expects them. */
function nextSort(scene: any): number {
  const existing = store.all(scene);
  return existing.length ? (existing[existing.length - 1].sort ?? 0) + 10 : 0;
}

/**
 * The texture an anchor is created with, in BOTH modes.
 *
 * An image source shows itself; anything else shows the placeholder. Never null and
 * never undefined: a tile with no valid texture gets no `PrimarySpriteMesh`, and with
 * no mesh the rasteriser has nothing to bind to, so the prop tier is a silent no-op.
 * That is indistinguishable from "still loading", which is why it survived review.
 */
function anchorTexture(source: DpSource): string {
  return source.kind === "image" && source.src ? source.src : PLACEHOLDER_TEXTURE;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

// The write every verb below ends in, and what it says — `api/set-audience.ts`.
export { setAudience, type AudienceChange } from "./api/set-audience";

/**
 * Reveal or hide many pins of one scene: the Pinboard's bulk bar, "Reveal all" and "Hide
 * all". Resolves how many it changed.
 *
 * A reveal is the eye's own rule (`revealed`): each pin goes back to the audience it
 * remembers, never to everyone. A hide is `hidden`, which leaves a pin already hidden as
 * it is. Only the pins the gesture changes are written, in ONE scene write; ownership then
 * follows for every pin at once, the ledger's queue per document in `ownership-sync`
 * keeping two pins of the same journal from racing.
 *
 * And it says what `setAudience` says, once for the batch (`revealsUnopenable`): revealing
 * an icon pin that opens its sheet, with access off, shows a pin whose sheet refuses to
 * open. A bulk reveal used to say nothing, for as many such pins as it touched.
 *
 * Which pins change, and to what, is decided inside the batch's turn in the write queue,
 * from the payloads the writes before it left (A29): decided before it, "Hide all" over a
 * chip click still landing remembered the audience the click was replacing.
 */
export async function setVisibilityMany(scene: any, docs: any[], reveal: boolean): Promise<number> {
  if (!isGM()) return 0;
  const changes: { doc: any; before: DpPinFlags; next: DpAudience }[] = [];
  await store.batchUpdate(
    scene,
    docs.map((doc) => ({
      doc,
      patch: (pin: DpPinFlags) => {
        const next = reveal ? audience.revealed(pin.audience) : audience.hidden(pin.audience);
        const same =
          audience.sameAudience(next, pin.audience) &&
          (doc.hidden === true) === audience.anchorHidden(next);
        if (same) return null;
        changes.push({ doc, before: pin, next });
        return { audience: next };
      },
    }))
  );
  if (!changes.length) return 0;

  // All at once: each anchor's sync waits only for its own, and the ledger orders the
  // writes to one document in its own queue, so two pins of one journal still keep both
  // claims. One after another, "Reveal all" over a dozen pins was a dozen round trips
  // before the last player could open what they were looking at.
  const changed = changes.map(({ doc }) => doc);
  reportAccessFailures(changed, await Promise.allSettled(changed.map((doc) => syncAnchor(doc))));

  if (changes.some(({ before, next }) => revealsUnopenable(before, next))) {
    notify({ key: "DP.notice.revealedNoAccess" }, "info");
  }
  return changes.length;
}

/**
 * Say which of a bulk gesture's grants or releases threw, once for the gesture.
 *
 * Every one is attempted whatever the others do. A write core refused is already reported
 * where it is made (`applyPlan`); this is anything else, logged with the pin it was for,
 * and the GM told in the same words.
 */
function reportAccessFailures(docs: any[], outcomes: PromiseSettledResult<unknown>[]): void {
  let failed = 0;
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") return;
    failed++;
    log.warn(`could not bring the access of ${docs[i]?.uuid} in line`, outcome.reason);
  });
  if (failed) notify({ key: "DP.notice.ownershipWriteFailed" }, "error");
}

/**
 * Delete many pins of one scene: every grant released first, then ONE scene write.
 * `deletePin` per pin is a round trip each — for a dozen selected pins, a visible stagger
 * on every client and a dozen separate undo entries.
 *
 * In the pins' own write queue (`store.removeMany`), after every write already in it: a
 * chip click still landing used to reach a tile being deleted, and the sync that followed it
 * granted for a pin that was gone. The releases run all at once inside that turn — each
 * waits in its anchor's sync queue, never in the write queue this turn holds (A22).
 */
export async function deletePins(scene: any, docs: any[]): Promise<void> {
  if (!isGM() || !docs.length) return;
  await store.removeMany(scene, docs, async () => {
    reportAccessFailures(docs, await Promise.allSettled(docs.map((doc) => releaseAnchor(doc))));
  });
}

/** Persist a new reveal order — the pins' `sort` — in one scene write. */
export async function reorder(scene: any, updates: { id: string; sort: number }[]): Promise<void> {
  if (!isGM() || !updates.length) return;
  await scene?.updateEmbeddedDocuments(
    "Tile",
    updates.map((u) => ({ _id: u.id, sort: u.sort })),
    internal()
  );
}

/**
 * Patch a pin and, if the patch touched its audience or its page, bring ownership in line.
 *
 * The single entry point for a form or an API caller editing audience fields by path.
 * It deep-merges through `PinStore.update` rather than spreading, because a shallow
 * spread of `{ ownershipSync: { level } }` would replace the whole group and silently
 * re-enable a sync the GM had turned off.
 *
 * The page counts because the grant follows it (`grantTargets`). Choosing another page in
 * the Studio used to leave the access on the page the pin no longer showed.
 *
 * `patch` now keeps all of this itself; this is its GM-only form, kept for its callers.
 */
export async function patchAndSync(anchorDoc: any, changes: PinPatch): Promise<void> {
  if (!isGM()) return;
  await patch(anchorDoc, changes);
}

/**
 * A verb that derives the next audience from the current one. The change is handed to
 * `setAudience` as a function, so it is applied to the audience the pin holds when its
 * write's turn comes — the payload read here only says whether this is a pin at all.
 */
function withAudience(
  anchorDoc: any,
  change: (current: DpAudience) => DpAudience
): Promise<void> | undefined {
  if (!readPin(anchorDoc)) return undefined;
  return setAudience(anchorDoc, change);
}

/** The eye toggle: a true on/off that remembers the per-player work it hid. */
export function toggleVisibility(anchorDoc: any): Promise<void> | undefined {
  return withAudience(anchorDoc, audience.toggleVisibility);
}

export function cycleAudience(anchorDoc: any): Promise<void> | undefined {
  return withAudience(anchorDoc, audience.cycleAudience);
}

export function setUserVisible(
  anchorDoc: any,
  userId: string,
  visible: boolean
): Promise<void> | undefined {
  return withAudience(anchorDoc, (a) => audience.setUserVisible(a, userId, visible, playerIds()));
}

/** Shift-click on a chip: one gesture for "only this player sees it". */
export function soloUser(anchorDoc: any, userId: string): Promise<void> | undefined {
  return withAudience(anchorDoc, (a) => audience.soloUser(a, userId));
}

/**
 * A click on a player's chip, on any surface — the HUD, the Pinboard, the Studio: a plain
 * click toggles that player, Shift shows the pin to them alone. `wasOn` is what the chip
 * showed when it was clicked. Each surface keeps its own re-render.
 */
export function chipClick(
  anchorDoc: any,
  userId: string,
  { solo, wasOn }: { solo: boolean; wasOn: boolean }
): Promise<void> | undefined {
  return solo ? soloUser(anchorDoc, userId) : setUserVisible(anchorDoc, userId, !wasOn);
}

/**
 * The HUD's access box: change who can open the document without changing who sees it.
 *
 * One field, so a deep patch: it merges into whatever audience the pin holds when the
 * write lands, where a whole audience built here put back the one a chip click in flight
 * was replacing.
 */
export function setOwnershipSync(anchorDoc: any, enabled: boolean): Promise<void> | undefined {
  if (!readPin(anchorDoc)) return undefined;
  return patchAndSync(anchorDoc, { audience: { ownershipSync: { enabled } } } as PinPatch);
}

/**
 * "Some players", from any surface that offers it.
 *
 * Resolves to false, writing nothing, when there is nobody to choose yet: an empty
 * selection reaches nobody and would be hidden in disguise, so the caller asks the GM to
 * pick a player instead. The HUD always did; the Studio's dropdown wrote it. Who is
 * chosen is decided when the write's turn comes, from the list the pin holds then.
 */
export function chooseSome(anchorDoc: any): Promise<boolean> {
  return changeAudience(anchorDoc, audience.someAudience);
}

// ---------------------------------------------------------------------------
// Mode, opening, flashing, deleting
// ---------------------------------------------------------------------------

export function setMode(anchorDoc: any, mode: DpMode): Promise<any> {
  return store.convertMode(anchorDoc, mode);
}

export function toggleMode(anchorDoc: any): Promise<any> | undefined {
  const pin = readPin(anchorDoc);
  if (!pin) return undefined;
  return store.convertMode(anchorDoc, pin.mode === "pin" ? "prop" : "pin");
}

/**
 * Patch a pin, keeping what the verbs keep. Resolves the document update's result, which
 * other modules have always been handed; null when nothing was written.
 *
 * It was a bare `store.update`, and it is public: a module patching `source.uuid` moved the
 * pin onto another document carrying the old one's page, PDF page and text field, with the
 * icon of the wrong kind and the grant left on the document it no longer showed; one
 * patching `audience` showed the pin and granted nothing. A patch naming another document
 * now goes the way `retarget` goes, the rest of it in the same write, and an audience or a
 * page change brings ownership in line as `patchAndSync` always did — which is now this.
 */
export async function patch(anchorDoc: any, changes: PinPatch): Promise<any> {
  return (await writeSourced(anchorDoc, changes, { plain: true })).result;
}

/** Which of a source's keys say WHICH document it is, rather than where in it to look. */
const IDENTITY = ["kind", "uuid", "src"] as const;

/** Whether `given` names a document other than the one `current` names. */
function namesAnotherDocument(current: DpSource, given: Partial<DpSource>): boolean {
  return IDENTITY.some((key) => given[key] !== undefined && given[key] !== current[key]);
}

/**
 * The whole source a pin is pointed at, from as much of one as a caller gave.
 *
 * One naming another document starts from a blank source, never from the old one:
 * `mergePin` deep-merges, so a `pageId`, `pdfPage` or `field` left out would go on naming a
 * place inside the OLD document — a page id of one journal pointing into the next, or the
 * text a GM chose for one actor read off another, a private biography included, where the
 * automatic choice never picks GM text. Only `followName` carries over: it is about the
 * pin's label, not the document. A uuid names a document and a path names a file, so a
 * source given only one of them takes its kind from which. One naming the same document is
 * the current source with the given keys over it.
 */
function completeSource(current: DpSource, given: Partial<DpSource>): DpSource {
  const named = Object.fromEntries(
    Object.entries(given).filter(([, value]) => value !== undefined)
  ) as Partial<DpSource>;
  if (!namesAnotherDocument(current, named)) return { ...current, ...named };
  const kind = named.kind ?? (named.uuid ? "document" : named.src ? "image" : current.kind);
  return { ...defaultPin().source, kind, followName: current.followName, ...named };
}

/**
 * Whether moving to `source` switches the pin's access off: a pin that comes to show an
 * actor starts with it off, as one placed on it does (DESIGN A28, D2). A journal shared with
 * access on, retargeted onto an NPC, would otherwise list the NPC in every sidebar its
 * audience reaches at the very next sync. Switching off never widens anything; a pin
 * already on an actor keeps what the GM chose for it, and so does a patch that says.
 */
function switchesAccessOff(before: DpPinFlags, source: DpSource, changes: PinPatch): boolean {
  const said = (changes.audience?.ownershipSync as { enabled?: boolean } | undefined)?.enabled;
  return (
    said === undefined &&
    before.audience.ownershipSync.enabled &&
    adapterOf(before.source).syncOnCreate &&
    !adapterOf(source).syncOnCreate
  );
}

/**
 * The texture follows only when the KIND changes: from one document to another, the icon
 * the GM chose for this pin is part of the pin, like its size and its effect.
 */
function keepsIcon(before: DpSource, source: DpSource): boolean {
  return before.kind === "document" && source.kind === "document";
}

/**
 * Write a patch that may point the pin at another document — `patch` and `retarget` both.
 *
 * Decided inside the pin's write queue (`store.updateWith`), so the document it moves FROM
 * is the one the pin names when the write lands, and the old uuid handed to the sync is
 * right even with another retarget still in flight. `plain` writes a patch that names the
 * same document as it is; without it, such a patch writes nothing.
 *
 * Then ownership: a move syncs with the old uuid, so one pass grants the new document and
 * releases the old; a plain patch syncs when it touched the audience or the page.
 */
async function writeSourced(
  anchorDoc: any,
  changes: PinPatch,
  { plain }: { plain: boolean }
): Promise<{ result: any; moved: boolean }> {
  const given = changes.source ?? {};
  const moves = (before: DpPinFlags) => namesAnotherDocument(before.source, given);

  const outcome = await store.updateWith(
    anchorDoc,
    (before): PinPatch | null => {
      if (!moves(before)) return plain ? changes : null;
      const source = completeSource(before.source, given);
      if (refused(source)) return null;
      if (!switchesAccessOff(before, source, changes)) return { ...changes, source };
      const ownershipSync = { ...before.audience.ownershipSync, enabled: false };
      return { ...changes, source, audience: { ...changes.audience, ownershipSync } };
    },
    (before): Record<string, unknown> => {
      if (!moves(before)) return {};
      const source = completeSource(before.source, given);
      return keepsIcon(before.source, source) ? {} : { "texture.src": anchorTexture(source) };
    }
  );
  const { before, result } = outcome;
  if (!before || !outcome.patch) return { result, moved: false };

  if (!moves(before)) {
    if (changes.audience || (changes.source && "pageId" in changes.source)) {
      await syncAnchor(anchorDoc);
    }
    return { result, moved: false };
  }

  const source = completeSource(before.source, given);
  if (switchesAccessOff(before, source, changes)) {
    notify({ key: "DP.notice.retargetSyncOff" }, "info");
  }
  // The old uuid rides along precisely for this: the payload no longer names the old
  // document, so the sync cannot find it on its own any more. One call, not a sync and
  // then a release, because a pin moved between a journal and one of its own pages has
  // an old document and a new one in the same family — and releasing the old family
  // after granting the new one took back the grant just made.
  await syncAnchor(anchorDoc, before.source.uuid);
  warnIfPlayersCannotRead(source);
  return { result, moved: true };
}

/**
 * Show the document to its audience, on their screens, now.
 *
 * `force` displays it regardless of permission, which is what makes ownership sync a
 * convenience rather than a requirement. `users` is narrowed to the pin's own audience
 * so "show" never reaches someone the pin is hidden from.
 */
export async function showToAudience(anchorDoc: any): Promise<void> {
  const pin = readPin(anchorDoc);
  if (!pin || !isGM()) return;

  // Core shows journals only; anything else resolves without opening a window anywhere.
  // An actor's or an item's pin is revealed by its audience, and reads in place.
  if (pin.source.kind === "document" && !adapterOf(pin.source).canShow) {
    notify({ key: "DP.notice.showJournalsOnly" }, "warn");
    return;
  }

  const source = await resolveSource(pin);
  if (!source) {
    notify({ key: "DP.notice.sourceMissing" }, "warn");
    return;
  }

  // Said, not swallowed. The action shows nothing on the GM's own screen, so a hidden
  // pin — or one whose audience has nobody in it — used to be a keystroke that did
  // nothing at all, indistinguishable from one that worked.
  let recipients = playerIds().filter((id) => canUserSee(anchorDoc, id));
  if (!recipients.length) {
    notify({ key: "DP.notice.showNobody" }, "warn");
    return;
  }

  // A compendium document is shown only to the players whose role can open the pack: on
  // anyone else's screen it would fail to load, and the GM would be told it was shown.
  const pack = packOf(pin.source.uuid);
  if (pack) {
    const readers = recipients.filter((id) => packReadableBy(pack, g()?.users?.get(id)));
    if (readers.length < recipients.length) {
      notify({ key: "DP.notice.packUnreadable", data: { pack: packFacts(pack).title } }, "warn");
    }
    if (!readers.length) return;
    recipients = readers;
  }

  // The namespaced class only: the bare global `Journal` is deprecated since v13 and goes
  // in v15 (TYPES client.d.mts:2168-2172), and reading it logs a compatibility warning.
  const Journal = ns("documents.collections.Journal");
  if (!Journal?.show) {
    notify({ key: "DP.notice.showUnavailable" }, "warn");
    return;
  }
  await Journal.show(source, { force: true, users: recipients });
  notify({ key: "DP.notice.shown", data: { count: recipients.length } }, "info");
}

/**
 * Open the document on this client only. Reveals nothing to anyone else.
 *
 * A PROP opens in place — that is what makes it a prop rather than a pin with a
 * picture. A pin opens the sheet, which is what its icon promises. `readInPlace`
 * forces the in-place reader even for a pin, for a GM who wants a small marker that
 * still reads on the map.
 */
export async function openLocally(anchorDoc: any): Promise<void> {
  const pin = readPin(anchorDoc);
  if (!pin) return;

  if (readsInPlace(pin)) {
    Hooks.call(`${MODULE_ID}.openReader`, anchorDoc);
    return;
  }

  // A compendium this player's role cannot read is not asked for: say so, as the card does.
  if (packLockedHere(pin.source.uuid)) {
    notify({ key: "DP.notice.packLocked" }, "info");
    return;
  }

  const source = await resolveSource(pin);
  if (!source?.sheet) {
    notify({ key: "DP.notice.sourceMissing" }, "warn");
    return;
  }

  // The player-side half of the key glyph. A GM sees ⚿ on a chip whose player can see
  // the pin but not open the document; the player used to get core's generic refusal,
  // or nothing. Say what the state is — not a fault, a "not yet".
  if (!isGM() && !canOpenShown(source, g()?.user)) {
    notify({ key: "DP.notice.cannotOpenYet" }, "info");
    return;
  }

  // Where it opens is the document's to say: a journal page inside its journal's sheet.
  adapterForDoc(source).open(source);
}

/**
 * Apply a preset to a pin, including the paper stock it asks for.
 *
 * The one place an effect reaches outside itself and into the pin. "Projected Readout" on
 * parchment is a tinted sheet of paper rather than a projection, and a GM who never finds
 * the Appearance tab's paper dropdown would only ever see the wrong half of the idea — so
 * a preset that names a stock brings it. Most name none, and change nothing.
 *
 * The stock is validated against the known list by `validatePreset`, so the worst a
 * preset pasted in from a stranger can do here is print a legible card on a different
 * paper. The GM's own choice is one dropdown away, and switching preset again restores
 * whatever the new one asks for.
 */
export function setEffect(anchorDoc: any, id: string): Promise<any> | undefined {
  const paper = findPreset(id)?.paper;
  return patch(anchorDoc, paper ? { effect: { id }, display: { paper } } : { effect: { id } });
}

/**
 * Set a prop's height so the whole document shows at its current width and type size.
 *
 * The width is the GM's choice — how wide a letter lies on the table — and the height
 * is the document's. A pin from before type sizes were stored is frozen first: fitting
 * is a resize, and a resize must never change the type, but a derived type follows the
 * short edge and would chase the new height. Prop mode only; a pin is one grid square.
 * The top edge stays where it was: the sheet grows downward, as the store's `resize`
 * guarantees for every caller.
 */
export async function fitToContent(anchorDoc: any): Promise<boolean> {
  if (!isGM() || !anchorDoc) return false;
  let pin = readPin(anchorDoc);
  if (!pin || pin.mode !== "prop") return false;

  const size = { width: anchorDoc.width, height: anchorDoc.height };
  if (pin.display.typeSize === null || pin.display.margin === null) {
    const frozen = freezeMetrics(pin, size).display;
    await store.update(anchorDoc, {
      display: { typeSize: frozen.typeSize, margin: frozen.margin },
    });
    pin = readPin(anchorDoc) ?? pin;
  }

  const card = await resolveCard(pin, size, { tier: "L2b", baked: false });
  if (card.naturalHeight === null) {
    notify({ key: "DP.notice.fitUnavailable" }, "warn");
    return false;
  }

  const height = Math.min(65_536, Math.max(1, Math.round(card.naturalHeight)));
  await store.resize(anchorDoc, { width: size.width, height });
  return true;
}

/**
 * Resize the anchor's box, keeping its top-left corner where it was. The type size is on
 * the pin and does not follow.
 */
export async function resize(
  anchorDoc: any,
  size: { width: number; height: number }
): Promise<boolean> {
  if (!isGM() || !anchorDoc || !readPin(anchorDoc)) return false;
  await store.resize(anchorDoc, size);
  return true;
}

/**
 * Put the box back to the natural size for this grid. The box only, deliberately: a GM
 * who set 12 px type and wants the sheet back should not lose the type, and the Studio
 * slider is the type's own reset.
 */
export async function resetSize(anchorDoc: any): Promise<boolean> {
  if (!isGM() || !anchorDoc) return false;
  const pin = readPin(anchorDoc);
  if (!pin) return false;
  const grid = anchorDoc.parent?.grid?.size ?? cv()?.scene?.grid?.size ?? 100;
  await store.resize(anchorDoc, naturalSize(pin.mode, grid));
  return true;
}

/**
 * The icon a document pin shows on the map, or the shared default with `null`.
 *
 * The tile's own texture, which is what a pin draws and what a prop shows for the moment
 * before its card is ready: every document pin used to be the same book, so a map with
 * five of them was five identical markers. An image pin shows its image and has no icon
 * to choose.
 *
 * Through the store (`setTexture`): it was the one write to a pin that went around the
 * queue and without the internal option, so an icon chosen while a retarget landed compared
 * itself with a texture about to change, and every hook of the module read the module's own
 * write as a GM's.
 */
export async function setPinIcon(anchorDoc: any, src: string | null): Promise<boolean> {
  if (!isGM() || !anchorDoc) return false;
  return store.setTexture(anchorDoc, src?.trim() || PLACEHOLDER_TEXTURE);
}

/**
 * Draw attention to a pin.
 *
 * `canvas.ping` displays locally AND remotely, so the flash costs no socket of our own.
 * It also draws at coordinates on every client's canvas whether or not a pin is there
 * — a ping is not "invisible against a hidden pin", it is a pulse on an empty patch of
 * map that says "something is here". So a hidden pin is flashed on this client only,
 * through the layer that draws pings, and the copy on the button says who sees it.
 *
 * A visible pin keeps that documented reach — every client, whoever its audience is —
 * until a socket can narrow it to the audience. What changed is the door: `pingAt` states
 * `pull: false`, so a GM holding Shift no longer turns a flash into a pull, and the local
 * path now passes the scene, without which core drew nothing at all — the flash of a
 * hidden pin had been a silent no-op.
 */
export function flash(anchorDoc: any): void {
  if (!cv() || !anchorDoc) return;

  // A ping is drawn inside the canvas and a text prop's card is drawn over it, so the
  // ping at its centre lands under the paper. The card pulses itself on this client.
  Hooks.callAll(`${MODULE_ID}.flash`, anchorDoc);

  const hidden = anchorDoc.hidden === true;
  if (pingAt(anchorDoc, { broadcast: !hidden, pull: false }) === "unavailable" && hidden) {
    notify({ key: "DP.notice.flashHidden" }, "warn");
  }
}

/**
 * Reveal & spotlight: reveal the pin if it is hidden, then bring the table to it.
 *
 * The reveal is `audience.revealed` — the remembered audience, never a toggle, so a
 * second spotlight on a revealed pin points at it again and hides nothing — and it lands
 * before anything points: a player pulled to the spot finds the pin already there.
 *
 * Every view is pulled only for a pin for everyone (DESIGN A25). A core ping reaches every
 * client whoever the pin is for, so pulling the table to the rogue's note walks everyone
 * else to where it lies. For a narrower audience the GM's own screen is pointed at, and
 * they are told, once, why nobody's view moved. A pin on a scene the GM is not viewing is
 * revealed and not pointed at: its coordinates here would point at the wrong map.
 */
export async function spotlight(anchorDoc: any): Promise<{ revealed: boolean; pulled: boolean }> {
  const outcome = { revealed: false, pulled: false };
  if (!isGM() || !anchorDoc) return outcome;
  let pin = readPin(anchorDoc);
  if (!pin) return outcome;

  if (anchorDoc.hidden === true || pin.audience.kind === "hidden") {
    // Revealed from the audience the pin holds when the write lands, not the one read here.
    await setAudience(anchorDoc, audience.revealed);
    // A write core refused still resolves, and the pin, or its scene, may be gone.
    pin = readPin(anchorDoc);
    if (!pin || anchorDoc.hidden === true || pin.audience.kind === "hidden") {
      notify({ key: "DP.notice.spotlightFailed" }, "error");
      return outcome;
    }
    outcome.revealed = true;
  }

  if (!onViewedScene(anchorDoc)) {
    notify({ key: "DP.notice.spotlightElsewhere" }, "warn");
    return outcome;
  }

  Hooks.callAll(`${MODULE_ID}.flash`, anchorDoc);
  if (audience.pingsEveryone(pin.audience)) {
    outcome.pulled = pingAt(anchorDoc, { broadcast: true, pull: true }) === "broadcast";
  } else {
    pingAt(anchorDoc, { broadcast: false, pull: false });
    notify({ key: "DP.notice.spotlightNarrow" }, "info");
  }
  return outcome;
}

/**
 * Pan and zoom to a pin, then flash it. The Pinboard's locate action.
 *
 * A GM is told to activate the Tiles layer and the pin is selected for them, because
 * "here it is" that leaves them unable to drag what was just found is half an answer:
 * core refuses to control a Tile while another layer is active, silently.
 *
 * A pin on a scene the GM is not viewing is viewed first. A Studio stays open across a
 * scene change, and its "Find on the map" used to pan the CURRENT scene to the other
 * scene's coordinates and ping players there, at a spot with nothing on it.
 */
export async function locate(anchorDoc: any): Promise<void> {
  if (!anchorDoc) return;
  const scene = anchorDoc.parent;
  if (scene?.id && cv()?.scene?.id && scene.id !== cv()?.scene?.id) {
    if (!isGM() || typeof scene.view !== "function") return;
    await scene.view();
  }

  const canvas = cv();
  if (!canvas?.animatePan) return;
  await canvas.animatePan({
    ...centreOf(anchorDoc),
    scale: Math.min(1, canvas.stage?.scale?.x ?? 1) < 0.6 ? 0.8 : undefined,
  });

  if (isGM()) {
    canvas.tiles?.activate?.();
    try {
      anchorDoc.object?.control?.({ releaseOthers: true });
    } catch {
      /* a placeable mid-redraw; the pan and the flash still did their job */
    }
  }
  flash(anchorDoc);
}

/** Delete a pin, releasing its ownership claim first so no grant is orphaned. */
export async function deletePin(anchorDoc: any): Promise<void> {
  if (!isGM()) return;
  await releaseAnchor(anchorDoc);
  await store.remove(anchorDoc);
}

/** Turn an anchor back into an ordinary tile, keeping the tile itself. */
export async function unpin(anchorDoc: any): Promise<void> {
  if (!isGM()) return;
  await releaseAnchor(anchorDoc);
  await store.unpin(anchorDoc);
}

/**
 * Point an existing pin at a different document, keeping everything else about it.
 *
 * NOT `adoptTile`. That verb builds a fresh `defaultPin()`, which is honest for what its
 * name says and catastrophic here: it would reset the mode, the geometry, the effect, the
 * interaction and — the one that matters — the AUDIENCE, silently un-revealing a pin
 * players may be reading at that moment. Only the source moves, and the ownership grant
 * that follows it.
 *
 * **Never wrap this in `enqueue`.** `store.updateWith` queues itself on the same anchor,
 * and `enqueue` chains a task after the tracked promise it has already registered — so an
 * outer task awaiting an inner one on the same anchor awaits its own completion. Neither ever
 * settles: no error, no timeout, the button simply does nothing forever. `fitToContent`
 * is the shape to copy — a plain async function whose callees queue themselves.
 *
 * The order is the payload, then the grant on the new source, then the release of the
 * old — the same order `setAudience` uses, and for the same reason. It also fails in the
 * safe direction: a half-done retarget leaves a player over-granted on a document they
 * already had access to, where release-first would revoke access to the document the pin
 * is still showing them.
 *
 * A source given in part is completed from a blank one (`completeSource`), never from the
 * old: the page, the PDF page and the text field named places in the document it leaves.
 * One that names the document the pin already shows writes nothing and resolves false.
 */
export async function retarget(anchorDoc: any, source: Partial<DpSource>): Promise<boolean> {
  if (!isGM() || !anchorDoc) return false;
  return (await writeSourced(anchorDoc, { source }, { plain: false })).moved;
}

/** Adopt an existing tile as a pin — the one-click path from the Tile config sheet. */
export async function adoptTile(tileDoc: any, source: DpSource): Promise<void> {
  if (!isGM() || !tileDoc || refused(source)) return;
  const pin: DpPinFlags = {
    ...defaultPin(),
    // A tile big enough to read is obviously a prop; anything smaller takes the world's
    // default rather than being forced to "pin", which used to make adoption the one path
    // that ignored the setting.
    mode:
      tileDoc.width > (tileDoc.parent?.grid?.size ?? 100) * 1.5
        ? "prop"
        : settings.get("defaultMode"),
    source,
    audience: audience.makeAudience({
      kind: tileDoc.hidden ? "hidden" : "everyone",
      ownershipSync: { enabled: adapterOf(source).syncOnCreate, level: 2 },
    }),
  };
  // A tile adopted as a prop is drawn at its own size from the first frame; freeze the
  // proportional look there, exactly as the migration does for an existing prop.
  const frozen = pin.mode === "prop" ? freezeMetrics(pin, tileDoc) : pin;
  await store.attach(tileDoc, frozen);
  await syncAnchor(tileDoc);
  warnIfPlayersCannotRead(source);
}

/**
 * Adopt an existing Map Note as a pin.
 *
 * The module's only concrete ecosystem-integration surface (Pin Cushion, Revealed Notes
 * Manager), and it had no route to it at all: `renderNoteConfig` was never registered,
 * and `onRenderConfig` returned early on anything that was not a Tile.
 *
 * A Note is not an anchor and cannot become one — `BaseNote` has no `hidden`, `width`,
 * `height` or `rotation`, which is the whole reason DESIGN §2 chose Tile — so adoption
 * places a real anchor where the note stands and removes the note. Destructive, so the
 * caller confirms first; the source document itself is never touched.
 */
export async function adoptNote(noteDoc: any, source?: DpSource | null): Promise<any> {
  if (!isGM() || !noteDoc) return null;

  // A Note that has not been created yet. `renderNoteConfig` fires for the PREVIEW
  // document Foundry opens when you drop a journal on the map — it has `id: null`, and
  // `delete()` on it throws `undefined id [null] does not exist in the EmbeddedCollection`
  // as an unhandled rejection, after an anchor has already been created. The GM was left
  // with both a pin and the note it was supposed to replace.
  if (!noteDoc.id) {
    notify({ key: "DP.notice.noteNotSaved" }, "warn");
    return null;
  }

  const resolved = source ?? sourceFromNote(noteDoc);
  if (!resolved) {
    notify({ key: "DP.notice.noteNoSource" }, "warn");
    return null;
  }

  const scene = noteDoc.parent ?? cv()?.scene;
  const anchor = await pinAt(scene, resolved, {
    x: noteDoc.x ?? 0,
    y: noteDoc.y ?? 0,
    centred: true,
    // The world's default, NOT a hardcoded "pin". A note looks like a marker, so pin felt
    // like the faithful conversion — but the readable prop is the whole reason to use
    // this module over a plain map note, and a GM whose default is "prop" converting a
    // note and getting another small icon has no way to tell that anything happened.
    mode: settings.get("defaultMode"),
  });
  if (!anchor) return null;

  // Only once the anchor exists: a failed create must not also lose the note.
  await noteDoc.delete?.();
  return anchor;
}

/** The journal a Note points at, preferring the specific page over its parent entry. */
export function sourceFromNote(noteDoc: any): DpSource | null {
  const pageUuid = noteDoc?.page?.uuid;
  if (pageUuid) return documentSource(pageUuid);
  const entryUuid = noteDoc?.entry?.uuid;
  if (entryUuid) {
    return documentSource(entryUuid, typeof noteDoc.pageId === "string" ? noteDoc.pageId : null);
  }
  return null;
}

/** The surface exposed on the module entry, and to other modules. */
export function publicApi() {
  return {
    MODULE_ID,
    pinAt,
    adoptTile,
    adoptNote,
    sourceFromNote,
    setAudience,
    patchAndSync,
    toggleVisibility,
    cycleAudience,
    setUserVisible,
    soloUser,
    setOwnershipSync,
    canUserSee,
    canUserOpen,
    setMode,
    toggleMode,
    patch,
    showToAudience,
    openLocally,
    flash,
    spotlight,
    locate,
    revealNext,
    fitToContent,
    resetSize,
    resize,
    deletePin,
    unpin,
    labelFor,
    resolveSource,
    sourceFromDropData,
    sourceFromDocument,
    read: store.read,
    all: store.all,
  };
}
