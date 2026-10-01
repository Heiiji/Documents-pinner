/**
 * The module's verbs.
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
 */

import { MODULE_ID, PLACEHOLDER_TEXTURE } from "./const";
import { cfg, cv, g, isGM, notify, ns, playerIds } from "./fvtt";
import { logger } from "./log";
import * as audience from "./data/audience";
import * as store from "./data/PinStore";
import { readPin } from "./data/PinData";
import {
  DEFAULT_MARGIN_EM,
  defaultPin,
  defaultTypeSize,
  freezeMetrics,
  naturalSize,
  type PinPatch,
} from "./data/pin-schema";
import { releaseAnchor, syncAnchor } from "./data/ownership-sync";
import { findPreset } from "./effects/preset-library";
import { resolveCard } from "./render/ContentResolver";
import * as settings from "./settings";
import { centreOf, docPositionFor } from "./canvas/transform";
import { nextToReveal, type PinboardQuery, type RowFacts } from "./apps/pinboard-model";
import { describeSource } from "./sources/describe";
import { adapterFor, adapterForDoc, isRefusal } from "./sources/index";
import { packFacts, packLockedHere, packOf, packReadableBy } from "./sources/packs";
import { isPackUuid, parseSourceUuid } from "./sources/uuid";
import {
  adapterOf,
  labelFor,
  resolveSource,
  sourceFromDocument,
  sourceFromDropData,
  warnIfPlayersCannotRead,
} from "./sources/view";
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
  resolveSourceSync,
  shownSource,
  sourceFromDocument,
  sourceFromDropData,
  type FieldChoices,
  type GrantScope,
} from "./sources/view";

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

/**
 * Apply an audience change to an anchor.
 *
 * The payload is written first and the ownership sync follows, so a client that has
 * just seen the pin appear can already open the document behind it. The reverse order
 * would produce a window — small, but exactly the window a player clicks in.
 */
export async function setAudience(anchorDoc: any, next: DpAudience): Promise<void> {
  if (!isGM()) return;
  const before = readPin(anchorDoc);
  await store.update(anchorDoc, { audience: next });
  await syncAnchor(anchorDoc);

  // A prop reads in place whatever the ownership says; a PIN opens the sheet, and the
  // sheet refuses without access. Revealing one with sync off is the exact moment a GM
  // ships "I can see it but it won't open" to the table, so say so once, here.
  if (
    before?.mode === "pin" &&
    before.audience.kind === "hidden" &&
    next.kind !== "hidden" &&
    !next.ownershipSync.enabled
  ) {
    notify({ key: "DP.notice.revealedNoAccess" }, "info");
  }
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
 */
export async function patchAndSync(anchorDoc: any, changes: PinPatch): Promise<void> {
  if (!isGM()) return;
  await store.update(anchorDoc, changes);
  if (changes.audience || (changes.source && "pageId" in changes.source)) {
    await syncAnchor(anchorDoc);
  }
}

function withAudience(
  anchorDoc: any,
  change: (current: DpAudience) => DpAudience
): Promise<void> | undefined {
  const pin = readPin(anchorDoc);
  if (!pin) return undefined;
  return setAudience(anchorDoc, change(pin.audience));
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

/** Alt-click on a chip: change who can open the document without changing who sees it. */
export function setOwnershipSync(anchorDoc: any, enabled: boolean): Promise<void> | undefined {
  const pin = readPin(anchorDoc);
  if (!pin) return undefined;
  return setAudience(anchorDoc, {
    ...pin.audience,
    ownershipSync: { ...pin.audience.ownershipSync, enabled },
  });
}

/**
 * Whether this pin is revealed to anyone — the one answer the eye, the Pinboard's
 * "Visible" filter and its totals all give. See `audience.reachesAnyone` for why this is
 * not `kind !== "hidden"`.
 */
export function isRevealed(anchorDoc: any, pin: DpPinFlags | null = readPin(anchorDoc)): boolean {
  if (!pin || anchorDoc?.hidden === true) return false;
  return audience.reachesAnyone(pin.audience, playerIds());
}

/**
 * "Some players", from any surface that offers it.
 *
 * Resolves to false, writing nothing, when there is nobody to choose yet: an empty
 * selection reaches nobody and would be hidden in disguise, so the caller asks the GM to
 * pick a player instead. The HUD always did; the Studio's dropdown wrote it.
 */
export async function chooseSome(anchorDoc: any): Promise<boolean> {
  const pin = readPin(anchorDoc);
  const next = pin ? audience.someAudience(pin.audience) : null;
  if (!next) return false;
  await setAudience(anchorDoc, next);
  return true;
}

/** Whether a user can see this pin right now, by the same rule the canvas uses. */
export function canUserSee(anchorDoc: any, userId: string): boolean {
  const pin = readPin(anchorDoc);
  if (!pin) return false;
  const user = g()?.users?.get(userId);
  return audience.canSee(pin.audience, {
    isGM: user?.isGM === true,
    userId,
    hidden: anchorDoc?.hidden === true,
  });
}

/**
 * Whether a user could actually OPEN the document behind the pin.
 *
 * Compared against `canUserSee`, this is what raises the key badge in the HUD and the
 * Pinboard. The mismatch it detects — visible but unopenable — is the bug a GM ships to
 * their table and only hears about when a player says "I can see it but nothing
 * happens".
 *
 * A pin that reads in place opens in the module's own reader for anyone who can see it,
 * whatever the ownership says — `openReader` is not gated on it, deliberately. Asking
 * only for OBSERVER put a key on every chip of a prop revealed with access sync off, and
 * listed it under "Won't open", for players reading it perfectly well; the GM's natural
 * fix, switching sync on, then granted a journal nobody needed. The inverse — a player
 * who holds the journal while the pin is hidden from them — still shows, because that
 * one is true.
 */
export function canUserOpen(anchorDoc: any, userId: string): boolean {
  const pin = readPin(anchorDoc);
  if (!pin) return false;
  if (pin.source.kind === "image") return canUserSee(anchorDoc, userId);
  if (pin.interaction.open === "never") return false;

  const user = g()?.users?.get(userId);
  if (!user) return false;
  // A compendium document opens for a player whose ROLE reads the pack, as a pin or as a
  // prop. One whose role does not is never sent it: their card is a placeholder even
  // where a world journal would read in place, so the key is true there, and must show.
  if (isPackUuid(pin.source.uuid)) return packReadableBy(packOf(pin.source.uuid), user);

  const source = describeSource(pin.source).shown;
  if (!source) return false;
  // The level the document's own sheet asks for: for a journal, OBSERVER is the level at
  // which a text page actually opens, and LIMITED is the tease.
  if (source.testUserPermission?.(user, adapterForDoc(source).openLevel) === true) return true;
  return readsInPlace(pin) && canUserSee(anchorDoc, userId);
}

/**
 * Whether opening this pin shows the module's reader rather than the document's sheet.
 *
 * A prop always does — that is what makes it a prop rather than a pin with a picture —
 * and so does a pin set to read in place. One definition, because the opening itself and
 * the badge that predicts it must never disagree.
 */
export function readsInPlace(pin: DpPinFlags): boolean {
  return pin.mode === "prop" || pin.interaction.open === "readInPlace";
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

export function patch(anchorDoc: any, changes: PinPatch): Promise<any> {
  return store.update(anchorDoc, changes);
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
  const adapter = adapterForDoc(source);
  const canOpen = source.testUserPermission
    ? source.testUserPermission(g()?.user, adapter.openLevel) === true
    : true;
  if (!isGM() && !canOpen) {
    notify({ key: "DP.notice.cannotOpenYet" }, "info");
    return;
  }

  // Where it opens is the document's to say: a journal page inside its journal's sheet.
  adapter.open(source);
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
 */
export async function setPinIcon(anchorDoc: any, src: string | null): Promise<boolean> {
  if (!isGM() || !anchorDoc) return false;
  const pin = readPin(anchorDoc);
  if (!pin || pin.source.kind !== "document") return false;
  const next = src?.trim() || PLACEHOLDER_TEXTURE;
  if (anchorDoc.texture?.src === next) return false;
  await anchorDoc.update({ "texture.src": next });
  return true;
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
    await setAudience(anchorDoc, audience.revealed(pin.audience));
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

// ---------------------------------------------------------------------------
// The scene's script
// ---------------------------------------------------------------------------

/** What each player can do with a pin: the two facts the Pinboard's filters read. */
function factsUsers(anchorDoc: any): RowFacts["users"] {
  return playerIds().map((id) => ({
    canSee: canUserSee(anchorDoc, id),
    canOpen: canUserOpen(anchorDoc, id),
  }));
}

/**
 * A pin as the Pinboard's list logic reads it, or null for a tile that is not one.
 *
 * The one derivation of these facts. The Pinboard builds its rows on top of it, passing
 * the chips it has already built as `users`; `revealNext` builds them with the board
 * closed. Two copies would be two answers to "which pin is next".
 */
export function rowFacts(
  anchorDoc: any,
  users: RowFacts["users"] = factsUsers(anchorDoc)
): RowFacts | null {
  const pin = readPin(anchorDoc);
  if (!pin) return null;
  return {
    id: anchorDoc.id,
    name: labelFor(pin),
    breadcrumb: describeSource(pin.source).breadcrumb,
    mode: pin.mode,
    // Whether anyone is reached, not whether the kind says "hidden": a selection that
    // names nobody was counted as visible while every chip on its row was hollow.
    visible: isRevealed(anchorDoc, pin),
    hidden: anchorDoc.hidden === true || pin.audience.kind === "hidden",
    elevation: anchorDoc.elevation ?? 0,
    users,
  };
}

const EVERY_ROW: PinboardQuery = { filter: "all", search: "", level: null };

/** The Reveal next in flight, and the scene it is revealing on. */
let revealing: { scene: any; promise: Promise<{ doc: any; left: number }> } | null = null;

/**
 * Reveal the next pin of the scene's script: the first hidden row in the Pinboard's
 * order, under the view the GM is looking at, to the audience it remembers.
 *
 * The Pinboard's order has always been called the reveal order, and nothing consumed it.
 * This is the play button. It reveals through `audience.revealed`, never the eye's
 * toggle: a toggle on a row that is not hidden would hide it, and pressing N twice would
 * take back the clue it had just given.
 *
 * Then it points at the pin, after the reveal has landed, so the table finds it there:
 * the GM's own card pulses, and the ping reaches every client only when the pin is for
 * everyone. A pin for one player is pointed at on the GM's screen alone — a pulse on the
 * others' maps would show them where the rogue's clue lies. It never pulls a view; that
 * is spotlight's decision to make, not a side effect of stepping through a script.
 *
 * Nothing to reveal is said, and said apart from "nothing in this view": the second one
 * means the filter is hiding the rest of the script, which is the GM's to know.
 *
 * One at a time per scene. Two presses faster than a write read the same payloads and
 * chose the same row: the second revealed nothing new, and pinged and said so again. A
 * press while one is in flight now shares its answer.
 */
export function revealNext(
  scene: any,
  query: PinboardQuery = EVERY_ROW
): Promise<{ doc: any; left: number }> {
  if (revealing && revealing.scene === scene) return revealing.promise;
  const promise = revealNextNow(scene, query).finally(() => {
    if (revealing?.promise === promise) revealing = null;
  });
  revealing = { scene, promise };
  return promise;
}

async function revealNextNow(
  scene: any,
  query: PinboardQuery
): Promise<{ doc: any; left: number }> {
  const nothing = { doc: null, left: 0 };
  if (!isGM() || !scene) return nothing;

  const docs = store.all(scene);
  const facts = docs.map((doc) => rowFacts(doc)).filter((row): row is RowFacts => row !== null);
  const { next, left } = nextToReveal(facts, query);
  const doc = next ? docs.find((candidate) => candidate.id === next.id) : null;
  const pin = readPin(doc);
  if (!doc || !pin) {
    const outOfView = facts.some((row) => row.hidden);
    notify(
      { key: outOfView ? "DP.notice.revealNextNoneInView" : "DP.notice.revealNextNone" },
      "info"
    );
    return nothing;
  }

  await setAudience(doc, audience.revealed(pin.audience));
  // A write core refused still resolves; the pin must be out of hiding before anything
  // points at it.
  const after = readPin(doc);
  if (!after || doc.hidden === true || after.audience.kind === "hidden") {
    notify({ key: "DP.notice.revealNextFailed" }, "error");
    return nothing;
  }

  Hooks.callAll(`${MODULE_ID}.flash`, doc);
  pingAt(doc, { broadcast: audience.pingsEveryone(after.audience), pull: false });
  return { doc, left };
}

// ---------------------------------------------------------------------------
// Pings
// ---------------------------------------------------------------------------

/** What a ping did: sent to every client, drawn here only, or not at all and why. */
type PingOutcome = "broadcast" | "local" | "elsewhere" | "outside" | "unavailable";

/** Whether a pin lies on the scene this client is viewing: the only map a ping reaches. */
function onViewedScene(anchorDoc: any): boolean {
  const viewed = cv()?.scene?.id;
  const own = anchorDoc?.parent?.id;
  return !!viewed && (!own || own === viewed);
}

/**
 * Point at a pin. The one door every ping in the module goes through.
 *
 * `canvas.ping` draws here AND on every connected client, and whatever it is not told it
 * reads off the keyboard: core builds `{scene, pull: <Shift held>, style, zoom}` and merges
 * the options over it, so a GM holding Shift pulls every view to the spot. The Pinboard's
 * Shift+Space is exactly a Shift held while pinging. So a broadcast here always states
 * `pull` and `style`, and the keyboard decides nothing the table sees.
 *
 * `handlePing` draws on this client alone — and draws nothing unless it is handed the
 * viewed scene's id, which core compares against the one it is showing.
 *
 * A pin on another scene is not pinged at all: its coordinates on the map being viewed
 * point at nothing, and a ping there would send the table looking for it.
 */
function pingAt(
  anchorDoc: any,
  { broadcast, pull }: { broadcast: boolean; pull: boolean }
): PingOutcome {
  const canvas = cv();
  if (!canvas?.scene?.id || !anchorDoc) return "unavailable";
  if (!onViewedScene(anchorDoc)) return "elsewhere";

  const origin = centreOf(anchorDoc);
  // Core refuses a broadcast outside the scene's rect; the local path is held to the same.
  const rect = canvas.dimensions?.rect;
  if (typeof rect?.contains === "function" && !rect.contains(origin.x, origin.y)) {
    return "outside";
  }

  const types = cfg()?.Canvas?.pings?.types;
  const style = pull ? (types?.PULL ?? "chevron") : (types?.PULSE ?? "pulse");
  const drawn = (ping: unknown) =>
    void Promise.resolve(ping).catch((error) => log.warn("a ping could not be drawn", error));

  try {
    if (broadcast) {
      if (typeof canvas.ping !== "function") return "unavailable";
      drawn(canvas.ping(origin, { pull, style }));
      return "broadcast";
    }
    if (typeof canvas.controls?.handlePing !== "function") return "unavailable";
    drawn(canvas.controls.handlePing(g()?.user, origin, { scene: canvas.scene.id, style }));
    return "local";
  } catch (error) {
    log.warn("a ping could not be drawn", error);
    return "unavailable";
  }
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
 * **Never wrap this in `enqueue`.** `store.update` queues itself on the same anchor id,
 * and `enqueue` chains a task after the tracked promise it has already registered — so an
 * outer task awaiting an inner one on the same id awaits its own completion. Neither ever
 * settles: no error, no timeout, the button simply does nothing forever. `fitToContent`
 * is the shape to copy — a plain async function whose callees queue themselves.
 *
 * The order is the payload, then the grant on the new source, then the release of the
 * old — the same order `setAudience` uses, and for the same reason. It also fails in the
 * safe direction: a half-done retarget leaves a player over-granted on a document they
 * already had access to, where release-first would revoke access to the document the pin
 * is still showing them.
 */
export async function retarget(anchorDoc: any, source: DpSource): Promise<boolean> {
  if (!isGM() || !anchorDoc || refused(source)) return false;

  const before = readPin(anchorDoc);
  if (!before) return false;

  const oldUuid = before.source.uuid;
  const sameDocument =
    before.source.kind === source.kind &&
    before.source.uuid === source.uuid &&
    before.source.src === source.src;
  if (sameDocument) return false;

  // The WHOLE source object, never a partial patch: `mergePin` deep-merges, so omitting
  // `pageId` would leave a page id of the OLD journal pointing into the new one. The
  // same for `field`, which a source built by the picker, a menu or `/pin` does not name:
  // left out, the text the GM chose for one actor would be read off the next — whatever
  // that path holds there, a private biography included — and the automatic choice,
  // which never picks GM text, would never be asked. The texture follows only when the
  // KIND changes: from one document to another, the icon the GM chose for this pin is
  // part of the pin, like its size and its effect.
  const keepIcon = before.source.kind === "document" && source.kind === "document";
  // A pin that comes to show an actor starts with access off, as one placed on it does
  // (DESIGN A28, D2): a journal shared with access on, retargeted onto an NPC, would
  // otherwise list the NPC in every sidebar its audience reaches at the very next sync.
  // Switching off never widens anything. A pin already on an actor keeps what the GM chose
  // for it.
  const syncOff =
    before.audience.ownershipSync.enabled &&
    adapterOf(before.source).syncOnCreate &&
    !adapterOf(source).syncOnCreate;
  await store.update(
    anchorDoc,
    {
      source: { ...source, field: source.field ?? null },
      ...(syncOff
        ? { audience: { ownershipSync: { ...before.audience.ownershipSync, enabled: false } } }
        : {}),
    },
    keepIcon ? {} : { "texture.src": anchorTexture(source) }
  );
  if (syncOff) notify({ key: "DP.notice.retargetSyncOff" }, "info");

  // The old uuid rides along precisely for this: the payload no longer names the old
  // document, so the sync cannot find it on its own any more. One call, not a sync and
  // then a release, because a pin moved between a journal and one of its own pages has
  // an old document and a new one in the same family — and releasing the old family
  // after granting the new one took back the grant just made.
  await syncAnchor(anchorDoc, oldUuid);
  warnIfPlayersCannotRead(source);

  return true;
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
  if (pageUuid) {
    return {
      kind: "document",
      uuid: pageUuid,
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    };
  }
  const entryUuid = noteDoc?.entry?.uuid;
  if (entryUuid) {
    return {
      kind: "document",
      uuid: entryUuid,
      src: null,
      pageId: typeof noteDoc.pageId === "string" ? noteDoc.pageId : null,
      pdfPage: null,
      followName: true,
    };
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
