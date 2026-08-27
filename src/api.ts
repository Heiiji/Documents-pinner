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

import { MODULE_ID } from "./const";
import { cv, g, isGM, notify, playerIds, resolveUuid, resolveUuidSync } from "./fvtt";
import * as audience from "./data/audience";
import * as store from "./data/PinStore";
import { readPin } from "./data/PinData";
import { defaultPin, type PinPatch } from "./data/pin-schema";
import { releaseAnchor, syncAnchor } from "./data/ownership-sync";
import * as settings from "./settings";
import type { DpAudience, DpMode, DpPinFlags, DpSource } from "./types/dp";

declare const Hooks: any;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const DOCUMENT_SOURCES = ["JournalEntry", "JournalEntryPage"];

/**
 * A pin source from a sidebar drag payload.
 *
 * v1 pins journals, journal pages and bare image files. Actors, items and tables are a
 * later adapter; returning `null` for them lets the drop fall through to whatever core
 * or another module would have done, rather than producing a pin of the wrong thing.
 */
export function sourceFromDropData(data: any): DpSource | null {
  if (!data) return null;

  if (data.type === "JournalEntryPage" && data.uuid) {
    return { kind: "document", uuid: data.uuid, src: null, pageId: null, followName: true };
  }
  if (data.type === "JournalEntry" && data.uuid) {
    return {
      kind: "document",
      uuid: data.uuid,
      src: null,
      pageId: typeof data.pageId === "string" ? data.pageId : null,
      followName: true,
    };
  }
  // The file browser and an OS file drag both arrive as a bare path.
  const path = data.src ?? data.path ?? (typeof data === "string" ? data : null);
  if (typeof path === "string" && path) {
    return { kind: "image", uuid: null, src: path, pageId: null, followName: false };
  }
  return null;
}

export function sourceFromDocument(doc: any): DpSource | null {
  if (!doc?.uuid || !DOCUMENT_SOURCES.includes(doc.documentName)) return null;
  return { kind: "document", uuid: doc.uuid, src: null, pageId: null, followName: true };
}

/** The document a pin points at, or `null` for an image source or a deleted target. */
export async function resolveSource(pin: DpPinFlags): Promise<any> {
  if (pin.source.kind !== "document") return null;
  const doc = await resolveUuid(pin.source.uuid);
  if (!doc) return null;
  if (pin.source.pageId && doc.pages?.get) return doc.pages.get(pin.source.pageId) ?? doc;
  return doc;
}

/** The synchronous form, for render paths. Returns `null` rather than awaiting. */
export function resolveSourceSync(pin: DpPinFlags): any {
  if (pin.source.kind !== "document") return null;
  const doc = resolveUuidSync(pin.source.uuid);
  if (!doc) return null;
  if (pin.source.pageId && doc.pages?.get) return doc.pages.get(pin.source.pageId) ?? doc;
  return doc;
}

/**
 * What to write on the pin.
 *
 * An explicit label always wins. Otherwise the source's own name is used and kept in
 * step with it, which is what `followName` is for — a GM who renames "Letter" to "The
 * Duke's Letter" should not have to find every pin of it.
 */
/** The label for a source that has no pin yet — the placement ghost's chip. */
export function labelForSource(source: DpSource): string {
  if (source.kind === "image" && source.src) {
    return decodeURIComponent(source.src.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
  }
  const doc = resolveUuidSync(source.uuid);
  return doc?.name ?? g()?.i18n?.localize?.("DP.pin.untitled") ?? "Pin";
}

export function labelFor(pin: DpPinFlags): string {
  if (pin.display.label) return pin.display.label;
  const source = resolveSourceSync(pin);
  if (source?.name) return source.name;
  if (pin.source.kind === "image" && pin.source.src) {
    return decodeURIComponent(pin.source.src.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
  }
  return g()?.i18n?.localize?.("DP.pin.untitled") ?? "Pin";
}

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
  /** Place centred on (x, y) rather than with its top-left corner there. */
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
  if (!isGM() || !scene) return null;

  const mode = at.mode ?? settings.get("defaultMode");
  const grid = scene.grid?.size ?? 100;
  const width = at.width ?? (mode === "pin" ? grid : grid * 4);
  const height = at.height ?? (mode === "pin" ? grid : Math.round(grid * 4 * 1.414));

  const kind = at.audienceKind ?? settings.get("defaultAudience");
  const pin: DpPinFlags = {
    ...defaultPin(),
    mode,
    source,
    audience: audience.makeAudience({
      kind,
      ownershipSync: {
        enabled: settings.get("defaultOwnershipSync"),
        level: 2,
      },
    }),
    effect: { ...defaultPin().effect, id: at.effectId ?? settings.get("lastPreset") },
  };

  const anchor = await store.place(scene, pin, {
    x: at.centred ? at.x - width / 2 : at.x,
    y: at.centred ? at.y - height / 2 : at.y,
    width,
    height,
    rotation: at.rotation ?? 0,
    elevation: at.elevation ?? 0,
    sort: nextSort(scene),
    texture: mode === "pin" ? pinTexture(source) : (source.src ?? null) || undefined,
  });

  if (anchor) {
    await syncAnchor(anchor);
    if (source.uuid) await settings.set("lastSourceUuid", source.uuid);
  }
  return anchor;
}

/** New pins land at the end of the reveal order, which is where a GM expects them. */
function nextSort(scene: any): number {
  const existing = store.all(scene);
  return existing.length ? (existing[existing.length - 1].sort ?? 0) + 10 : 0;
}

/** The icon a pin shows. An image source shows itself; a document shows a book. */
function pinTexture(source: DpSource): string {
  return source.kind === "image" && source.src ? source.src : "icons/svg/book.svg";
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
  await store.update(anchorDoc, { audience: next });
  await syncAnchor(anchorDoc);
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
 */
export function canUserOpen(anchorDoc: any, userId: string): boolean {
  const pin = readPin(anchorDoc);
  if (!pin) return false;
  if (pin.source.kind === "image") return canUserSee(anchorDoc, userId);
  if (pin.interaction.open === "never") return false;

  const source = resolveSourceSync(pin);
  const user = g()?.users?.get(userId);
  if (!source || !user) return false;
  // OBSERVER is the level at which a text page actually opens; LIMITED is the tease.
  return source.testUserPermission?.(user, "OBSERVER") === true;
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

  const source = await resolveSource(pin);
  if (!source) return;

  const recipients = playerIds().filter((id) => canUserSee(anchorDoc, id));
  if (!recipients.length) return;

  const Journal =
    (globalThis as any).Journal ?? (globalThis as any).foundry?.documents?.collections?.Journal;
  if (Journal?.show) await Journal.show(source, { force: true, users: recipients });
  else notify({ key: "DP.notice.showUnavailable" }, "warn");
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

  if (pin.mode === "prop" || pin.interaction.open === "readInPlace") {
    Hooks.call(`${MODULE_ID}.openReader`, anchorDoc);
    return;
  }

  const source = await resolveSource(pin);
  if (!source?.sheet) {
    notify({ key: "DP.notice.sourceMissing" }, "warn");
    return;
  }
  // A page opens inside its parent's sheet, which is where its navigation lives.
  if (source.documentName === "JournalEntryPage" && source.parent?.sheet) {
    source.parent.sheet.render(true, { pageId: source.id });
    return;
  }
  source.sheet.render(true, pin.source.pageId ? { pageId: pin.source.pageId } : undefined);
}

/**
 * Draw attention to a pin on every connected client.
 *
 * `canvas.ping` already displays locally and remotely, so the flash costs no socket of
 * our own — and it lands for players who can see the pin and is simply invisible
 * against a hidden one, which is the behaviour a GM wants anyway.
 */
export function flash(anchorDoc: any): void {
  const canvas = cv();
  if (!canvas?.ping || !anchorDoc) return;
  canvas.ping({
    x: anchorDoc.x + anchorDoc.width / 2,
    y: anchorDoc.y + anchorDoc.height / 2,
  });
}

/** Pan and zoom to a pin, then flash it. The Pinboard's locate action. */
export async function locate(anchorDoc: any): Promise<void> {
  const canvas = cv();
  if (!canvas?.animatePan || !anchorDoc) return;
  await canvas.animatePan({
    x: anchorDoc.x + anchorDoc.width / 2,
    y: anchorDoc.y + anchorDoc.height / 2,
    scale: Math.min(1, canvas.stage?.scale?.x ?? 1) < 0.6 ? 0.8 : undefined,
  });
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

/** Adopt an existing tile as a pin — the one-click path from the Tile config sheet. */
export async function adoptTile(tileDoc: any, source: DpSource): Promise<void> {
  if (!isGM() || !tileDoc) return;
  const pin: DpPinFlags = {
    ...defaultPin(),
    mode: tileDoc.width > (tileDoc.parent?.grid?.size ?? 100) * 1.5 ? "prop" : "pin",
    source,
    audience: audience.makeAudience({ kind: tileDoc.hidden ? "hidden" : "everyone" }),
  };
  await store.attach(tileDoc, pin);
  await syncAnchor(tileDoc);
}

/** The surface exposed on the module entry, and to other modules. */
export function publicApi() {
  return {
    MODULE_ID,
    pinAt,
    adoptTile,
    setAudience,
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
    locate,
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
