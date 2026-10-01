/**
 * Reading the pin payload off a document.
 *
 * IMPURE only in that it reads a document; the rules are not here. They live in
 * `pin-schema.ts`, which is pure and unit-tested, and every read goes through its
 * `validatePin` — so a pin reads the same whichever code path reads it, and a damaged
 * flag still reads as something that draws.
 *
 * Until 0.4.1 this file also built a `foundry.abstract.DataModel` for the payload, at
 * `init`, and its header said `migrateData` ran before anything read the flag and that the
 * class was one other modules could reference. Neither was true: the class was never
 * registered, never instantiated and never exported anywhere a module could reach, and no
 * read ever went through it. It was removed rather than wired up (DESIGN A29): a flag is not
 * a field Foundry validates, and the reads below already normalise on every call.
 */

import { FLAGS, MODULE_ID } from "../const";
import type { DpPinFlags } from "../types/dp";
import { validatePin, type PinValidationResult } from "./pin-schema";

/** The raw flag as stored, without normalisation. */
export function rawPinFlag(doc: any): unknown {
  return doc?.flags?.[MODULE_ID]?.[FLAGS.PIN] ?? doc?.getFlag?.(MODULE_ID, FLAGS.PIN) ?? null;
}

export function isPinned(doc: any): boolean {
  return rawPinFlag(doc) !== null && rawPinFlag(doc) !== undefined;
}

/**
 * Whether a tile's create, update or delete is any of this module's business.
 *
 * A pin, or a change to this module's flags — which is how a tile STOPS being a pin:
 * after an unpin the document carries no flag, and only the diff says it used to. Any
 * other tile is another module's or the GM's own, and every change to one used to cost
 * a full LOD pass, a hit-layer rebuild and a re-render of every open window here.
 * `changed` is the diff for an update, and core's options object — which never carries
 * `flags` — for a create or a delete.
 */
export function concernsPins(doc: any, changed?: any): boolean {
  if (isPinned(doc)) return true;
  const flags = changed?.flags;
  if (!flags || typeof flags !== "object") return false;
  return MODULE_ID in flags || `-=${MODULE_ID}` in flags;
}

/**
 * Read a document's pin payload, normalised.
 *
 * Returns `null` only when the document carries no pin flag at all — a document that
 * IS a pin always yields something renderable, however damaged its flag.
 */
export function readPin(doc: any): DpPinFlags | null {
  const raw = rawPinFlag(doc);
  if (raw === null || raw === undefined) return null;
  return validatePin(raw).pin;
}

/**
 * As `readPin`, but keeping the normaliser's notices. No surface reports them to a GM yet;
 * the tests read them to prove a payload reads clean.
 */
export function readPinResult(doc: any): PinValidationResult | null {
  const raw = rawPinFlag(doc);
  if (raw === null || raw === undefined) return null;
  return validatePin(raw);
}
