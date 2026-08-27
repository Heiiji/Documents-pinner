/**
 * HTML escaping.
 *
 * PURE: no Foundry globals, no DOM. Escaping is a string operation and belongs
 * somewhere a test can reach without a browser.
 *
 * This module deliberately does NOT sanitise arbitrary HTML. A regex-based sanitiser
 * is a well-known way to be wrong quietly, and the module has a DOM available wherever
 * it inserts enriched content, so the scrub in `render/enrich.ts` parses and walks a
 * tree instead. What lives here is the other half of the problem: interpolating
 * untrusted TEXT — a player's display name, a document title, a GM's tooltip — into
 * markup we generate ourselves.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for insertion into element content. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Escape text for insertion into a double-quoted attribute value.
 *
 * Identical to `escapeHtml` in effect, but named separately at the call site: an
 * attribute that stops being quoted during an edit is a hole that a reviewer can only
 * spot if the intent was written down.
 */
export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

/**
 * A single displayable initial for an avatar chip.
 *
 * Code points rather than UTF-16 units, so a name starting with an emoji or an
 * astral-plane character yields one glyph instead of half a surrogate pair.
 */
export function initialOf(name: string): string {
  const first = [...String(name ?? "").trim()][0];
  return first ? first.toUpperCase() : "?";
}
