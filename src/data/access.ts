/**
 * What a user may do with a pin: see it, open what it shows — and whether anyone sees it.
 *
 * IMPURE in what it reads (the pin's payload, the users, the source's ownership and its
 * pack), never in what it does: these are questions, and nothing here writes. They lived in
 * `api.ts` among the verbs, and were cut out of it (A29). The canvas tier asks one of every
 * prop on every LOD pass, and the HUD, the Pinboard and the Studio ask them of every chip;
 * none of them needs a verb to ask, and a question kept beside the writes is one the canvas
 * imports the whole verbs' layer to reach. `api` re-exports all three, so its callers and
 * the public API read them where they always did.
 *
 * The rules themselves are pure and live in `audience.ts` (who is in an audience) and the
 * source adapters (what opens a document); this file only resolves the pin and the user
 * and asks them.
 */

import { g, playerIds } from "../fvtt";
import * as audience from "./audience";
import { readPin } from "./PinData";
import { describeSource } from "../sources/describe";
import { canOpenShown } from "../sources/index";
import { packOf, packReadableBy } from "../sources/packs";
import { isPackUuid } from "../sources/uuid";
import type { DpPinFlags } from "../types/dp";

/**
 * Whether this pin is revealed to anyone — the one answer the eye, the Pinboard's
 * "Visible" filter and its totals all give. See `audience.reachesAnyone` for why this is
 * not `kind !== "hidden"`.
 */
export function isRevealed(anchorDoc: any, pin: DpPinFlags | null = readPin(anchorDoc)): boolean {
  if (!pin || anchorDoc?.hidden === true) return false;
  return audience.reachesAnyone(pin.audience, playerIds());
}

/** Whether a user can see this pin right now, by the same rule the canvas uses. */
export function canUserSee(anchorDoc: any, userId: string): boolean {
  const pin = readPin(anchorDoc);
  if (!pin) return false;
  const user = g()?.users?.get(userId);
  return audience.canSee(pin.audience, {
    isGM: user?.isGM === true,
    userId,
    hidden: anchorDoc?.hidden === true,
  });
}

/**
 * Whether a user could actually OPEN the document behind the pin.
 *
 * Compared against `canUserSee`, this is what raises the key badge in the HUD and the
 * Pinboard. The mismatch it detects — visible but unopenable — is the bug a GM ships to
 * their table and only hears about when a player says "I can see it but nothing
 * happens".
 *
 * A pin that reads in place opens in the module's own reader for anyone who can see it,
 * whatever the ownership says — `openReader` is not gated on it, deliberately. Asking
 * only for OBSERVER put a key on every chip of a prop revealed with access sync off, and
 * listed it under "Won't open", for players reading it perfectly well; the GM's natural
 * fix, switching sync on, then granted a journal nobody needed. The inverse — a player
 * who holds the journal while the pin is hidden from them — still shows, because that
 * one is true.
 */
export function canUserOpen(anchorDoc: any, userId: string): boolean {
  const pin = readPin(anchorDoc);
  if (!pin) return false;
  if (pin.source.kind === "image") return canUserSee(anchorDoc, userId);
  if (pin.interaction.open === "never") return false;

  const user = g()?.users?.get(userId);
  if (!user) return false;
  // A compendium document opens for a player whose ROLE reads the pack, as a pin or as a
  // prop. One whose role does not is never sent it: their card is a placeholder even
  // where a world journal would read in place, so the key is true there, and must show.
  if (isPackUuid(pin.source.uuid)) return packReadableBy(packOf(pin.source.uuid), user);

  const source = describeSource(pin.source).shown;
  if (!source) return false;
  // The level the document's own sheet asks for: for a journal, OBSERVER is the level at
  // which a text page actually opens, and LIMITED is the tease.
  if (canOpenShown(source, user)) return true;
  return readsInPlace(pin) && canUserSee(anchorDoc, userId);
}

/**
 * Whether opening this pin shows the module's reader rather than the document's sheet.
 *
 * A prop always does — that is what makes it a prop rather than a pin with a picture —
 * and so does a pin set to read in place. One definition, because the opening itself
 * (`api.openLocally`) and the badge that predicts it must never disagree.
 */
export function readsInPlace(pin: DpPinFlags): boolean {
  return pin.mode === "prop" || pin.interaction.open === "readInPlace";
}
