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

const CARD_CSS = readFileSync(join(import.meta.dirname, "..", "styles", "card.css"), "utf8");

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
      padding: 0.06,
      width: 400,
      height: 560,
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
