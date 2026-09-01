/**
 * CRUD over the anchor TileDocuments.
 *
 * IMPURE: this is the only module that writes a pin. Three rules hold it together.
 *
 * 1. **Every write carries `INTERNAL_OPTION`**, and every hook in the module early-
 *    returns on it. Without that, writing `hidden` in response to an audience change
 *    re-enters the audience handler and the module argues with itself.
 *
 * 2. **Writes are serialised per anchor.** Two overlapping edits to the same pin —
 *    a HUD chip click landing while a Pin Studio field is still saving — would each
 *    read the payload, patch their own copy and write the whole thing back, and the
 *    slower one would silently undo the faster. The queue makes that impossible
 *    without holding a lock across an await in the caller.
 *
 * 3. **`hidden` is derived, never set by hand.** The core field and our audience must
 *    agree, so the single place they are written is here, together, in one update.
 *
 * Bulk edits go through `batchUpdate`: one `Scene#updateEmbeddedDocuments` for N pins
 * rather than N awaited calls, because the Pinboard's "reveal all" is one gesture over
 * a whole scene and N round trips would show up as a visible stagger on every client.
 */

import { DELETE_PREFIX, FLAGS, MODULE_ID } from "../const";
import { g, internal } from "../fvtt";
import type { DpMode, DpPinFlags } from "../types/dp";
import { anchorHidden } from "./audience";
import { readPin } from "./PinData";
import {
  defaultPin,
  freezeMetrics,
  mergePin,
  naturalSize,
  validatePin,
  type PinPatch,
} from "./pin-schema";

// ---------------------------------------------------------------------------
// Per-anchor serialisation
// ---------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();

/**
 * Chain `task` after any in-flight work for this anchor.
 *
 * The tracked chain swallows rejections — the caller handles the outcome of the
 * promise it is returned — because otherwise every failed task would also raise an
 * unhandled rejection.
 */
export function enqueue<T>(anchorId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(anchorId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tracked = run
    .catch(() => {})
    .then(() => {
      if (queues.get(anchorId) === tracked) queues.delete(anchorId);
    });
  queues.set(anchorId, tracked);
  return run;
}

/**
 * Chain a task after the in-flight work of EVERY anchor it touches.
 *
 * The bulk path needs this: `batchUpdate` reads N payloads and writes them in one scene
 * update, and reading them outside the queue meant a Pinboard "reveal all" landing while
 * a HUD chip toggle was still in flight read the stale payload and clobbered it — the
 * exact failure the per-anchor queue exists to prevent, arrived at by the one writer that
 * did not use it.
 *
 * Registering the same tracked promise on every anchor's queue also makes the ordering
 * work in the other direction: a chip click arriving mid-batch waits for the batch.
 */
export function enqueueAll<T>(anchorIds: readonly string[], task: () => Promise<T>): Promise<T> {
  const ids = [...new Set(anchorIds)].filter(Boolean);
  if (!ids.length) return task();

  const previous = Promise.allSettled(ids.map((id) => queues.get(id) ?? Promise.resolve()));
  const run = previous.then(task);
  const tracked = run
    .catch(() => {})
    .then(() => {
      for (const id of ids) if (queues.get(id) === tracked) queues.delete(id);
    });

  for (const id of ids) queues.set(id, tracked);
  return run;
}

/** Resolves once every queued write has settled. Used by tests and the ready sweep. */
export async function settled(): Promise<void> {
  await Promise.allSettled([...queues.values()]);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every anchor on a scene, in `sort` order — which is the Pinboard's reveal order. */
export function all(scene: any): any[] {
  const tiles = scene?.tiles?.contents ?? [];
  return tiles
    .filter((tile: any) => tile?.flags?.[MODULE_ID]?.[FLAGS.PIN])
    .sort((a: any, b: any) => (a.sort ?? 0) - (b.sort ?? 0));
}

export function read(doc: any): DpPinFlags | null {
  return readPin(doc);
}

/** The anchor's own UUID, which is the key the ownership ledger counts holders by. */
export function anchorUuid(doc: any): string {
  return doc?.uuid ?? "";
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PlaceOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  elevation?: number;
  sort?: number;
  locked?: boolean;
  alpha?: number;
  /** Texture for pin mode and for the placeholder a prop shows before it rasterises. */
  texture?: string;
}

/** The tile fields a pin owns. Everything else on the TileDocument stays core's. */
function anchorFields(pin: DpPinFlags, options: PlaceOptions): Record<string, unknown> {
  return {
    x: Math.round(options.x),
    y: Math.round(options.y),
    width: Math.max(1, Math.round(options.width)),
    height: Math.max(1, Math.round(options.height)),
    rotation: options.rotation ?? 0,
    elevation: options.elevation ?? 0,
    sort: options.sort ?? 0,
    locked: options.locked ?? false,
    alpha: options.alpha ?? 1,
    hidden: anchorHidden(pin.audience),
    texture: { src: options.texture ?? null },
    [`flags.${MODULE_ID}.${FLAGS.PIN}`]: pin,
  };
}

/**
 * Create an anchor. Returns the created TileDocument, or `null` if the scene refused.
 *
 * The payload is validated before it is written, so a caller passing a half-built pin
 * cannot persist one — the anchor either carries a payload this version understands or
 * it is not created at all.
 */
export async function place(
  scene: any,
  pin: Partial<DpPinFlags>,
  options: PlaceOptions
): Promise<any> {
  const validated = validatePin({ ...defaultPin(), ...pin }).pin;
  const [created] = await scene.createEmbeddedDocuments(
    "Tile",
    [anchorFields(validated, options)],
    internal()
  );
  return created ?? null;
}

/**
 * Patch a pin's payload.
 *
 * Writes the whole normalised payload rather than a sub-path diff: the queue already
 * guarantees no concurrent writer, and a whole-object write is the only form that
 * cannot leave a partially-migrated payload behind when the schema changes.
 */
export function update(doc: any, patch: PinPatch): Promise<any> {
  return enqueue(doc?.id ?? "", async () => {
    const current = readPin(doc);
    if (!current) return null;

    const { pin } = mergePin(current, patch);
    return doc.update(
      {
        hidden: anchorHidden(pin.audience),
        [`flags.${MODULE_ID}.${FLAGS.PIN}`]: pin,
      },
      internal()
    );
  });
}

/**
 * Switch between pin and prop on the anchor that is already there.
 *
 * One atomic `Tile#update`, which is the entire reason the anchor is a Tile: the
 * `_id` survives, so every UUID referencing this pin still resolves, core undo still
 * works, and the Pinboard row does not blink out and come back.
 *
 * The size being left is remembered before the size being entered is applied, so a GM
 * who hand-resized a prop gets that prop back rather than a freshly derived one.
 */
export function convertMode(
  doc: any,
  mode: DpMode,
  fallback?: { width: number; height: number }
): Promise<any> {
  return enqueue(doc?.id ?? "", async () => {
    const current = readPin(doc);
    if (!current || current.mode === mode) return null;

    const remembered = {
      ...current.geometry,
      [current.mode]: { width: doc.width, height: doc.height },
    };
    const target = remembered[mode] ?? fallback ?? derivedSize(mode);
    const merged = mergePin(current, { mode, geometry: remembered }).pin;
    // An anchor becoming a prop for the first time has no stored type: freeze the
    // proportional look at the size it is entering, so it draws as it always would have
    // and the NEXT resize is a change of window.
    const pin = mode === "prop" ? freezeMetrics(merged, target) : merged;

    return doc.update(
      {
        width: Math.max(1, Math.round(target.width)),
        height: Math.max(1, Math.round(target.height)),
        [`flags.${MODULE_ID}.${FLAGS.PIN}`]: pin,
      },
      internal()
    );
  });
}

/**
 * Resize the anchor. The one write that touches nothing but the box.
 *
 * `geometry` is deliberately not written here: it is read only when RETURNING to a
 * mode, and `convertMode` captures the live size on the way out, so a copy written now
 * could only ever disagree with the tile.
 */
export function resize(doc: any, size: { width: number; height: number }): Promise<any> {
  return enqueue(doc?.id ?? "", async () => {
    if (!readPin(doc)) return null;
    return doc.update(
      {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
      },
      internal()
    );
  });
}

/** The grid this scene uses, or a sane stand-in outside a canvas. */
function derivedSize(mode: DpMode): { width: number; height: number } {
  const grid = g()?.canvas?.scene?.grid?.size ?? g()?.scenes?.current?.grid?.size ?? 100;
  return naturalSize(mode, grid);
}

/**
 * Apply one patch to many anchors in a single scene write.
 *
 * The Pinboard's bulk actions are the reason this exists: "reveal to all" over a dozen
 * pins must land as one change on every client, not a dozen staggered ones.
 */
export function batchUpdate(scene: any, entries: { doc: any; patch: PinPatch }[]): Promise<any[]> {
  // Through the queue, like every other writer. The payloads are read INSIDE it, so a
  // bulk reveal landing on top of an in-flight chip toggle sees that toggle's result
  // rather than the payload as it was before.
  return enqueueAll(
    entries.map(({ doc }) => doc?.id ?? ""),
    async () => {
      const updates = entries
        .map(({ doc, patch }) => {
          const current = readPin(doc);
          if (!current) return null;
          const { pin } = mergePin(current, patch);
          return {
            _id: doc.id,
            hidden: anchorHidden(pin.audience),
            [`flags.${MODULE_ID}.${FLAGS.PIN}`]: pin,
          };
        })
        .filter(Boolean);

      if (!updates.length) return [];
      return scene.updateEmbeddedDocuments("Tile", updates, internal());
    }
  );
}

/**
 * Write a payload onto a tile that does not have one yet.
 *
 * `update` deliberately refuses a tile that is not already a pin, so adopting an
 * existing tile — including one made by another module — needs its own verb rather
 * than a special case inside the patch path.
 */
export function attach(doc: any, pin: DpPinFlags): Promise<any> {
  return enqueue(doc?.id ?? "", async () => {
    const validated = validatePin(pin).pin;
    return doc.update(
      {
        hidden: anchorHidden(validated.audience),
        [`flags.${MODULE_ID}.${FLAGS.PIN}`]: validated,
      },
      internal()
    );
  });
}

/** Remove the pin payload but keep the tile, turning an anchor back into a plain tile. */
export function unpin(doc: any): Promise<any> {
  return enqueue(doc?.id ?? "", () =>
    doc.update({ [`flags.${MODULE_ID}.${DELETE_PREFIX}${FLAGS.PIN}`]: null }, internal())
  );
}

/** Delete the anchor entirely. The source document is never touched. */
export function remove(doc: any): Promise<any> {
  return enqueue(doc?.id ?? "", () => doc.delete(internal()));
}
