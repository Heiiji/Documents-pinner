/**
 * Tile changes, coalesced: the `createTile`, `updateTile` and `deleteTile` hooks.
 *
 * IMPURE through the effects it is handed, and through nothing else — the surfaces it
 * refreshes belong to the modules `main.ts` wires in, as `sources/hooks.ts` does for a
 * source's edits.
 *
 * Foundry fires `updateTile` once per document, so a correctly-batched fifty-pin "Reveal
 * all" arrives as fifty hook calls — and each one did O(all placeables) work: a full
 * `PropManager.refresh`, a full hit-layer rebuild (a `PIXI.Container` and a `Polygon`
 * allocated and destroyed per prop), a full Pinboard render and up to N `testVisibility`
 * calls. Fifty of those in one tick is ~2500 allocations and fifty renders for one
 * gesture.
 *
 * The ids are gathered and the refresh runs ONCE from a microtask, so a batch of any size
 * costs one pass. Everything the refresh does was already idempotent; only the arithmetic
 * changes.
 */

import { concernsPins } from "../data/PinData";

/**
 * The hook handler. `refresh` runs once per batch, with the changed pins' ids — each once,
 * though twin scenes share one — and their uuids.
 */
export function tileChangeHandler(
  refresh: (ids: string[], uuids: string[]) => void
): (doc: any, changed?: any) => void {
  const changedTiles = new Map<string, string>();
  let queued = false;

  return (doc, changed) => {
    if (!concernsPins(doc, changed)) return;
    if (doc?.id) changedTiles.set(doc.uuid ?? doc.id, doc.id);
    if (queued) return;
    queued = true;

    void Promise.resolve().then(() => {
      queued = false;
      const uuids = [...changedTiles.keys()];
      const ids = [...new Set(changedTiles.values())];
      changedTiles.clear();
      refresh(ids, uuids);
    });
  };
}
