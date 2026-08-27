/**
 * The pin payload as Foundry sees it.
 *
 * IMPURE. The validation rules are NOT here — they live in `pin-schema.ts`, which is
 * pure and unit-tested, and this file delegates to them. A `DataModel` that restated
 * the clamps would drift from the tested copy the first time either changed, and the
 * drift would surface as a pin that renders differently depending on which code path
 * read it.
 *
 * What the DataModel adds over the bare validator is the part Foundry cares about: a
 * declared shape for the flag, a `migrateData` hook that runs before anything reads
 * it, and a stable class other modules can reference. The schema below is therefore
 * about STRUCTURE; `validatePin` remains the authority on VALUES.
 *
 * The class is built inside a factory rather than declared at module scope because
 * extending `foundry.abstract.DataModel` evaluates a global, and this module has to be
 * importable under Node for the rest of the data layer to be testable.
 */

import { FLAGS, MODULE_ID } from "../const";
import { ns } from "../fvtt";
import type { DpPinFlags } from "../types/dp";
import { defaultPin, validatePin, type PinValidationResult } from "./pin-schema";

/** Set once at `init`. Null under Node, and on any build missing the namespace. */
let PinDataClass: any = null;

/**
 * Build and register the DataModel subclass. Call once, at `init`.
 *
 * Returns the class, or `null` if this build has no `foundry.abstract.DataModel` — in
 * which case every read still works, because reads go through `validatePin` either
 * way. The model is a convenience, never a dependency.
 */
export function definePinData(): any {
  if (PinDataClass) return PinDataClass;

  const DataModel = ns("abstract.DataModel");
  const fields = ns("data.fields");
  if (!DataModel || !fields) return null;

  PinDataClass = class PinData extends DataModel {
    static defineSchema() {
      const d = defaultPin();
      return {
        v: new fields.NumberField({ required: true, integer: true, initial: d.v }),
        mode: new fields.StringField({ required: true, choices: ["pin", "prop"], initial: d.mode }),
        // The groups are declared as opaque objects on purpose: their contents are
        // validated by `validatePin` in `migrateData` below, before Foundry ever
        // looks at them, so a second set of field-level rules here would be dead
        // weight that could only disagree with the first.
        source: new fields.ObjectField({ initial: () => defaultPin().source }),
        display: new fields.ObjectField({ initial: () => defaultPin().display }),
        geometry: new fields.ObjectField({ initial: () => defaultPin().geometry }),
        effect: new fields.ObjectField({ initial: () => defaultPin().effect }),
        audience: new fields.ObjectField({ initial: () => defaultPin().audience }),
        interaction: new fields.ObjectField({ initial: () => defaultPin().interaction }),
      };
    }

    /** The single entry point for the rules. Runs before validation, on every read. */
    static migrateData(source: any) {
      return super.migrateData(validatePin(source).pin);
    }
  };

  return PinDataClass;
}

/** The raw flag as stored, without normalisation. */
export function rawPinFlag(doc: any): unknown {
  return doc?.flags?.[MODULE_ID]?.[FLAGS.PIN] ?? doc?.getFlag?.(MODULE_ID, FLAGS.PIN) ?? null;
}

export function isPinned(doc: any): boolean {
  return rawPinFlag(doc) !== null && rawPinFlag(doc) !== undefined;
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

/** As `readPin`, but keeping the notices, for the surfaces that report them to a GM. */
export function readPinResult(doc: any): PinValidationResult | null {
  const raw = rawPinFlag(doc);
  if (raw === null || raw === undefined) return null;
  return validatePin(raw);
}
