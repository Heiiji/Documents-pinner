/**
 * What an edit to a pin's source does: the `update<Document>` hooks, for every type of
 * document an adapter answers for.
 *
 * IMPURE through the effects it is handed, and through nothing else: the ledger, the
 * labels, the textures and the Pinboard belong to modules a test may mock with a partial
 * factory, and `sources/` imports none of them. `main.ts` wires the four in.
 *
 * Filtered before any work (P5). An actor's update hook fires on every hit-point change in
 * combat, and each one that reached the textures would re-enrich and re-rasterise a
 * wanted poster on the map. So an edit to an owned item or a token's actor is nothing to
 * a pin; the ledger is rebased only when ownership changed and a label followed only when
 * the name did, as their own guards already said; and the card is redrawn only when the
 * adapter says the change reaches it — for a journal, any change, as it always was.
 */

import { isOurs } from "../fvtt";
import { adapterForDoc } from "./index";

/** What an edit can set in motion, each a door into a module `sources/` does not import. */
export interface SourceUpdateEffects {
  /** Fold a GM's manual permission edit into the ownership ledger. */
  rebase(doc: any, change: any, options: any, userId: string): unknown;
  /** Redraw the label of every pin that follows this document's name. */
  rename(doc: any, change: any, options: any): void;
  /** Drop this document's cards, so the next frame draws them again. */
  invalidate(uuid: string): void;
  /** Bring the Pinboard's rows in line. */
  refresh(): void;
}

/** The `update<Document>` handler for every source type, given its effects. */
export function sourceUpdateHandler(effects: SourceUpdateEffects) {
  return (doc: any, change: any, options: any, userId: string): void => {
    if (isOurs(options)) return;
    const adapter = adapterForDoc(doc);
    if (!adapter.isSource(doc)) return;

    if (change?.ownership !== undefined) void effects.rebase(doc, change, options, userId);
    if (change?.name !== undefined) effects.rename(doc, change, options);
    if (!adapter.redrawsOn(doc, change)) return;
    effects.invalidate(doc.uuid);
    effects.refresh();
  };
}
