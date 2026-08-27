/**
 * Audience resolution — who can see a pin.
 *
 * PURE: this module must never touch a Foundry global, at import time or inside a
 * function body. Callers pass a plain context, so every rule here is unit-testable
 * under Node. Line-of-sight is injected as a boolean, never computed here.
 *
 * The audience model is deliberately decoupled from document ownership. Core ties
 * Map Note visibility to the linked journal's permissions, which is exactly the
 * wrong coupling for "reveal the letter the moment they find it".
 */

import type { DpAudience, DpAudienceKind, DpNotice } from "../types/dp";

export interface AudienceContext {
  isGM: boolean;
  userId: string;
  /** The anchor TileDocument's core `hidden` field. */
  hidden: boolean;
  /**
   * For `kind === "discovered"`: whether this user currently has line of sight to
   * the pin. Computed by the caller via `canvas.visibility.testVisibility`.
   */
  hasLineOfSight?: boolean;
}

export function makeAudience(overrides: Partial<DpAudience> = {}): DpAudience {
  return {
    kind: "hidden",
    users: [],
    discovered: [],
    sticky: true,
    restore: null,
    ownershipSync: { enabled: true, level: 2 },
    ...overrides,
  };
}

/**
 * The single visibility predicate. Everything else in the module — the mesh's
 * `visible`, the hit area, the Pinboard chips — reads through this.
 */
export function canSee(audience: DpAudience, ctx: AudienceContext): boolean {
  // The GM always sees their own scene; core already renders hidden tiles translucent.
  if (ctx.isGM) return true;

  // The core `hidden` field is authoritative for players and stays meaningful even
  // if this module is disabled, so it is checked before our own kinds.
  if (ctx.hidden || audience.kind === "hidden") return false;

  switch (audience.kind) {
    case "everyone":
      return true;
    case "selected":
      return audience.users.includes(ctx.userId);
    case "discovered":
      if (audience.sticky && audience.discovered.includes(ctx.userId)) return true;
      return ctx.hasLineOfSight === true;
    default:
      return false;
  }
}

/**
 * Whether the acting GM should persist a discovery for this user right now.
 * Returns false when the record already exists, so callers can skip the write.
 *
 * DELIBERATELY UNWIRED, and the Pin Studio no longer offers the `discovered` audience
 * because of it. Persisting a discovery needs to know that a PLAYER's vision reached the
 * pin, and there is no honest way to learn that under the module's own constraints:
 * players never write pin configuration (DESIGN §3) and the module ships no socket
 * (DESIGN §8). Line-of-sight visibility itself works — every client evaluates its own —
 * so `canSee` keeps handling the kind for any payload that already carries it.
 *
 * The route in is a GM-side sweep over each player's own tokens' vision polygons. It is
 * written up in DESIGN A9 as deferred rather than left here as a caller-less function
 * that looks finished.
 */
export function shouldRecordDiscovery(audience: DpAudience, ctx: AudienceContext): boolean {
  if (audience.kind !== "discovered" || !audience.sticky) return false;
  if (ctx.isGM || ctx.hasLineOfSight !== true) return false;
  return !audience.discovered.includes(ctx.userId);
}

/**
 * The set of ownership keys that should hold a grant for this audience.
 * `"default"` covers every user at once; otherwise explicit user ids.
 */
export function grantKeysFor(audience: DpAudience, allPlayerIds: readonly string[]): string[] {
  switch (audience.kind) {
    case "everyone":
      return ["default"];
    case "selected":
      return audience.users.filter((id) => allPlayerIds.includes(id));
    case "discovered":
      return audience.discovered.filter((id) => allPlayerIds.includes(id));
    case "hidden":
    default:
      return [];
  }
}

/** Whether the anchor's core `hidden` field should be true for this audience. */
export function anchorHidden(audience: DpAudience): boolean {
  return audience.kind === "hidden";
}

/**
 * The eye toggle. Hiding remembers the current state; un-hiding restores it, so the
 * control behaves as a true on/off rather than resetting the GM's per-player work.
 */
export function toggleVisibility(audience: DpAudience): DpAudience {
  if (audience.kind === "hidden") {
    const restore = audience.restore;
    // A remembered "selected" with an empty list means nobody, which is just hidden
    // again. Fall back to everyone so the toggle always actually reveals something.
    const usable = restore && (restore.kind !== "selected" || restore.users.length > 0);
    return {
      ...audience,
      kind: usable ? restore.kind : "everyone",
      users: usable ? [...restore.users] : [],
      restore: null,
    };
  }
  return {
    ...audience,
    kind: "hidden",
    restore: { kind: audience.kind, users: [...audience.users] },
  };
}

/**
 * Toggle one user, from a HUD or Pinboard avatar chip.
 *
 * Un-toggling a user while the audience is `everyone` necessarily narrows it to an
 * explicit list, and emptying that list normalises back to `hidden` so the state is
 * carried by the core field rather than by an empty selection.
 */
export function setUserVisible(
  audience: DpAudience,
  userId: string,
  visible: boolean,
  allPlayerIds: readonly string[]
): DpAudience {
  const current = new Set(
    audience.kind === "everyone"
      ? allPlayerIds
      : audience.kind === "discovered"
        ? audience.discovered
        : audience.users
  );

  if (visible) current.add(userId);
  else current.delete(userId);

  const users = allPlayerIds.filter((id) => current.has(id));

  if (users.length === 0) {
    return {
      ...audience,
      kind: "hidden",
      users: [],
      restore: { kind: "everyone", users: [] },
    };
  }
  if (users.length === allPlayerIds.length) {
    return { ...audience, kind: "everyone", users: [], restore: null };
  }
  return { ...audience, kind: "selected", users, restore: null };
}

/** Shift-click on a chip: only this user sees it. One gesture for a private note. */
export function soloUser(audience: DpAudience, userId: string): DpAudience {
  return { ...audience, kind: "selected", users: [userId], restore: null };
}

/**
 * The `V` keybinding: cycle through the states a GM reaches for most.
 *
 * "Selected" is only visited when this pin actually has a remembered per-player list.
 * Cycling into an empty selection would mean "nobody", which is indistinguishable from
 * hidden and would make the keybinding feel broken.
 */
export function cycleAudience(audience: DpAudience): DpAudience {
  const remembered = audience.users.length ? audience.users : (audience.restore?.users ?? []);
  const order: DpAudienceKind[] = remembered.length
    ? ["everyone", "selected", "hidden"]
    : ["everyone", "hidden"];

  // An unlisted kind (e.g. "discovered") lands at index -1 and therefore steps to
  // "everyone", which is the sane escape hatch.
  const next = order[(order.indexOf(audience.kind) + 1) % order.length];

  if (next === "hidden") return toggleVisibility(audience);
  if (next === "selected") {
    return { ...audience, kind: "selected", users: [...remembered], restore: null };
  }
  return { ...audience, kind: "everyone", users: [], restore: null };
}

/**
 * A description of the resulting state, as an i18n key plus data. Pure modules return
 * keys, never prose, so localisation happens at the edge.
 */
export function describeAudience(audience: DpAudience, userCount: number): DpNotice {
  switch (audience.kind) {
    case "hidden":
      return { key: "DP.audience.hidden" };
    case "everyone":
      return { key: "DP.audience.everyone" };
    case "selected":
      return { key: "DP.audience.selected", data: { count: audience.users.length, userCount } };
    case "discovered":
      return { key: "DP.audience.discovered", data: { count: audience.discovered.length } };
    default:
      return { key: "DP.audience.unknown" };
  }
}
