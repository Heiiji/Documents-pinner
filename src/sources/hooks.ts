/**
 * What an edit to a pin's source does: the `update<Document>` hooks, for every type of
 * document an adapter answers for.
 *
 * IMPURE through the effects it is handed, and through nothing else: the ledger, the
 * labels, the card cache, the textures and the Pinboard belong to modules a test may mock
 * with a partial factory, and `sources/` imports none of them. `main.ts` wires them in.
 *
 * Filtered before any work (DESIGN A28, P5). An actor's update hook fires on every
 * hit-point change in combat, and each one that reached the textures would re-enrich and
 * re-rasterise a wanted poster on the map. So an edit to an owned item or a token's actor
 * is nothing to a pin; the ledger is rebased only when ownership changed and a label
 * followed only when the name did, as their own guards already said; and the card is
 * redrawn only when the adapter says the change reaches it — for a journal, any change —
 * and a pin on the scene being viewed shows the document. Every journal edit anywhere used
 * to cost every client an LOD pass, and the GM a Pinboard render, and a stream of them kept
 * postponing the pass a reveal had asked for.
 *
 * One effect runs BEFORE those filters: `forget`, which drops what the card cache kept of
 * the document (DESIGN A29). It costs a walk of a few hundred keys, and the filters answer
 * a different question — whether a card on the viewed scene must be redrawn NOW. A body
 * kept for a pin on another scene, or an actor whose hit points an inline roll reads, is
 * stale after the edit whether or not anything redraws; skipping the forget would serve
 * the old words the next time the card resolved for any reason.
 */

import { cv, isOurs } from "../fvtt";
import { rawPinFlag } from "../data/PinData";
import { adapterForDoc } from "./index";

/**
 * Whether a pin on the scene being viewed draws from this document: it names it, it names
 * its journal while this is a page, or it names one of its pages. The Pinboard lists that
 * scene's pins, and the props are that scene's: no other pin can need a redraw.
 */
function shownOnViewedScene(uuid: unknown): boolean {
  if (typeof uuid !== "string" || !uuid) return false;
  for (const tile of cv()?.scene?.tiles?.contents ?? []) {
    const source = (rawPinFlag(tile) as any)?.source?.uuid;
    if (typeof source !== "string" || !source) continue;
    if (source === uuid || source.startsWith(`${uuid}.`) || uuid.startsWith(`${source}.`)) {
      return true;
    }
  }
  return false;
}

/** What an edit can set in motion, each a door into a module `sources/` does not import. */
export interface SourceUpdateEffects {
  /**
   * Forget what was kept of this document's cards. Synchronous, and before `invalidate`:
   * the redraw that follows must not be served the body from before the edit.
   */
  forget(uuid: string): void;
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
    if (typeof doc?.uuid === "string") effects.forget(doc.uuid);

    if (change?.ownership !== undefined) void effects.rebase(doc, change, options, userId);
    if (change?.name !== undefined) effects.rename(doc, change, options);
    if (!adapter.redrawsOn(doc, change) || !shownOnViewedScene(doc.uuid)) return;
    effects.invalidate(doc.uuid);
    effects.refresh();
  };
}

/** What a source coming or going sets in motion. */
export interface SourceLifecycleEffects {
  /** Forget what was kept of this document's cards, as an edit does. */
  forget(uuid: string): void;
  /** Drop this document's cards, so the next frame draws them again. */
  invalidate(uuid: string): void;
  /** Bring the Pinboard's rows in line. */
  refresh(): void;
  /** Close a reader whose source is gone. */
  revalidate(): void;
}

/**
 * The `create<Document>` and `delete<Document>` handler for every source type.
 *
 * Only the update hooks were wired. A journal, a page or a wanted man's actor deleted reached
 * no handler, so every client went on drawing — and a player could go on reading — what the
 * GM had deleted until the canvas was next drawn, while a click on it said "missing". A page
 * created in, or deleted from, a journal a pin shows whole never redrew it either: an embedded
 * page fires its own hooks, not its journal's update. The same filter as an edit: a pin on
 * the viewed scene that shows the document.
 */
export function sourceLifecycleHandler(effects: SourceLifecycleEffects) {
  return (doc: any, options: any): void => {
    if (isOurs(options) || !adapterForDoc(doc).isSource(doc)) return;
    if (typeof doc?.uuid === "string") effects.forget(doc.uuid);
    if (!shownOnViewedScene(doc?.uuid)) return;
    effects.invalidate(doc.uuid);
    effects.refresh();
    effects.revalidate();
  };
}
