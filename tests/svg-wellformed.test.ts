/**
 * @vitest-environment jsdom
 *
 * The seam nothing covered: an SVG loaded through `Blob -> img.src` is parsed by the
 * XML parser, not the HTML one. Three independent producers feed that string — the
 * stylesheet, the sanitiser and the asset inliner — and any one of them emitting HTML
 * rather than XML makes EVERY prop fail on EVERY client, silently, forever.
 *
 * So this file does the one thing the 403 tests around it never did: it runs the REAL
 * `styles/card.css` and a body containing the constructs journal HTML actually holds
 * through the real pipeline, and hands the result to a real XML parser.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardHtml, svgDocument } from "../src/render/CardTemplate";
import { sanitise } from "../src/render/enrich";
import { inlineImages } from "../src/render/AssetInliner";

/**
 * Every sheet the rasteriser inlines, in the order `Rasterizer.INLINED` inlines them.
 *
 * Not just `card.css`: an SVG decoded through `Blob -> img.src` is an isolated document,
 * so the effect rules and the `@property` registrations have to travel with it or the
 * card carries a full dressing and nothing that consumes it. All three therefore have to
 * survive the XML parser, and `fx/effects.css` is the one with the `@media` blocks and
 * the `&` nesting that would break it.
 */
const CARD_CSS = ["fx/_props.css", "fx/effects.css", "card.css"]
  .map((name) =>
    readFileSync(join(import.meta.dirname, "..", "styles", ...name.split("/")), "utf8")
  )
  .join("\n");

/** Every construct that broke the parse, in one fixture. */
const FIXTURE_BODY =
  `<p>A line<br>and another</p>` +
  `<img src="data:image/png;base64,iVBORw0KGgo=" alt="">` +
  `<p>Non&nbsp;breaking</p>` +
  `<hr>` +
  `<ul><li>one<li>two</ul>` +
  `<table><tr><td>cell</td></tr></table>`;

function parseErrorIn(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const error = doc.querySelector("parsererror");
  return error ? error.textContent!.replace(/\s+/g, " ").trim() : null;
}

describe("the rasteriser's SVG is well-formed XML", () => {
  it("survives the real card.css, which uses native nesting", () => {
    const svg = svgDocument("<div></div>", CARD_CSS, 400, 560);
    expect(parseErrorIn(svg)).toBeNull();
  });

  it("survives a stylesheet that tries to close its own CDATA section", () => {
    const svg = svgDocument("<div></div>", `.x{content:"]]>"}`, 400, 560);
    expect(parseErrorIn(svg)).toBeNull();
  });

  it("survives sanitised journal HTML: void elements, entities and images", async () => {
    const body = await inlineImages(sanitise(FIXTURE_BODY, true));
    const card = cardHtml({
      title: "The Duke's Letter",
      bodyHtml: body,
      showTitle: true,
      paper: "parchment",
      fontPx: 15.38,
      padPx: 24,
      effectId: "aged-parchment",
    });
    expect(parseErrorIn(svgDocument(card, CARD_CSS, 400, 560))).toBeNull();
  });

  it("keeps a non-breaking space as a literal character, not an HTML entity", () => {
    const out = sanitise("<p>a&nbsp;b</p>", true);
    expect(out).not.toContain("&nbsp;");
    expect(out).toContain(" ");
  });

  it("closes void elements, which XML has no concept of", () => {
    expect(sanitise("<p>a<br>b</p>", true)).toContain("<br />");
    expect(sanitise('<img src="x.png">', true)).toMatch(/<img[^>]*\/>/);
  });

  it("reaches a fixpoint without accumulating duplicate xmlns declarations", () => {
    const once = sanitise(FIXTURE_BODY, true);
    expect(sanitise(once, true)).toBe(once);
    expect(once).not.toMatch(/xmlns[\s\S]*xmlns/);
  });

  it("serialises inlined images as XML too — that path guarantees an <img>", async () => {
    const out = await inlineImages('<p>x</p><img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(out).toMatch(/<img[^>]*\/>/);
  });
});

/**
 * Two inputs that still produced ill-formed XML after the first pass.
 *
 * Both are rare, and both were worse than "one bad card": the failure latch remembers the
 * key until the content changes, and the mesh is held at alpha 0 while a prop is being
 * drawn — so a single stray character turned into a prop that never appeared again for
 * the rest of the session, with nothing on screen to explain it.
 */
describe("inputs that are legal HTML and illegal XML", () => {
  const parse = (body: string) => parseErrorIn(svgDocument(body, "", 100, 100));

  it("drops a namespace declaration the page wrote itself", () => {
    // `serialiseXml` emits its own for foreign content, so the page's literal attribute
    // came out ALONGSIDE it on the same element: `duplicate attribute: xmlns`, which
    // fails the whole card. One declaration per element is correct and expected — an
    // `<svg>` and an XHTML `<div>` inside it are genuinely in different namespaces.
    const nested =
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject></svg>';
    const clean = sanitise(nested, true);

    for (const tag of clean.match(/<[a-z][^>]*>/gi) ?? []) {
      expect((tag.match(/\bxmlns\s*=/g) ?? []).length, tag).toBeLessThanOrEqual(1);
    }
    expect(parse(clean)).toBeNull();
  });

  it("removes control characters XML does not permit even escaped", () => {
    for (const code of [0x0b, 0x0c, 0x01, 0x1f]) {
      const body = `<p>a${String.fromCharCode(code)}b</p>`;
      expect(parse(sanitise(body, true)), `U+${code.toString(16)}`).toBeNull();
    }
  });

  it("keeps the three control characters XML does allow", () => {
    const clean = sanitise("<pre>a\tb\nc\rd</pre>", true);
    expect(clean).toContain("\t");
    expect(clean).toContain("\n");
  });

  it("keeps astral characters, which are perfectly legal XML", () => {
    const clean = sanitise("<p>\u{1F5DD}\u{FE0F} and \u{1D11E}</p>", true);
    expect(clean).toContain("\u{1F5DD}");
    expect(clean).toContain("\u{1D11E}");
    expect(parse(clean)).toBeNull();
  });
});
