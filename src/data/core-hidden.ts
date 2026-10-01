/**
 * Core's own `hidden`, folded into the audience.
 *
 * IMPURE. A pin's anchor is an ordinary Tile (DESIGN §2), so core still offers three ways
 * to hide or show one without this module: the Tiles layer's HUD, TileConfig's *Hidden* box
 * and the v14 Placeables sidebar. Each wrote `hidden` alone and left the audience saying
 * "everyone". Every surface that reads the audience then lied — the eye offered "Reveal" on
 * a pin it would hide, the chips showed every player hollow — and the next module write,
 * which derives `hidden` from the audience, put the pin back on every player's screen. A
 * click on one player's chip revealed it to all of them.
 *
 * So the change is completed where it is made, in the SAME update: hiding records the
 * audience it hides, as the eye does (`toggleVisibility`), and showing again restores it
 * (`revealed`). Nothing here reveals more than core's own un-hide already did — that showed
 * the tile to everyone — and the restored audience is never wider than that. The grant then
 * follows, from the client that made the change, as it does for the eye.
 */

import { FLAGS, MODULE_ID } from "../const";
import { g, isOurs } from "../fvtt";
import { logger } from "../log";
import { revealed, toggleVisibility } from "./audience";
import { readPin } from "./PinData";
import { syncAnchor } from "./ownership-sync";
import type { DpAudience } from "../types/dp";

const log = logger("hidden");

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value) && value.constructor === Object;

/** The audience a core change of `hidden` implies for this pin, or null for none. */
function folded(audience: DpAudience, hidden: boolean): DpAudience | null {
  if (hidden) return audience.kind === "hidden" ? null : toggleVisibility(audience);
  return audience.kind === "hidden" ? revealed(audience) : null;
}

/**
 * `preUpdateTile`, on the client making the change: fold a `hidden` the module did not
 * write into the same update's audience.
 *
 * `changed` is the cleaned, expanded change core is about to validate and send, and a
 * pre-hook may add to it: core cleans it again after the hook (foundry.mjs 14.368,
 * 81142-81161). Only a real change of `hidden` counts: TileConfig submits the field with
 * every save, unchanged. A change that already says who sees the pin is left as its writer
 * made it.
 */
export function onPreUpdateTile(doc: any, changed: any, options: any): void {
  if (isOurs(options) || !changed || typeof changed.hidden !== "boolean") return;
  if (changed.hidden === (doc?.hidden === true)) return;
  const pin = readPin(doc);
  if (!pin) return;

  if (changed.flags !== undefined && !isRecord(changed.flags)) return;
  const ours = changed.flags?.[MODULE_ID];
  if (ours !== undefined && !isRecord(ours)) return;
  const payload = ours?.[FLAGS.PIN];
  if (payload !== undefined && (!isRecord(payload) || payload.audience !== undefined)) return;

  const audience = folded(pin.audience, changed.hidden);
  if (!audience) return;
  changed.flags ??= {};
  changed.flags[MODULE_ID] ??= {};
  changed.flags[MODULE_ID][FLAGS.PIN] ??= {};
  changed.flags[MODULE_ID][FLAGS.PIN].audience = audience;
}

/**
 * `preCreateTile`: a pin core creates hidden — a paste, an undo — is hidden in its audience
 * too. Only ever towards hidden: a creation never shows anything its payload did not. Core
 * sends the pending document, not the data the hook is handed (foundry.mjs 14.368, 81016 and
 * 81034), so the fold is written to the document.
 */
export function onPreCreateTile(doc: any, _data: any, options: any): void {
  if (isOurs(options) || doc?.hidden !== true) return;
  const pin = readPin(doc);
  const audience = pin ? folded(pin.audience, true) : null;
  if (!audience) return;
  doc.updateSource?.({ [`flags.${MODULE_ID}.${FLAGS.PIN}.audience`]: audience });
}

/**
 * `updateTile`: once core's change has landed, the grant follows the audience it implied —
 * released on a hide, granted again on a show — from the client that made it, the one
 * client the pre-hook ran on.
 */
export function syncAfterCoreHidden(doc: any, changed: any, options: any, userId: string): void {
  if (isOurs(options) || !changed || !("hidden" in changed)) return;
  if (userId !== g()?.user?.id || !readPin(doc)) return;
  void syncAnchor(doc).catch((error) => log.warn(`could not sync ${doc?.uuid}`, error));
}
