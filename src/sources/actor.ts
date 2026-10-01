/**
 * Actors, as a source: a wanted poster.
 *
 * The portrait card of `portrait.ts`, with an actor's two differences. Its picture may be
 * its prototype token's, when its own image is a default. And a reveal grants it LIMITED
 * at most, whatever the pin's level says (DESIGN A28, the owner's D2): OBSERVER on an NPC
 * opens its whole sheet, stats included, and probably its tokens' sight with it. For the
 * same reason a new pin on an actor starts with ownership sync OFF — the poster reads in
 * place without any grant, so the GM opts in per pin, warned by the Audience tab.
 */

import { OWNERSHIP } from "../const";
import { portraitAdapter } from "./portrait";

export const actorAdapter = portraitAdapter({
  documentName: "Actor",
  icon: "fa-user",
  maxGrant: OWNERSHIP.LIMITED,
  syncOnCreate: false,
  tokenArt: true,
});
