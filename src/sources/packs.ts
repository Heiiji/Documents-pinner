/**
 * Compendium packs, and who can read them.
 *
 * IMPURE, and small. A pack's permissions are not a document's: they are per ROLE and
 * pack-wide ("Compendium content ignores the ownership field in favor of User role-based
 * ownership", TYPES `common/abstract/document.d.mts:342-358`), so there is no grant to
 * make and nothing this module may write. What it can do is ask, for any user, whether
 * their role reads the pack — and because roles are user data, the GM's client can answer
 * for every player without a player's client being involved.
 *
 * Nothing here runs per frame. `describeSource` reports which pack a source is in; who
 * can read it is asked here, by the caller that needs it, when it needs it.
 */

import { OWNERSHIP } from "../const";
import { g, playerIds } from "../fvtt";
import { isPackUuid, parseSourceUuid } from "./uuid";

/** What the rest of the module needs to know about a pack, as plain data. */
export interface PackFacts {
  /** `${package}.${pack}`, the key of `game.packs`. */
  id: string;
  /** The pack's label, as the compendium sidebar shows it. */
  title: string;
  /** The type of document the pack holds. */
  documentName: string;
}

/** The pack a compendium uuid points into, if this client holds it. */
export function packOf(uuid: unknown): any | null {
  if (!isPackUuid(uuid)) return null;
  const packId = parseSourceUuid(uuid)?.packId;
  return packId ? (g()?.packs?.get?.(packId) ?? null) : null;
}

export function packFacts(pack: any): PackFacts {
  const id = String(pack?.collection ?? pack?.metadata?.id ?? "");
  return {
    id,
    title: String(pack?.title ?? pack?.metadata?.label ?? id),
    documentName: String(pack?.documentName ?? pack?.metadata?.type ?? ""),
  };
}

/** Core's user roles and the level names a pack's ownership record uses. */
const ROLE: Record<string, number> = { PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 };
const LEVEL: Record<string, number> = {
  NONE: OWNERSHIP.NONE,
  LIMITED: OWNERSHIP.LIMITED,
  OBSERVER: OWNERSHIP.OBSERVER,
  OWNER: OWNERSHIP.OWNER,
};
/** A pack that states no ownership (TYPES `base-package.d.mts:264-270`). */
const DEFAULT_PACK_OWNERSHIP = { PLAYER: "OBSERVER", ASSISTANT: "OWNER" };

/**
 * The level a user of `role` holds on a pack with this ownership record.
 *
 * PURE. The highest level among the roles the user has — a user has every role at or
 * below their own, which is also what `INHERIT` means, so an `INHERIT` entry is skipped.
 * A bare string is the shorthand for the PLAYER role. The last resort of
 * `packReadableBy`, for a core whose pack answers neither permission question.
 */
export function packLevelFor(ownership: unknown, role: number): number {
  const record: Record<string, unknown> =
    typeof ownership === "string"
      ? { PLAYER: ownership }
      : ownership && typeof ownership === "object"
        ? (ownership as Record<string, unknown>)
        : DEFAULT_PACK_OWNERSHIP;
  let level: number = OWNERSHIP.NONE;
  for (const [name, value] of Object.entries(record)) {
    const needs = ROLE[name];
    const grants = typeof value === "string" ? LEVEL[value] : undefined;
    if (needs === undefined || grants === undefined) continue;
    if (role >= needs) level = Math.max(level, grants);
  }
  return level;
}

/**
 * Whether this user can open documents from this pack: OBSERVER for their role.
 *
 * A GM always can: a pack's ownership schema fixes the GAMEMASTER role at OWNER, with no
 * other choice (TYPES `compendium-collection.d.mts:393`). Otherwise the pack is asked —
 * `testUserPermission`, then `getUserLevel`, then its ownership record read by hand — and
 * an answer that cannot be had is "no": the conservative mistake costs a warning, the
 * other one a blank card.
 */
export function packReadableBy(pack: any, user: any): boolean {
  if (!pack || !user) return false;
  if (user.isGM === true) return true;
  try {
    if (typeof pack.testUserPermission === "function") {
      return pack.testUserPermission(user, "OBSERVER") === true;
    }
    if (typeof pack.getUserLevel === "function") {
      return Number(pack.getUserLevel(user)) >= OWNERSHIP.OBSERVER;
    }
  } catch {
    return false;
  }
  return (
    packLevelFor(pack.ownership ?? pack.metadata?.ownership, Number(user.role) || 0) >=
    OWNERSHIP.OBSERVER
  );
}

/** The players whose role cannot read this pack, in `playerIds` order. */
export function playersWhoCannotRead(pack: any): string[] {
  const users = g()?.users;
  return playerIds().filter((id) => !packReadableBy(pack, users?.get?.(id)));
}

/**
 * Whether EVERY current player can read the pack. A pack only trusted players read is
 * not one "the players" can read. No players at all: nobody is left out.
 */
export function playersCanRead(pack: any): boolean {
  return playersWhoCannotRead(pack).length === 0;
}

/**
 * Whether this client must not ask the server for this source at all: it is in a pack
 * this user's role cannot read, or one this client was not even sent.
 *
 * What a refused load does on a player's client is unmeasured — a null, a throw, or an
 * error toast per attempt, and the card is resolved again at every level-of-detail pass
 * (probe C1). So the role is asked first, and the answer is a placeholder that says why.
 */
export function packLockedHere(uuid: unknown): boolean {
  if (!isPackUuid(uuid)) return false;
  const user = g()?.user;
  if (user?.isGM === true) return false;
  return !packReadableBy(packOf(uuid), user);
}
