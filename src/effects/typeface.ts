/**
 * The typeface a card is set in.
 *
 * PURE: no Foundry globals, at import time or inside a function body.
 *
 * A font name is a new string reaching CSS, and it arrives from the same place every
 * preset does — pasted in by a stranger (DESIGN §7). So it has exactly one way in and one
 * way out: `fontFamily` is the normaliser's rule, and `fontStack` is the only formatter
 * that turns a name into a `font-family` value, re-checking it on the way and quoting it.
 * Nothing else may build a stack from a stored name.
 *
 * The choice is a generic family or a face this world already registers — Foundry's own,
 * or one a GM added in Font Config. No font files ship with the module, and a name that
 * is missing on some client falls back to the house stack rather than to the browser's
 * default serif, so a card never changes character because one player lacks a face.
 */

import { escapeAttr, escapeHtml } from "../html";
import type { DpNotice } from "../types/dp";

/** The CSS generic families on offer: one for each kind of document a GM pins. */
export const GENERIC_FAMILIES = ["serif", "sans-serif", "monospace", "cursive"] as const;
export type GenericFamily = (typeof GENERIC_FAMILIES)[number];

/**
 * A registered family name, as this module will accept it.
 *
 * Letters, digits, spaces and `_ . ' -`, one to sixty-four of them. Everything that could
 * end a quoted CSS string or start a new token — quotes, a backslash, `;`, `,`, brackets
 * of any kind, a colon, a slash — is outside it, so a name that passes cannot escape the
 * double quotes `fontStack` puts it in. Every real family name fits.
 */
export const FONT_NAME = /^[\p{L}\p{N} _.'-]{1,64}$/u;

/**
 * What every card was set in before a typeface could be chosen, and what a missing face
 * falls back to. `card.css` carries the same list as the fallback of `--dp-font`, and a
 * test holds the two together.
 */
export const HOUSE_STACK = `"Signika", "Palatino Linotype", Palatino, Georgia, serif`;

/**
 * Each generic family as a curated stack rather than the bare keyword.
 *
 * A bare `monospace` is whatever the browser's default is — Courier on some systems, and
 * with a smaller default size besides — and `cursive` is Comic Sans on Windows. The named
 * faces first are the good ones each platform ships; the keyword last is the floor.
 */
const GENERIC_STACKS: Record<GenericFamily, string> = {
  serif: `"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`,
  "sans-serif": `"Helvetica Neue", Helvetica, Arial, sans-serif`,
  monospace: `ui-monospace, "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace`,
  cursive: `"Segoe Script", "Bradley Hand", cursive`,
};

function genericOf(value: string): GenericFamily | null {
  const lower = value.toLowerCase();
  return (GENERIC_FAMILIES as readonly string[]).includes(lower) ? (lower as GenericFamily) : null;
}

/**
 * Normalise a stored typeface: a generic family, a registered name, or `null`.
 *
 * `null` and an empty string mean "not chosen" and pass silently — that is the default
 * and the common case. A generic is matched without regard to case, as CSS matches the
 * keyword. Anything else that is not a name `FONT_NAME` accepts is dropped with a
 * warning: a value that could not be used is never silently the same as one that was
 * never set.
 */
export function fontFamily(
  value: unknown,
  warnings: DpNotice[],
  path: string,
  warnKey: string
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const clean = typeof value === "string" ? value.trim() : "";
  if (clean) {
    const generic = genericOf(clean);
    if (generic) return generic;
    if (FONT_NAME.test(clean)) return clean;
  }
  warnings.push({ key: warnKey, data: { path, value: String(value).slice(0, 64) } });
  return null;
}

/**
 * The `font-family` value for a typeface, or `null` for "the card's own".
 *
 * The one formatter. It re-checks what it is given rather than trusting the normaliser,
 * because it is the last step before CSS: a name that fails is `null`, never emitted.
 */
export function fontStack(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const clean = value.trim();
  const generic = genericOf(clean);
  if (generic) return GENERIC_STACKS[generic];
  return FONT_NAME.test(clean) ? `"${clean}", ${HOUSE_STACK}` : null;
}

/**
 * Everything a picker offers: the generics in their fixed order, then the world's faces
 * that pass `FONT_NAME`, sorted and without duplicates. A registered name that spells a
 * generic is the generic.
 */
export function fontChoices(registered: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const entry of registered) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim();
    if (!FONT_NAME.test(clean) || genericOf(clean)) continue;
    names.add(clean);
  }
  return [...GENERIC_FAMILIES, ...[...names].sort((a, b) => a.localeCompare(b))];
}

/**
 * What a picker calls a typeface: a registered face by its own name, a generic family by
 * what it is for, through the translator the caller hands in. The key's last segment is
 * camel-cased, because a key may not carry a hyphen.
 */
export function fontLabel(name: string, translate: (key: string) => string): string {
  const generic = genericOf(name);
  if (!generic) return name;
  return translate(`DP.font.${generic.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}`);
}

/**
 * The `<option>` list for a typeface picker, each option drawn in its own face.
 *
 * The empty value first, labelled by the caller: it means "the effect's" on a pin and
 * "the card's own" on a preset. A stored value that is no longer on offer — a face a GM
 * removed from Font Config — is kept as an option rather than shown as the empty choice,
 * which would claim a setting the pin does not have.
 */
export function fontOptionsMarkup(
  choices: readonly string[],
  selected: string | null,
  emptyLabel: string,
  labelOf: (name: string) => string
): string {
  const names = selected && !choices.includes(selected) ? [...choices, selected] : choices;
  const option = (value: string, label: string, stack: string | null) =>
    `<option value="${escapeAttr(value)}"` +
    (stack ? ` style="${escapeAttr(`font-family:${stack}`)}"` : "") +
    `${(selected ?? "") === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  return (
    option("", emptyLabel, null) +
    names.map((name) => option(name, labelOf(name), fontStack(name))).join("")
  );
}
