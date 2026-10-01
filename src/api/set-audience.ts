/**
 * The write every change of who sees a pin goes through: its audience, then its ownership.
 *
 * IMPURE: the pin's write queue and the ownership ledger. Cut out of `api.ts` with Reveal
 * next (A29), which reveals through it as every verb does; under `api/`, it imports nothing
 * of `api.ts`, so the verbs' façade can re-export what is cut out of it without an import
 * cycle. `api` re-exports `setAudience`, and builds the eye, the chips, "some players" and
 * the bulk bar on the rest.
 */

import { isGM, notify } from "../fvtt";
import * as store from "../data/PinStore";
import { syncAnchor } from "../data/ownership-sync";
import { readsInPlace } from "../data/access";
import type { DpAudience, DpPinFlags } from "../types/dp";

/**
 * A change of audience decided from the audience the pin holds when its write's turn
 * comes; `null` leaves the pin as it is.
 */
export type AudienceChange = (current: DpAudience) => DpAudience | null;

/**
 * Apply an audience change to an anchor.
 *
 * `next` is the audience to write, or — the form every verb that derives one from the
 * current audience passes — a function of the audience the pin holds when the write's
 * turn in the queue comes. Built before the queue, a derived audience was decided from a
 * payload a write still in flight was about to replace: two chip clicks in one tick each
 * read the same audience, and the second undid the first (DESIGN A29).
 *
 * The payload is written first and the ownership sync follows, so a client that has
 * just seen the pin appear can already open the document behind it. The reverse order
 * would produce a window — small, but exactly the window a player clicks in.
 */
export async function setAudience(
  anchorDoc: any,
  next: DpAudience | AudienceChange
): Promise<void> {
  await changeAudience(anchorDoc, next);
}

/**
 * `setAudience`, resolving whether anything was written. The notice is decided from the
 * payload the write was decided from, read inside the queue like the change itself.
 */
export async function changeAudience(
  anchorDoc: any,
  next: DpAudience | AudienceChange
): Promise<boolean> {
  if (!isGM()) return false;
  const { before, patch } = await store.updateWith(anchorDoc, (pin) => {
    const audience = typeof next === "function" ? next(pin.audience) : next;
    return audience ? { audience } : null;
  });
  if (!patch) return false;
  await syncAnchor(anchorDoc);
  if (revealsUnopenable(before, patch.audience)) {
    notify({ key: "DP.notice.revealedNoAccess" }, "info");
  }
  return true;
}

/**
 * Whether this audience change shows the players a pin whose sheet will refuse them: an
 * icon pin that opens its document's sheet, revealed with access off.
 *
 * A prop reads in place whatever the ownership says, and so does an icon pin set to *Read
 * in place*; a *Not interactive* pin opens nothing. Only a pin that opens the sheet — which
 * refuses without access — ships "I can see it but it won't open" to the table, so only
 * its reveal is the moment to say so.
 */
export function revealsUnopenable(before: DpPinFlags | null, next: DpAudience): boolean {
  return (
    before?.mode === "pin" &&
    !readsInPlace(before) &&
    before.interaction.open !== "never" &&
    before.audience.kind === "hidden" &&
    next.kind !== "hidden" &&
    !next.ownershipSync.enabled
  );
}
