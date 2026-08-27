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
 * `planMigration` is pure and unit-tested; everything below it performs the writes.
 */

import { FLAGS, MODULE_ID, SCHEMA_VERSION } from "../const";
import { g, internal, isPrimaryGM, notify } from "../fvtt";
import * as settings from "../settings";
import { validatePin } from "./pin-schema";

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

/**
 * PURE. Given tile-like records, return the updates that would bring their payloads to
 * the current schema — an empty array when there is nothing to do.
 */
export function planMigration(tiles: readonly any[]): MigrationUpdate[] {
  const updates: MigrationUpdate[] = [];

  for (const tile of tiles) {
    const stored = tile?.flags?.[MODULE_ID]?.[FLAGS.PIN];
    if (stored === null || stored === undefined) continue;

    const { pin } = validatePin(stored);
    if (stable(pin) === stable(stored)) continue;

    updates.push({
      _id: tile.id,
      [`flags.${MODULE_ID}.${FLAGS.PIN}`]: pin,
    });
  }

  return updates;
}

/** How many pins on this scene would be rewritten. Used to size the offer. */
export function pendingCount(scene: any): number {
  return planMigration(scene?.tiles?.contents ?? []).length;
}

/** Migrate one scene. Returns the number of anchors rewritten. */
export async function migrateScene(scene: any): Promise<number> {
  const updates = planMigration(scene?.tiles?.contents ?? []);
  if (!updates.length) return 0;

  await scene.updateEmbeddedDocuments("Tile", updates, internal());
  console.log(`${MODULE_ID} | migrated ${updates.length} pin(s) on "${scene.name}"`);
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
