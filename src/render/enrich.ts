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

import { logger } from "../log";
import { ns } from "../fvtt";

const log = logger("sanitise");

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
  // `noscript` is a PARSER-MODE bomb, not an executable element. `DOMParser` parses with
  // scripting disabled, where its content is ordinary markup; `innerHTML` on a live page
  // parses with scripting ENABLED, where its content is raw text — so a `</noscript>`
  // inside an attribute value closes the element early and everything after it becomes
  // live markup in the browser and inert markup to us. Verified with parse5: the same
  // string yields `noscript p[title]` to the sanitiser and `noscript img[src,onerror] p`
  // to the browser, and the same trick resurrects a stripped `.secret` section.
  //
  // A6's round-trip cannot catch this by construction — it reaches a fixpoint of the
  // wrong parser on the first pass — so the element is removed outright. A journal page
  // has no use for one.
  "noscript",
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
  // `[;,]` and not `;`: a data URL's media type is followed by a comma when there are no
  // parameters, so `data:image/png,...` and `data:image/svg+xml,%3Csvg...` — which is
  // exactly the shape `effects/textures.ts` generates — were misclassified as dangerous.
  // The separator is required, so `data:image/pngevil,` is still refused.
  if (url.startsWith("data:")) {
    return !/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/.test(url);
  }
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
      // A namespace declaration the page wrote itself. Meaningless in journal HTML, and
      // fatal downstream: `serialiseXml` emits its own declaration for foreign content,
      // so an inner `<div xmlns="…">` inside an `<svg>` comes out with the attribute
      // twice — `duplicate attribute: xmlns`, which fails the whole card.
      else if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) {
        element.removeAttribute(attr.name);
      }
    }
    // `querySelectorAll` does not cross into a template's DocumentFragment, so
    // `<template><script>...</script></template>` survived the scrub byte-for-byte.
    // Inert in the HTML reader — and the whole point is that the same string is then
    // concatenated into an XML document, where `<template>` means nothing at all.
    const content = (element as HTMLTemplateElement).content;
    if (content) scrub(content);
  }
}

/**
 * Characters XML 1.0 does not permit at all, even escaped.
 *
 * A vertical tab or a form feed pasted into a journal is invisible in the editor and
 * fatal in the rasteriser: `disallowed character`, so the SVG never parses. With the
 * failure latch remembering the key and the mesh held at alpha 0, that turns one stray
 * character into a prop that never appears again for the rest of the session — so they
 * are removed rather than escaped. Tab, newline and carriage return are the three
 * control characters XML does allow, and they are kept.
 */
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export function stripIllegalXmlChars(text: string): string {
  return String(text ?? "").replace(XML_ILLEGAL, "");
}

/**
 * Serialise a parsed body's children as XML rather than as HTML.
 *
 * This is load-bearing, and it is the reason nothing ever rendered. The card ends up
 * inside an SVG `foreignObject` that is parsed by the XML parser: `body.innerHTML`
 * leaves `<br>` and `<img>` unclosed and turns U+00A0 into `&nbsp;`, and every one of
 * those makes the whole SVG ill-formed. XML serialisation self-closes void elements and
 * emits the character rather than an entity XML has never heard of.
 *
 * The BODY is serialised and its own tags sliced off, rather than each child being
 * serialised separately: a per-child serialisation stamps `xmlns` onto every top-level
 * node, and re-parsing that as HTML turns the declaration into a plain attribute, so
 * the next pass emits it twice and the "well-formed" output is not.
 */
export function serialiseXml(body: ParentNode & { firstChild: ChildNode | null }): string {
  const Serializer = (globalThis as any).XMLSerializer;
  if (!Serializer || !body.firstChild) return "";

  const xml: string = new Serializer().serializeToString(body);
  const open = xml.indexOf(">");
  const close = xml.lastIndexOf("</");
  if (open < 0 || close <= open) return "";
  return xml.slice(open + 1, close);
}

/**
 * Remove GM secret sections. Applied whenever the viewer is not an owner.
 *
 * Descends into template content for the same reason `scrub` does: `querySelectorAll`
 * does not cross a DocumentFragment boundary, and this is the one filter in the module
 * where missing a node means a GM's notes reach a player.
 */
export function stripSecrets(root: ParentNode): void {
  for (const secret of [...root.querySelectorAll("section.secret, .secret")]) secret.remove();
  for (const element of [...root.querySelectorAll("template")]) {
    const content = (element as HTMLTemplateElement).content;
    if (content) stripSecrets(content);
  }
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
  let current = stripIllegalXmlChars(html ?? "");
  for (let pass = 0; pass < 3; pass++) {
    const doc = new Parser().parseFromString(`<body>${current}</body>`, "text/html");
    const body = doc.body;
    if (!body) return "";

    if (!isOwner) stripSecrets(body);
    scrub(body);

    const next = serialiseXml(body);
    if (next === current) return next;
    current = next;
  }

  // FAIL CLOSED. Reaching here means the markup did not settle in three passes, i.e. it
  // is by definition not at a fixpoint — which is precisely the shape mutation XSS takes.
  // Returning `current` shipped exactly the input this loop exists to reject.
  log.warn(`sanitiser did not converge; content dropped`);
  return "";
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
