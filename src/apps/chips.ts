/**
 * The avatar chip: one circle per player, used identically by the HUD and the Pinboard.
 *
 * PURE: builds markup from plain data, so both surfaces get the same widget and its
 * behaviour is testable without a canvas. Whoever renders it supplies the users; the
 * rules for what a chip means live here.
 *
 * The chip encodes TWO facts, not one, and that is the whole point:
 *
 *   filled  = this player can SEE the pin
 *   hollow  = this player cannot
 *   key     = presence and content access DISAGREE
 *
 * That third state is the most valuable indicator in the module. A pin visible to a
 * player whose ownership was never raised looks perfectly correct to the GM and fails
 * at the table as "I can see it but it won't open" — a bug that is invisible from the
 * authoring side and embarrassing from the playing side. Making the disagreement a
 * distinct glyph, rather than something a GM could work out from two panels, is the
 * difference between catching it while prepping and catching it mid-session.
 *
 * The inverse mismatch — openable but not visible — is also flagged: it is how a GM
 * discovers they revealed a document days ago and forgot.
 */

import { escapeAttr, escapeHtml, initialOf } from "../html";
import type { DpNotice } from "../types/dp";

export interface ChipUser {
  id: string;
  name: string;
  /** The user's own colour, used for the ring so chips stay identifiable at a glance. */
  color: string;
  /** Avatar image path, or null to fall back to the initial. */
  avatar: string | null;
  canSee: boolean;
  canOpen: boolean;
}

export type ChipState = "visible" | "hidden" | "seesButCannotOpen" | "opensButCannotSee";

export function chipState(user: Pick<ChipUser, "canSee" | "canOpen">): ChipState {
  if (user.canSee && user.canOpen) return "visible";
  if (user.canSee && !user.canOpen) return "seesButCannotOpen";
  if (!user.canSee && user.canOpen) return "opensButCannotSee";
  return "hidden";
}

export function isMismatch(state: ChipState): boolean {
  return state === "seesButCannotOpen" || state === "opensButCannotSee";
}

/**
 * What the chip's tooltip says, as an i18n key.
 *
 * Phrased as the resulting STATE rather than the action, because a GM scanning a row
 * of chips is asking "what does Cléo get?", not "what does clicking do?". The action
 * is discoverable by doing it; the state is not discoverable at all.
 */
export function chipTooltip(user: ChipUser): DpNotice {
  return { key: `DP.chip.${chipState(user)}`, data: { name: user.name } };
}

/** A hex colour, or the fallback. Never interpolate a user value into CSS unchecked. */
function safeColor(value: string | null | undefined, fallback = "#7a7971"): string {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
    ? value
    : fallback;
}

/**
 * An avatar path safe to place in a `url()`.
 *
 * Rejects anything that could close the token or introduce another function — the same
 * rule `preset-css.safeUrl` applies, restated here because this is a second place a
 * stored string reaches CSS and the two must not diverge by omission.
 */
function safeAvatar(path: string | null): string | null {
  if (!path || /["'()\\]|^\s*javascript:/i.test(path)) return null;
  return path;
}

export interface ChipMarkupOptions {
  /** Localiser. Kept as a parameter so this module stays pure. */
  t: (notice: DpNotice) => string;
  /** Rendered smaller in a Pinboard row than in the HUD palette. */
  size?: "sm" | "md";
}

export function chipMarkup(user: ChipUser, options: ChipMarkupOptions): string {
  const state = chipState(user);
  const avatar = safeAvatar(user.avatar);
  const label = options.t(chipTooltip(user));

  const inner = avatar
    ? `<img class="dp-chip__avatar" src="${escapeAttr(avatar)}" alt="">`
    : `<span class="dp-chip__initial" aria-hidden="true">${escapeHtml(initialOf(user.name))}</span>`;

  const key = isMismatch(state) ? `<span class="dp-chip__key" aria-hidden="true">⚿</span>` : "";
  // The state first, then the gestures: the tooltip is the one place the modifier
  // vocabulary is taught, and it is the same two gestures on every surface.
  const title = `${label}\n${options.t({ key: "DP.chip.actions", data: { name: user.name } })}`;

  return [
    `<button type="button" class="dp-chip"`,
    ` role="checkbox" aria-checked="${user.canSee}"`,
    ` data-dp-user="${escapeAttr(user.id)}"`,
    ` data-dp-state="${state}"`,
    ` style="--dp-chip-color:${safeColor(user.color)}"`,
    ` title="${escapeAttr(title)}" aria-label="${escapeAttr(label)}">`,
    inner,
    key,
    `</button>`,
  ].join("");
}

/**
 * A whole row of chips.
 *
 * Empty rather than absent when there are no players: a GM alone in a world testing a
 * scene should see that the pin has nobody to be visible to, not an unexplained gap.
 */
export function chipsMarkup(users: readonly ChipUser[], options: ChipMarkupOptions): string {
  const size = options.size ?? "md";
  const body = users.length
    ? users.map((u) => chipMarkup(u, options)).join("")
    : `<span class="dp-chips__empty">${escapeHtml(options.t({ key: "DP.chip.noPlayers" }))}</span>`;

  return `<div class="dp-chips" data-dp-size="${size}" role="group">${body}</div>`;
}

/**
 * A one-line summary of a whole row, for the Pinboard's screen-reader label and the
 * HUD's status line. Counting is done here so both surfaces count the same way.
 */
export function describeChips(users: readonly ChipUser[]): DpNotice {
  const seeing = users.filter((u) => u.canSee).length;
  const mismatched = users.filter((u) => isMismatch(chipState(u))).length;

  if (!users.length) return { key: "DP.chip.noPlayers" };
  if (mismatched) {
    return { key: "DP.chip.summaryMismatch", data: { seeing, total: users.length, mismatched } };
  }
  return { key: "DP.chip.summary", data: { seeing, total: users.length } };
}
