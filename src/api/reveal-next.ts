/**
 * The scene's script: a pin as the Pinboard's list logic reads it, and Reveal next, which
 * plays that list one pin at a time.
 *
 * IMPURE: the scene's pins, the write queue, the ledger, core's canvas. Cut out of `api.ts`
 * (A29) and re-exported by it, so the board, the keybinding and the public API reach both
 * where they always did. It lives under `api/` rather than `apps/`: Reveal next is a verb
 * — on the public API, run with the board closed — and `rowFacts` is the one derivation it
 * and the board share, so neither belongs to a window. Nothing under `api/` imports
 * `api.ts`: the reveal goes through `api/set-audience` and the ping through `api/ping`,
 * which the façade uses too, so re-exporting this file makes no import cycle.
 */

import { MODULE_ID } from "../const";
import { isGM, notify, playerIds } from "../fvtt";
import * as audience from "../data/audience";
import * as store from "../data/PinStore";
import { readPin } from "../data/PinData";
import { canUserOpen, canUserSee, isRevealed } from "../data/access";
import { nextToReveal, type PinboardQuery, type RowFacts } from "../apps/pinboard-model";
import { describeSource } from "../sources/describe";
import { labelFor } from "../sources/view";
import { pingAt } from "./ping";
import { setAudience } from "./set-audience";

declare const Hooks: any;

/** What each player can do with a pin: the two facts the Pinboard's filters read. */
function factsUsers(anchorDoc: any): RowFacts["users"] {
  return playerIds().map((id) => ({
    canSee: canUserSee(anchorDoc, id),
    canOpen: canUserOpen(anchorDoc, id),
  }));
}

/**
 * A pin as the Pinboard's list logic reads it, or null for a tile that is not one.
 *
 * The one derivation of these facts. The Pinboard builds its rows on top of it, passing
 * the chips it has already built as `users`; `revealNext` builds them with the board
 * closed. Two copies would be two answers to "which pin is next".
 */
export function rowFacts(
  anchorDoc: any,
  users: RowFacts["users"] = factsUsers(anchorDoc)
): RowFacts | null {
  const pin = readPin(anchorDoc);
  if (!pin) return null;
  return {
    id: anchorDoc.id,
    name: labelFor(pin),
    breadcrumb: describeSource(pin.source).breadcrumb,
    mode: pin.mode,
    // Whether anyone is reached, not whether the kind says "hidden": a selection that
    // names nobody was counted as visible while every chip on its row was hollow.
    visible: isRevealed(anchorDoc, pin),
    hidden: anchorDoc.hidden === true || pin.audience.kind === "hidden",
    elevation: anchorDoc.elevation ?? 0,
    users,
  };
}

const EVERY_ROW: PinboardQuery = { filter: "all", search: "", level: null };

/** The Reveal next in flight, and the scene it is revealing on. */
let revealing: { scene: any; promise: Promise<{ doc: any; left: number }> } | null = null;

/**
 * Reveal the next pin of the scene's script: the first hidden row in the Pinboard's
 * order, under the view the GM is looking at, to the audience it remembers.
 *
 * The Pinboard's order has always been called the reveal order, and nothing consumed it.
 * This is the play button. It reveals through `audience.revealed`, never the eye's
 * toggle: a toggle on a row that is not hidden would hide it, and pressing N twice would
 * take back the clue it had just given.
 *
 * Then it points at the pin, after the reveal has landed, so the table finds it there:
 * the GM's own card pulses, and the ping reaches every client only when the pin is for
 * everyone. A pin for one player is pointed at on the GM's screen alone — a pulse on the
 * others' maps would show them where the rogue's clue lies. It never pulls a view; that
 * is spotlight's decision to make, not a side effect of stepping through a script.
 *
 * Nothing to reveal is said, and said apart from "nothing in this view": the second one
 * means the filter is hiding the rest of the script, which is the GM's to know.
 *
 * One at a time per scene. Two presses faster than a write read the same payloads and
 * chose the same row: the second revealed nothing new, and pinged and said so again. A
 * press while one is in flight now shares its answer.
 */
export function revealNext(
  scene: any,
  query: PinboardQuery = EVERY_ROW
): Promise<{ doc: any; left: number }> {
  if (revealing && revealing.scene === scene) return revealing.promise;
  const promise = revealNextNow(scene, query).finally(() => {
    if (revealing?.promise === promise) revealing = null;
  });
  revealing = { scene, promise };
  return promise;
}

async function revealNextNow(
  scene: any,
  query: PinboardQuery
): Promise<{ doc: any; left: number }> {
  const nothing = { doc: null, left: 0 };
  if (!isGM() || !scene) return nothing;

  const docs = store.all(scene);
  const facts = docs.map((doc) => rowFacts(doc)).filter((row): row is RowFacts => row !== null);
  const { next, left } = nextToReveal(facts, query);
  const doc = next ? docs.find((candidate) => candidate.id === next.id) : null;
  const pin = readPin(doc);
  if (!doc || !pin) {
    const outOfView = facts.some((row) => row.hidden);
    notify(
      { key: outOfView ? "DP.notice.revealNextNoneInView" : "DP.notice.revealNextNone" },
      "info"
    );
    return nothing;
  }

  // The row was chosen from the payloads read here; what it reveals to is decided from the
  // audience the pin holds when the write lands, as every reveal is (A29).
  await setAudience(doc, audience.revealed);
  // A write core refused still resolves; the pin must be out of hiding before anything
  // points at it.
  const after = readPin(doc);
  if (!after || doc.hidden === true || after.audience.kind === "hidden") {
    notify({ key: "DP.notice.revealNextFailed" }, "error");
    return nothing;
  }

  Hooks.callAll(`${MODULE_ID}.flash`, doc);
  pingAt(doc, { broadcast: audience.pingsEveryone(after.audience), pull: false });
  return { doc, left };
}
