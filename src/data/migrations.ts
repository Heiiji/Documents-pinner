/**
 * Schema migration.
 *
 * `validatePin` already normalises on every read, so nothing here is needed to make an
 * old world *work*. What it is needed for is to make an old world *look* migrated:
 * until the normalised payload is written back, the flag other modules read, the copy
 * in an exported scene and the one a GM inspects in the console all still carry the
 * old shape. Migration is therefore "persist what we would have read anyway".
 *
 * Three properties, in the order they matter:
 *
 * 1. **Idempotent.** A tile is only rewritten when its stored payload differs from its
 *    validated form, compared key-order-independently. Running twice writes nothing
 *    the second time, so a crash mid-sweep costs nothing.
 * 2. **GM-only, and only one GM.** Four connected GMs must produce one sweep, not four.
 * 3. **Never automatic across the world.** The active scene is migrated silently
 *    because it is about to be drawn anyway. Every other scene is offered, because
 *    rewriting hundreds of documents in a world someone just opened is not a decision
 *    a module gets to make on its own.
 *
 * Version 2 stores the type size that version 1 derived from the tile. The sweep writes
 * the number each prop is ALREADY drawn at, so it changes nothing on any map — it only
 * makes the next resize a change of window rather than a change of zoom. A pin-mode
 * anchor with no remembered prop size is left to decide when it becomes a prop.
 *
 * Version 3 changes nothing in the payload and one thing on the tile: the point of every
 * prop that was drawn as a card moves by half a box, so the paper stays exactly where the
 * GM left it and core's frame — which was always half a box away — joins it there. See
 * `reanchor`.
 *
 * `planMigration` is pure and unit-tested; everything below it performs the writes.
 */

import { logger } from "../log";
import { FLAGS, MODULE_ID, SCHEMA_VERSION } from "../const";
import { g, internal, isPrimaryGM, notify } from "../fvtt";
import * as settings from "../settings";
import { resolveSourceSync } from "../api";
import { pdfSourceOf } from "../render/PdfPage";
import { docPositionFor } from "../canvas/transform";
import { freezeMetrics, validatePin } from "./pin-schema";
import type { DpPinFlags } from "../types/dp";

/** The payload version from which a document's point is stored as the tile's centre. */
const CENTRE_VERSION = 3;

const log = logger("migrate");

/** JSON with object keys in a stable order, so key order alone never forces a write. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface MigrationUpdate {
  _id: string;
  [flagPath: string]: unknown;
}

export interface MigrationOptions {
  /**
   * Whether a prop was drawn as a card over the canvas — with the document's point as
   * its top-left corner — before version 3 read that point as the centre core always
   * took it for. Defaults to never, which is right for a pure caller with no client to
   * ask and wrong for a world; `migrateScene` passes the real answer.
   */
  drawnAsCard?: (pin: DpPinFlags) => boolean;
}

/**
 * PURE. Given tile-like records, return the updates that would bring their payloads to
 * the current schema — an empty array when there is nothing to do.
 */
export function planMigration(
  tiles: readonly any[],
  options: MigrationOptions = {}
): MigrationUpdate[] {
  const updates: MigrationUpdate[] = [];

  for (const tile of tiles) {
    const stored = tile?.flags?.[MODULE_ID]?.[FLAGS.PIN];
    if (stored === null || stored === undefined) continue;

    const validated = validatePin(stored).pin;
    const size = propSizeOf(tile, validated);
    const pin = size ? freezeMetrics(validated, size) : validated;
    const moved = reanchor(tile, stored, pin, options);
    if (!moved && stable(pin) === stable(stored)) continue;

    updates.push({
      _id: tile.id,
      [`flags.${MODULE_ID}.${FLAGS.PIN}`]: pin,
      ...(moved ?? {}),
    });
  }

  return updates;
}

/**
 * Version 3: the paper stays where it is.
 *
 * Until 0.2.2 a card was placed with the document's point as its top-left corner, while
 * core drew the tile — its frame, its handles, its own hit test — about that point. The
 * two were half a box apart, and the paper is the one the GM placed by eye. So a prop
 * that was a card has its point moved to where the paper's centre already was, which is
 * where core will now draw the frame too. Rotation changes nothing: the card turned about
 * its own centre, and that centre is the one point both readings agree on.
 *
 * A PDF was core's texture on core's mesh, drawn about the point, and stays put; so does
 * a pin-mode icon, drawn by core; so does anything written at version 3 or later.
 */
function reanchor(
  tile: any,
  stored: any,
  pin: DpPinFlags,
  options: MigrationOptions
): { x: number; y: number } | null {
  const version = Number(stored?.v);
  if (Number.isFinite(version) && version >= CENTRE_VERSION) return null;
  if (pin.mode !== "prop" || !options.drawnAsCard?.(pin)) return null;

  const box = { x: Number(tile?.x), y: Number(tile?.y), width: Number(tile?.width), height: Number(tile?.height) };
  if (!Object.values(box).every(Number.isFinite)) return null;
  const centre = docPositionFor(box);
  return { x: Math.round(centre.x), y: Math.round(centre.y) };
}

/**
 * Whether a prop has been drawn as a card on this client.
 *
 * HTML never reaches a texture — an SVG `foreignObject` taints the canvas, DESIGN A10 —
 * so every prop but a PDF was a card. A PDF was a texture on the tile's mesh, drawn by
 * core about the point, unless this client had chosen the DOM path for everything.
 */
function drawnAsCard(pin: DpPinFlags): boolean {
  if (settings.get("rendering") === "dom") return true;
  return pdfSourceOf(resolveSourceSync(pin)) === null;
}

/**
 * The size a pin's PROP look is drawn at: the tile's own for a prop, the remembered
 * prop size for a pin-mode anchor, or nothing — in which case there is no look to
 * freeze and `convertMode` does it on the way in.
 */
function propSizeOf(tile: any, pin: DpPinFlags): { width: number; height: number } | null {
  if (pin.mode === "prop") {
    const width = Number(tile?.width);
    const height = Number(tile?.height);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return pin.geometry.prop;
}

/** How many pins on this scene would be rewritten. Used to size the offer. */
export function pendingCount(scene: any): number {
  return planMigration(scene?.tiles?.contents ?? [], { drawnAsCard }).length;
}

/** Migrate one scene. Returns the number of anchors rewritten. */
export async function migrateScene(scene: any): Promise<number> {
  const updates = planMigration(scene?.tiles?.contents ?? [], { drawnAsCard });
  if (!updates.length) return 0;

  await scene.updateEmbeddedDocuments("Tile", updates, internal());
  const moved = updates.filter((update) => "x" in update).length;
  log.info(
    `migrated ${updates.length} pin(s) on "${scene.name}"` +
      (moved ? `, re-anchored ${moved} prop(s) at the paper's centre` : "")
  );
  // Said once, because a GM who has just seen the frame jump onto the paper deserves to
  // know that the map did not change.
  if (moved) notify({ key: "DP.migration.reanchored", data: { count: moved } });
  return updates.length;
}

/**
 * Migrate every scene in the world, active or not.
 *
 * Sequential on purpose: each scene is one server round trip, and firing them all at
 * once on a world with fifty scenes is how a migration turns into a timeout.
 */
export async function migrateWorld(): Promise<number> {
  let total = 0;
  for (const scene of g()?.scenes?.contents ?? []) {
    total += await migrateScene(scene);
  }
  await settings.set("schemaVersion", SCHEMA_VERSION);
  return total;
}

/** Scenes other than `active` that still hold un-migrated payloads. */
export function scenesNeedingMigration(active: any): any[] {
  return (g()?.scenes?.contents ?? []).filter(
    (scene: any) => scene?.id !== active?.id && pendingCount(scene) > 0
  );
}

/**
 * The `canvasReady` entry point.
 *
 * Silent for the scene being drawn; an offer for the rest. The offer is made once per
 * session rather than once per scene change, because a GM flipping between scenes
 * during prep should not be asked the same question every time.
 */
let offeredThisSession = false;

export async function onCanvasReady(scene: any): Promise<void> {
  if (!isPrimaryGM() || !scene) return;

  await migrateScene(scene);

  if (offeredThisSession) return;
  if (settings.get("schemaVersion") >= SCHEMA_VERSION && !scenesNeedingMigration(scene).length) {
    return;
  }

  const outstanding = scenesNeedingMigration(scene);
  if (!outstanding.length) {
    await settings.set("schemaVersion", SCHEMA_VERSION);
    return;
  }

  offeredThisSession = true;
  const total = outstanding.reduce((sum, s) => sum + pendingCount(s), 0);
  const confirmed = await confirmSweep(outstanding.length, total);
  if (confirmed) {
    const migrated = await migrateWorld();
    notify({ key: "DP.migration.done", data: { count: migrated } });
  }
}

/**
 * Ask before rewriting documents on scenes the GM has not opened.
 *
 * Falls back to declining if this build has no DialogV2: a migration that cannot ask
 * must not proceed, and declining costs nothing because reads normalise anyway.
 */
async function confirmSweep(sceneCount: number, pinCount: number): Promise<boolean> {
  const DialogV2 = (globalThis as any).foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.confirm) return false;

  const i18n = g()?.i18n;
  return DialogV2.confirm({
    window: { title: i18n?.localize?.("DP.migration.title") ?? "Documents Pinner" },
    content: `<p>${i18n?.format?.("DP.migration.prompt", { sceneCount, pinCount }) ?? ""}</p>`,
    yes: { default: true },
  }).catch(() => false);
}
