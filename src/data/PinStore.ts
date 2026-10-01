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
 *    without holding a lock across an await in the caller — provided the change is
 *    DECIDED inside it too: a whole audience built from a payload read before the queue
 *    was reached is ordered correctly and wrong all the same (`updateWith`, A29).
 *
 * 3. **`hidden` is derived, never set by hand.** The core field and our audience must
 *    agree, so the module writes them here, together, in one update — and only when the
 *    audience changes. Core's own hide and show are folded into the audience as they are
 *    made (`core-hidden.ts`).
 *
 * Bulk edits go through `batchUpdate`: one `Scene#updateEmbeddedDocuments` for N pins
 * rather than N awaited calls, because the Pinboard's "reveal all" is one gesture over
 * a whole scene and N round trips would show up as a visible stagger on every client.
 */

import { FLAGS, MODULE_ID } from "../const";
import { deletionUpdate, g, internal } from "../fvtt";
import { centreAfterResize } from "../canvas/transform";
import type { DpMode, DpPinFlags } from "../types/dp";
import { anchorHidden } from "./audience";
import { rawPinFlag, readPin } from "./PinData";
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
 * The queue a pin's writes wait in: its uuid, which names it on one scene. Not its id — a
 * duplicated scene keeps every tile's id, so a write to one twin waited behind the other's.
 * Exported for the migration, which waits on every pin of a scene.
 */
export const queueKey = (doc: any): string => String(doc?.uuid ?? doc?.id ?? "");

/**
 * Chain `task` after any in-flight work for this anchor.
 *
 * The tracked chain swallows rejections — the caller handles the outcome of the
 * promise it is returned — because otherwise every failed task would also raise an
 * unhandled rejection.
 */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tracked = run
    .catch(() => {})
    .then(() => {
      if (queues.get(key) === tracked) queues.delete(key);
    });
  queues.set(key, tracked);
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
export function enqueueAll<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const ids = [...new Set(keys)].filter(Boolean);
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

/** Resolves once every queued write has settled. A test seam. */
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

const PIN_PATH = `flags.${MODULE_ID}.${FLAGS.PIN}`;

/**
 * Every key path `stored` has and `next` does not, dotted, relative to the payload. PURE.
 *
 * Only plain objects are walked: an array or a scalar is replaced whole by the write.
 */
function stalePaths(stored: unknown, next: unknown, prefix = ""): string[] {
  if (!isRecord(stored) || !isRecord(next)) return [];
  const out: string[] = [];
  for (const key of Object.keys(stored)) {
    // A key no path can name is left alone; v14 expands every dotted key it stores.
    if (key.includes(".") || key.startsWith("-=")) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (next[key] === undefined) out.push(path);
    else out.push(...stalePaths(stored[key], next[key], path));
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The whole payload as one write, AND the removal of every key the stored one has and it
 * does not.
 *
 * A whole-object write was meant to be the form that "cannot leave a partially-migrated
 * payload behind". On v14 it can: a flag change is DIFFED against the stored value and then
 * merged (foundry.mjs 14.368, `ObjectField#_updateDiff` 10600-10625, `_diffObject`
 * 1892-1913), and a key the new object simply lacks is not a difference. So every 0.1.x
 * pin kept `interaction.clickThrough` — read as `open: "never"` — through every write and
 * every migration, and the migration was offered again every session.
 *
 * Each stale key is deleted with the operator `unpin` and the ledger already use at a flag
 * path, never a `ForcedReplacement` of the payload, which is unmeasured inside flags. The
 * deletions come AFTER the payload in the update, because core expands the dotted keys in
 * order and each one lands inside the object the payload key put there. The payload is
 * copied first, so that expansion can never write an operator into the caller's object.
 */
export function payloadWrite(stored: unknown, pin: DpPinFlags): Record<string, unknown> {
  const write: Record<string, unknown> = { [PIN_PATH]: structuredClone(pin) };
  for (const path of stalePaths(stored, pin)) {
    const at = path.lastIndexOf(".");
    const parent = at < 0 ? PIN_PATH : `${PIN_PATH}.${path.slice(0, at)}`;
    Object.assign(write, deletionUpdate(parent, path.slice(at + 1)));
  }
  return write;
}

/**
 * The core `hidden` a patch implies: derived from the audience when the patch changes the
 * audience, and left alone when it does not.
 *
 * Deriving it on EVERY write put a pin the GM had hidden with core's own controls back on
 * every player's screen at the next intensity tweak or label edit. `core-hidden.ts` now
 * folds such a hide into the audience as it is made; this is the guard for a pin hidden
 * while the module was not listening.
 */
function hiddenFor(patch: PinPatch, pin: DpPinFlags): { hidden?: boolean } {
  return patch.audience === undefined ? {} : { hidden: anchorHidden(pin.audience) };
}

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
 * guarantees no concurrent writer, and a whole-object write — with the deletion of every
 * key it dropped, `payloadWrite` — is the only form that cannot leave a partially-migrated
 * payload behind when the schema changes.
 *
 * `fields` carries the tile fields a payload change IMPLIES, in the same document
 * update. Today that is only `texture.src`, when re-sourcing changes the kind — and it
 * has to be the same update, because the two must never disagree: core gives a tile with
 * no valid texture no mesh at all (see `PLACEHOLDER_TEXTURE`), and a payload saying
 * "image" beside a texture still saying `book.svg` draws a placeholder over a source
 * that has one. Two separate `doc.update` calls would leave a frame in between where
 * they do.
 */
export function update(
  doc: any,
  patch: PinPatch,
  fields: Record<string, unknown> = {}
): Promise<any> {
  return enqueue(queueKey(doc), async () => {
    const current = readPin(doc);
    if (!current) return null;
    return writePatch(doc, current, patch, fields);
  });
}

/** One patch merged onto the payload the queue found, with the tile fields it implies. */
function writePatch(
  doc: any,
  current: DpPinFlags,
  patch: PinPatch,
  fields: Record<string, unknown>
): Promise<any> {
  const { pin } = mergePin(current, patch);
  return doc.update(
    { ...fields, ...hiddenFor(patch, pin), ...payloadWrite(rawPinFlag(doc), pin) },
    internal()
  );
}

/**
 * A patch decided from the payload as the queue finds it: `null` writes nothing. Its
 * caller sees the result, so it can collect what it decided as well.
 */
export type PatchOf<P extends PinPatch = PinPatch> = (current: DpPinFlags) => P | null;

/** What `updateWith` did: the payload it decided from, the patch it wrote, the update. */
export interface UpdateOutcome<P extends PinPatch = PinPatch> {
  /** The payload the patch was decided from, or null for a tile that is not a pin. */
  before: DpPinFlags | null;
  /** The patch written, or null when nothing was. */
  patch: P | null;
  /** What the document update resolved to; null when nothing was written. */
  result: any;
}

/**
 * Patch a pin with a change that depends on what the pin holds NOW (DESIGN A29).
 *
 * `update` serialises the write, but every caller that built a whole audience did it from
 * a payload read BEFORE its turn in the queue, and `mergePin` replaces an array whole. So
 * two chip clicks in one tick — hide it from Ali, hide it from Ben — each read the same
 * `everyone`, each wrote a list of everybody else, and the second put Ali back. The queue
 * ordered two writes that had already been decided wrong.
 *
 * `fn` is the decision, and it runs inside the queue, on the payload the previous write
 * left. `fields` are the tile fields the write implies, as for `update`; given as a
 * function, they are decided from the same payload. The return value is not `update`'s —
 * `patch()` hands that one to other modules — but the payload decided from and the patch
 * written beside it, which is what a caller needs to say what happened.
 */
export function updateWith<P extends PinPatch>(
  doc: any,
  fn: PatchOf<P>,
  fields: Record<string, unknown> | ((current: DpPinFlags) => Record<string, unknown>) = {}
): Promise<UpdateOutcome<P>> {
  return enqueue(queueKey(doc), async () => {
    const before = readPin(doc);
    if (!before) return { before: null, patch: null, result: null };
    const patch = fn(before);
    if (!patch) return { before, patch: null, result: null };
    const implied = typeof fields === "function" ? fields(before) : fields;
    return { before, patch, result: await writePatch(doc, before, patch, implied) };
  });
}

/**
 * Point the tile at another texture: a document pin's icon.
 *
 * Through the queue, and compared inside it, like every other write: an icon chosen while
 * a retarget was still landing compared itself with the texture the retarget was about to
 * replace. An image pin is refused here rather than by its caller, for the same reason —
 * its texture IS its source (`anchorTexture` in `api.ts`), and only a change of source
 * may move it. Resolves whether anything was written.
 */
export function setTexture(doc: any, src: string): Promise<boolean> {
  return enqueue(queueKey(doc), async () => {
    const pin = readPin(doc);
    if (!pin || pin.source.kind !== "document" || doc.texture?.src === src) return false;
    await doc.update({ "texture.src": src }, internal());
    return true;
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
 *
 * The point is deliberately left alone, unlike `resize`: a document's point is the tile's
 * centre, so a switch keeps the centre — the marker's spot becomes the paper's middle and
 * back. A mode switch is a swap of object, not a growth of one.
 */
export function convertMode(
  doc: any,
  mode: DpMode,
  fallback?: { width: number; height: number }
): Promise<any> {
  return enqueue(queueKey(doc), async () => {
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
        ...payloadWrite(rawPinFlag(doc), pin),
      },
      internal()
    );
  });
}

/**
 * Resize the anchor, keeping its top-left corner where it was.
 *
 * The box, and the point that keeps the box's corner put. A document's point is the
 * tile's centre, so a bare width and height would grow a sheet about its middle and slide
 * its first line up over whatever it lay against; `centreAfterResize` moves the point so
 * the sheet grows down and to the right in its own frame — the way core's handle grows a
 * tile, and the way a page fills. Every caller — fit, reset, the Studio's fields — gets
 * the same gesture.
 *
 * `geometry` is deliberately not written here: it is read only when RETURNING to a
 * mode, and `convertMode` captures the live size on the way out, so a copy written now
 * could only ever disagree with the tile.
 */
export function resize(doc: any, size: { width: number; height: number }): Promise<any> {
  return enqueue(queueKey(doc), async () => {
    if (!readPin(doc)) return null;
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const centre = centreAfterResize(doc, { width, height });
    return doc.update(
      { x: Math.round(centre.x), y: Math.round(centre.y), width, height },
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
 *
 * A patch may be a function of the payload, as for `updateWith`, and that is the form a
 * bulk reveal needs: what it writes depends on the audience each pin holds, and an
 * audience built before the queue was reached could undo a chip click still in flight
 * (DESIGN A25's follow-up, A29). A function's `null` leaves its pin out of the write.
 */
export function batchUpdate(
  scene: any,
  entries: { doc: any; patch: PinPatch | PatchOf }[]
): Promise<any[]> {
  // Through the queue, like every other writer. The payloads are read INSIDE it, so a
  // bulk reveal landing on top of an in-flight chip toggle sees that toggle's result
  // rather than the payload as it was before.
  return enqueueAll(
    entries.map(({ doc }) => queueKey(doc)),
    async () => {
      const updates = entries
        .map(({ doc, patch: given }) => {
          const current = readPin(doc);
          if (!current) return null;
          const patch = typeof given === "function" ? given(current) : given;
          if (!patch) return null;
          const { pin } = mergePin(current, patch);
          return { _id: doc.id, ...hiddenFor(patch, pin), ...payloadWrite(rawPinFlag(doc), pin) };
        })
        .filter(Boolean);

      if (!updates.length) return [];
      return scene.updateEmbeddedDocuments("Tile", updates, internal());
    }
  );
}

/**
 * Delete many anchors in one scene write, after every write already queued on them.
 *
 * The bulk delete read nothing from the queue and joined none of it, so a chip click still
 * in flight landed on a tile that was being deleted, and a sync it then started granted on
 * behalf of a pin that no longer existed. `first` runs inside the same turn, before the
 * delete — the place for the grants' release. It must not wait on a write queued on one of
 * these anchors (`update`, `updateWith`, ...): it would wait for itself (DESIGN A22).
 */
export function removeMany(
  scene: any,
  docs: readonly any[],
  first: () => Promise<unknown> = async () => {}
): Promise<any> {
  return enqueueAll(docs.map(queueKey), async () => {
    await first();
    return scene?.deleteEmbeddedDocuments(
      "Tile",
      docs.map((doc: any) => doc.id),
      internal()
    );
  });
}

/**
 * Write a payload onto a tile that does not have one yet.
 *
 * `update` deliberately refuses a tile that is not already a pin, so adopting an
 * existing tile — including one made by another module — needs its own verb rather
 * than a special case inside the patch path.
 */
export function attach(doc: any, pin: DpPinFlags): Promise<any> {
  return enqueue(queueKey(doc), async () => {
    const validated = validatePin(pin).pin;
    return doc.update(
      {
        hidden: anchorHidden(validated.audience),
        ...payloadWrite(rawPinFlag(doc), validated),
      },
      internal()
    );
  });
}

/** Remove the pin payload but keep the tile, turning an anchor back into a plain tile. */
export function unpin(doc: any): Promise<any> {
  return enqueue(queueKey(doc), () =>
    doc.update(deletionUpdate(`flags.${MODULE_ID}`, FLAGS.PIN), internal())
  );
}

/**
 * Delete the anchor entirely. The source document is never touched.
 *
 * `first` runs inside the same turn, before the delete — the place for the grants' release,
 * as in `removeMany`: released before the turn, a chip click still landing on the pin was
 * written after the release, and the sync it started granted for a pin about to go. It must
 * not wait on a write queued on this anchor: it would wait for itself (DESIGN A22).
 */
export function remove(doc: any, first: () => Promise<unknown> = async () => {}): Promise<any> {
  return enqueue(queueKey(doc), async () => {
    await first();
    return doc.delete(internal());
  });
}
