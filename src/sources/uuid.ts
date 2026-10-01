/**
 * What a uuid names, read from the uuid alone.
 *
 * PURE. No global is touched, so this is the one place that can say "this pin is on a
 * compendium document" without asking Foundry — and Foundry's own answer is the problem
 * this file exists for: `fromUuidSync` hands back an index entry, a cached Document or a
 * throw for the same compendium uuid depending on what loaded it and when (see
 * `resolveUuidSync` in `fvtt.ts`). The uuid does not change; its shape is read here.
 *
 * Not `foundry.utils.parseUuid`: it needs a running core, and this runs on the drag
 * preview's refresh path, where a string split is all the work there should be.
 */

/** A uuid, taken apart. */
export interface ParsedUuid {
  /** `${package}.${pack}` for a compendium document; null for a world one. */
  packId: string | null;
  /** The type of the top-level document, or null for a legacy compendium uuid. */
  rootType: string | null;
  /** The top-level document's id. */
  rootId: string;
  /** The type of the document the uuid NAMES — the last pair's — or null when unstated. */
  documentName: string | null;
  /** The id of the document the uuid names. */
  id: string;
  /** Every `[type, id]` pair after the top-level document, in order. */
  embedded: [string, string][];
}

/** Whether a uuid names a document inside a compendium pack. */
export function isPackUuid(uuid: unknown): uuid is string {
  return typeof uuid === "string" && uuid.startsWith("Compendium.");
}

/**
 * `Compendium.<package>.<pack>.<Type>.<id>[.<Type>.<id>]…` or `<Type>.<id>[.<Type>.<id>]…`.
 *
 * The four-segment `Compendium.<package>.<pack>.<id>` of older worlds names no type, so
 * its `rootType` and `documentName` are null and the pack's own type stands in for them.
 * Anything else that does not split into pairs is not a uuid this module can read: null.
 */
export function parseSourceUuid(uuid: unknown): ParsedUuid | null {
  if (typeof uuid !== "string" || !uuid) return null;
  let parts = uuid.split(".");
  let packId: string | null = null;

  if (parts[0] === "Compendium") {
    if (parts.length < 4 || !parts[1] || !parts[2]) return null;
    packId = `${parts[1]}.${parts[2]}`;
    parts = parts.slice(3);
    if (parts.length === 1) {
      const id = parts[0];
      return id
        ? { packId, rootType: null, rootId: id, documentName: null, id, embedded: [] }
        : null;
    }
  }

  if (parts.length < 2 || parts.length % 2 !== 0) return null;
  const pairs: [string, string][] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i] || !parts[i + 1]) return null;
    pairs.push([parts[i], parts[i + 1]]);
  }

  const [rootType, rootId] = pairs[0];
  const [documentName, id] = pairs[pairs.length - 1];
  return { packId, rootType, rootId, documentName, id, embedded: pairs.slice(1) };
}
