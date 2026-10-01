/**
 * A user changed: the `updateUser` and `userConnected` hooks.
 *
 * IMPURE through the effects it is handed and one read of who this client is — the
 * surfaces it refreshes belong to the modules `main.ts` wires in, as `tile-hooks.ts` and
 * `sources/hooks.ts` do for tiles and sources.
 *
 * Both hooks ran `refreshAllPins(); syncHitLayer(); refreshPinboard();` on every client for
 * any user's change, and `updateUser` fires whenever any module writes any user's flags,
 * which modules do for preferences of every kind. `syncHitLayer` rebuilds the hit areas, and
 * rebuilding them clears the hover (`PropHitLayer.sync`): a player reading a prop's tooltip
 * lost it under the pointer whenever someone else's client stored something. So each
 * surface now follows only what it reads of a user:
 *
 * - **The hit areas** are this user's — who they are, what they may open. Only a change to
 *   THIS user rebuilds them.
 * - **The card cache** holds what was enriched for this user (`render/card-cache.ts`): a
 *   change to their role or their permissions forgets it, since links, embeds and what a
 *   role may read all enrich differently.
 * - **The pins and the HUD** read `playerIds()` (`fvtt.ts`) — every non-GM user — and the
 *   GM's chips and eye are drawn from it. Only a ROLE change moves it, anyone's.
 * - **The Pinboard** writes names and colours on its chips: any change.
 *
 * A connection changes none of those — no chip shows whether a user is connected — so
 * `userConnected` refreshes the Pinboard alone, which costs nothing while it is closed.
 */

import { g } from "../fvtt";

/** What a user's change can set in motion, each a door into a module wired by `main.ts`. */
export interface UserChangeEffects {
  /** Rebuild this user's hit areas. */
  rebuildHits(): void;
  /** Forget every card this user's enrichment made. */
  forgetCards(): void;
  /** Redraw every pin, and the HUD bound to one. */
  redrawPins(): void;
  /** Bring the Pinboard's rows in line. */
  refreshBoard(): void;
}

/** Whether a user document is the one this client is signed in as. */
function isThisUser(user: any): boolean {
  if (user?.isSelf === true) return true;
  const id = g()?.user?.id;
  return typeof id === "string" && user?.id === id;
}

/** Whether an update's diff names a field. Core hands the diff, not the whole document. */
function names(changed: unknown, field: string): boolean {
  return typeof changed === "object" && changed !== null && field in changed;
}

/** The `updateUser` handler. */
export function userUpdateHandler(effects: UserChangeEffects) {
  return (user: any, changed: unknown): void => {
    const roleChanged = names(changed, "role");
    if (isThisUser(user)) {
      effects.rebuildHits();
      if (roleChanged || names(changed, "permissions")) effects.forgetCards();
    }
    if (roleChanged) effects.redrawPins();
    effects.refreshBoard();
  };
}

/** The `userConnected` handler. */
export function userConnectedHandler(effects: Pick<UserChangeEffects, "refreshBoard">) {
  return (): void => effects.refreshBoard();
}
