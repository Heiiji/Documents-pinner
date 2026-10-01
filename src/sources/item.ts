/**
 * Items, as a source: a found object.
 *
 * The portrait card of `portrait.ts`: the item's picture, its name and the description
 * the GM chose. Unlike an actor, an item may be granted OBSERVER — an item's sheet is its
 * description — and a new pin on one follows the world's ownership-sync setting. Handing
 * the item itself over is the game system's business, not this module's.
 */

import { OWNERSHIP } from "../const";
import { portraitAdapter } from "./portrait";

export const itemAdapter = portraitAdapter({
  documentName: "Item",
  icon: "fa-suitcase",
  maxGrant: OWNERSHIP.OBSERVER,
  syncOnCreate: true,
  tokenArt: false,
});
