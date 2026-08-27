/**
 * The ONE place content is enriched, and the one place it is scrubbed.
 *
 * IMPURE at the edges, with the policy pure and tested at the top.
 *
 * Three rules, and they are the strongest guarantees the module makes:
 *
 * 1. **Nothing is ever rendered on one client and broadcast.** Every client enriches
 *    from its own copy of the document. There is no socket carrying HTML, so there is
 *    no path by which one user's view of a page can reach another user at all.
 *
 * 2. **`secrets` is computed from the VIEWING user, never from the GM.** It is
 *    `page.isOwner` on this client — never `game.user.isGM`, and never a value that
 *    travelled from somewhere else. A GM's secret sections are stripped before the
 *    player's HTML exists, which is the one thing here that is genuinely *removed*
 *    rather than hidden.
 *
 * 3. **The result is scrubbed anyway.** Enriched HTML goes into markup we build
 *    ourselves rather than into a core sheet, so it is walked and stripped of scripts,
 *    frames, event handlers and executable URLs. Foundry exposes no public sanitiser,
 *    and a regex over HTML is a well-known way to be confidently wrong, so the scrub
 *    parses a real tree and walks it.
 *
 * The secret post-filter in step 2 is belt-and-braces on top of `enrichHTML` already
 * having dropped them: this is the one place in the module where being wrong leaks a
 * GM's notes to a player, so it does not rely on a single mechanism.
 */

import { ns } from "../fvtt";

/** Elements that can execute, navigate or reach the network. Removed outright. */
export const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  // A page-supplied <style> is not dangerous so much as unscoped: in the DOM reader it
  // would escape the card and restyle Foundry itself.
  "style",
]);

/**
 * Whitespace and control characters, which are stripped before a scheme is inspected.
 * `java\tscript:` and `java\nscript:` both navigate; matching them is the point.
 */
// eslint-disable-next-line no-control-regex
const SCHEME_NOISE = /[\u0000-\u0020]/g;

const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "data"]);

/**
 * Whether a URL could execute rather than fetch.
 *
 * `data:` is allowed only for images, because the rasteriser produces exactly those
 * and nothing else needs it; `data:text/html` is a navigation primitive.
 */
export function isDangerousUrl(value: string): boolean {
  const url = String(value ?? "")
    // Entities and stray whitespace inside a scheme are the classic bypass.
    .replace(SCHEME_NOISE, "")
    .toLowerCase();

  if (/^(javascript|vbscript|file|blob):/.test(url)) return true;
  if (url.startsWith("data:")) return !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/.test(url);
  return false;
}

/**
 * A name the HTML parser could legitimately have produced.
 *
 * Malformed markup like `<scr<script>` parses into an element whose tag name itself
 * contains `<script` — it survives a name-based deny-list, and then re-parses into a
 * live script the next time the string touches a parser. Anything that is not a
 * well-formed element name is therefore removed on sight, which leaves genuine custom
 * elements (`document-embed`, `enriched-content`) and SVG's camelCase names alone.
 */
const VALID_TAG_NAME = /^[a-z][a-z0-9-]*$/i;

export function isDangerousTag(tagName: string): boolean {
  const name = String(tagName ?? "").toLowerCase();
  return !VALID_TAG_NAME.test(name) || FORBIDDEN_TAGS.has(name);
}

/**
 * Whether an attribute should be dropped.
 *
 * Event handlers go by prefix rather than by list: `on*` is exhaustive and a list
 * would be one browser release behind forever.
 */
export function isDangerousAttr(name: string, value: string): boolean {
  const attr = String(name ?? "").toLowerCase();
  if (attr.startsWith("on")) return true;
  if (URL_ATTRS.has(attr)) return isDangerousUrl(value);
  if (attr === "style")
    return /expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding/i.test(value);
  if (attr === "srcdoc" || attr === "srcset") return true;
  return false;
}

/**
 * Strip everything executable from a parsed fragment, in place.
 *
 * Exported and DOM-shaped rather than string-shaped so it can be tested against a real
 * parser: a sanitiser tested only through its own string output is tested against its
 * own assumptions about how HTML parses.
 */
export function scrub(root: ParentNode): void {
  for (const element of [...root.querySelectorAll("*")]) {
    if (isDangerousTag(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      if (isDangerousAttr(attr.name, attr.value)) element.removeAttribute(attr.name);
    }
  }
}

/** Remove GM secret sections. Applied whenever the viewer is not an owner. */
export function stripSecrets(root: ParentNode): void {
  for (const secret of [...root.querySelectorAll("section.secret, .secret")]) secret.remove();
}

export interface EnrichedContent {
  html: string;
  /** Whether this client's user owns the source, which is what gates secrets. */
  isOwner: boolean;
}

/**
 * Enrich a document's text for THIS client's user.
 *
 * `relativeTo` and `rollData` are passed so `@UUID` links resolve relatively and inline
 * rolls read the right actor — an enrichment that silently loses either produces
 * content that looks right and links nowhere.
 */
export async function enrichFor(source: any, text: string): Promise<EnrichedContent> {
  const isOwner = source?.isOwner === true;
  const TextEditor = ns("applications.ux.TextEditor.implementation");

  let html = text ?? "";
  if (TextEditor?.enrichHTML) {
    html = await TextEditor.enrichHTML(html, {
      // NEVER game.user.isGM, and never a value from another client. See rule 2.
      secrets: isOwner,
      documents: true,
      links: true,
      rolls: true,
      embeds: true,
      relativeTo: source,
      rollData: source?.parent?.getRollData?.() ?? {},
    });
  }

  return { html: sanitise(html, isOwner), isOwner };
}

/**
 * Parse, scrub and re-serialise.
 *
 * `DOMParser` rather than `innerHTML` on a live element: parsing into an inert
 * document means nothing in the input can load, execute or fire during the scrub
 * itself, which an attached element cannot promise.
 */
export function sanitise(html: string, isOwner: boolean): string {
  const Parser = (globalThis as any).DOMParser;
  if (!Parser) return "";

  // Parse, scrub, serialise — then check that re-parsing the result produces the same
  // string. Mutation XSS works precisely by surviving one such round trip: markup that
  // scrubs clean re-parses into something that does not. Repeat until it settles, with
  // a hard bound so a pathological input cannot spin here.
  let current = html ?? "";
  for (let pass = 0; pass < 3; pass++) {
    const doc = new Parser().parseFromString(`<body>${current}</body>`, "text/html");
    const body = doc.body;
    if (!body) return "";

    if (!isOwner) stripSecrets(body);
    scrub(body);

    const next = body.innerHTML;
    if (next === current) return next;
    current = next;
  }
  return current;
}

/**
 * Re-enrich as if the viewer were a given user — the GM's "show me what they see".
 *
 * This is an AUDIT tool, not a security boundary: it re-runs the same pipeline with
 * `isOwner` forced to what that user would have, so a GM can check before revealing
 * rather than after a player tells them. It never affects what anyone else receives.
 */
export async function enrichAsUser(source: any, text: string, user: any): Promise<EnrichedContent> {
  const isOwner = source?.testUserPermission?.(user, "OWNER") === true;
  const TextEditor = ns("applications.ux.TextEditor.implementation");

  let html = text ?? "";
  if (TextEditor?.enrichHTML) {
    html = await TextEditor.enrichHTML(html, {
      secrets: isOwner,
      documents: true,
      links: true,
      rolls: false,
      embeds: true,
      relativeTo: source,
      rollData: {},
    });
  }
  return { html: sanitise(html, isOwner), isOwner };
}
