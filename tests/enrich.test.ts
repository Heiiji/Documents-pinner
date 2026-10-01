/**
 * @vitest-environment jsdom
 *
 * The sanitiser is tested against a real HTML parser on purpose: a sanitiser checked
 * only through its own string output is checked against its own assumptions about how
 * browsers parse, which is exactly where these things go wrong.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  enrichFor,
  isDangerousAttr,
  isDangerousTag,
  isDangerousUrl,
  sanitise,
} from "../src/render/enrich";

const clean = (html: string) => sanitise(html, false);
const asOwner = (html: string) => sanitise(html, true);

describe("isDangerousUrl", () => {
  it("rejects executable schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "vbscript:x",
      "file:///etc/passwd",
      "blob:http://x",
    ]) {
      expect(isDangerousUrl(url), url).toBe(true);
    }
  });

  it("rejects a scheme hidden behind whitespace, tabs or control characters", () => {
    for (const url of [
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:x",
      "\u0001javascript:x",
      "\u0000javascript:x",
    ]) {
      expect(isDangerousUrl(url), JSON.stringify(url)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isDangerousUrl("JaVaScRiPt:alert(1)")).toBe(true);
  });

  it("allows image data URIs, which the rasteriser itself produces", () => {
    expect(isDangerousUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    expect(isDangerousUrl("data:image/webp;base64,AAAA")).toBe(false);
  });

  it("rejects a data URI that is not an image", () => {
    expect(isDangerousUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(true);
    expect(isDangerousUrl("data:application/javascript,alert(1)")).toBe(true);
  });

  it("allows ordinary paths and http(s) URLs", () => {
    for (const url of [
      "worlds/keep/a.webp",
      "/icons/svg/book.svg",
      "https://example.com/x.png",
      "#anchor",
    ]) {
      expect(isDangerousUrl(url), url).toBe(false);
    }
  });
});

describe("isDangerousTag", () => {
  it("catches every executing or navigating element, in any case", () => {
    for (const tag of [
      "script",
      "SCRIPT",
      "iframe",
      "object",
      "embed",
      "link",
      "meta",
      "base",
      "form",
      "style",
    ]) {
      expect(isDangerousTag(tag), tag).toBe(true);
    }
  });

  it("leaves ordinary content elements alone", () => {
    for (const tag of ["p", "div", "img", "a", "section", "table", "h1"]) {
      expect(isDangerousTag(tag), tag).toBe(false);
    }
  });
});

describe("isDangerousAttr", () => {
  it("drops every on* handler by prefix, not by list", () => {
    for (const name of ["onclick", "onerror", "ONLOAD", "onanimationstart", "onbeforetoggle"]) {
      expect(isDangerousAttr(name, "x"), name).toBe(true);
    }
  });

  it("drops srcdoc and srcset outright", () => {
    expect(isDangerousAttr("srcdoc", "<script>")).toBe(true);
    expect(isDangerousAttr("srcset", "a.png 1x")).toBe(true);
  });

  it("judges URL attributes by their value", () => {
    expect(isDangerousAttr("href", "javascript:x")).toBe(true);
    expect(isDangerousAttr("href", "https://example.com")).toBe(false);
    expect(isDangerousAttr("src", "worlds/a.png")).toBe(false);
  });

  it("drops a style attribute only when it can execute", () => {
    expect(isDangerousAttr("style", "color: red")).toBe(false);
    expect(isDangerousAttr("style", "width: expression(alert(1))")).toBe(true);
    expect(isDangerousAttr("style", "background:url(javascript:x)")).toBe(true);
    expect(isDangerousAttr("style", "-moz-binding: url(evil.xml)")).toBe(true);
  });

  it("leaves ordinary attributes alone", () => {
    for (const name of ["class", "id", "title", "alt", "colspan", "data-uuid"]) {
      expect(isDangerousAttr(name, "x"), name).toBe(false);
    }
  });
});

describe("sanitise", () => {
  it("removes script elements and their content", () => {
    const out = clean("<p>hi</p><script>alert(1)</script>");
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("alert");
  });

  it("removes an event handler but keeps the element", () => {
    const out = clean('<img src="a.png" onerror="alert(1)" alt="map">');
    expect(out).toContain("a.png");
    expect(out).toContain('alt="map"');
    expect(out).not.toContain("onerror");
  });

  it("survives the mangled-markup trick that defeats regex sanitisers", () => {
    const out = clean("<scr<script>ipt>alert(1)</script>");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("</script>");
  });

  it("strips a javascript href while keeping the link text", () => {
    const out = clean('<a href="javascript:alert(1)">click</a>');
    expect(out).toContain("click");
    expect(out).not.toContain("javascript:");
  });

  it("removes an iframe even when nested deep in content", () => {
    expect(clean('<div><p><iframe src="https://evil"></iframe></p></div>')).not.toContain("iframe");
  });

  it("removes a page-supplied style element, which would otherwise restyle Foundry", () => {
    expect(clean("<style>body{display:none}</style><p>x</p>")).not.toContain("display:none");
  });

  it("keeps legitimate journal markup intact", () => {
    const html =
      "<h2>Terms</h2><p><strong>Signed</strong> by the <em>Duke</em>.</p>" +
      '<img src="worlds/keep/seal.webp" alt="seal"><a href="https://example.com">source</a>';
    const out = clean(html);
    expect(out).toContain("<h2>Terms</h2>");
    expect(out).toContain("<strong>Signed</strong>");
    expect(out).toContain('src="worlds/keep/seal.webp"');
    expect(out).toContain('href="https://example.com"');
  });

  it("removes secret sections for a non-owner", () => {
    const html = '<p>public</p><section class="secret"><p>the killer is the butler</p></section>';
    const out = clean(html);
    expect(out).toContain("public");
    expect(out).not.toContain("butler");
  });

  it("removes a secret marked with the bare class too", () => {
    expect(clean('<div class="secret">hidden</div>')).not.toContain("hidden");
  });

  /**
   * Core's Reveal button writes `class="secret revealed"`, and core's own enrichment keeps
   * that section for every viewer (`section.secret:not(.revealed)`). Stripping every
   * `.secret` took the paragraph the GM had just revealed off the players' cards while
   * their journal sheet showed it.
   */
  it("keeps a secret the GM revealed for a non-owner, and still removes one not revealed", () => {
    const html =
      '<section class="secret revealed"><p>the map is in the well</p></section>' +
      '<section class="secret"><p>the killer is the butler</p></section>';
    const out = clean(html);
    expect(out).toContain("the map is in the well");
    expect(out).not.toContain("butler");
  });

  it("does the same with the bare class, revealed and not", () => {
    const out = clean('<div class="secret revealed">shown</div><div class="secret">hidden</div>');
    expect(out).toContain("shown");
    expect(out).not.toContain("hidden");
  });

  it("keeps secrets for an owner, which is what the GM's own prop shows", () => {
    expect(asOwner('<section class="secret">notes</section>')).toContain("notes");
  });

  it("still scrubs scripts for an owner — ownership gates secrets, not execution", () => {
    expect(asOwner("<script>alert(1)</script><p>x</p>")).not.toContain("alert");
  });

  it("removes an element whose name only a malformed parse could produce", () => {
    // The mXSS shape: the tag NAME itself contains "<script", so a name-based
    // deny-list misses it and the string re-parses into a live script later.
    const out = clean("<scr<script>ipt>alert(1)</script>");
    expect(out.toLowerCase()).not.toContain("script");
  });

  it("keeps genuine custom elements, which enriched Foundry content uses", () => {
    const out = clean('<document-embed data-uuid="JournalEntry.a">x</document-embed>');
    expect(out).toContain("document-embed");
  });

  it("settles rather than looping on markup that mutates when re-parsed", () => {
    const nasty = '<p><table><div><svg><style><a title="</style><img src=x onerror=alert(1)>">';
    const out = clean(nasty);
    expect(out).not.toContain("onerror");
  });

  it("returns an empty string rather than throwing on empty or junk input", () => {
    expect(clean("")).toBe("");
    expect(clean("not html at all")).toBe("not html at all");
  });
});

/**
 * Core does not catch an enricher that throws, so one broken `@Tag` from another module
 * rejected the whole card: a blank prop on the map, and a reader click that did nothing.
 * The fallback is the raw text — through the SAME sanitiser, so a player still never
 * receives a secret or a script because enrichment failed.
 */
describe("when enrichment throws", () => {
  const withEnricher = (enrichHTML: (...args: any[]) => Promise<string>) => {
    (globalThis as any).foundry = {
      applications: { ux: { TextEditor: { implementation: { enrichHTML } } } },
    };
  };
  afterEach(() => {
    delete (globalThis as any).foundry;
  });

  const text =
    '<p>The Duke is dead.</p><section class="secret"><p>I did it.</p></section>' +
    '<img src="x" onerror="alert(1)">';

  it("shows the text, scrubbed and without its secrets, to a player", async () => {
    withEnricher(async () => {
      throw new Error("a module's enricher broke");
    });
    const { html } = await enrichFor({ isOwner: false }, text);

    expect(html).toContain("The Duke is dead.");
    expect(html).not.toContain("I did it.");
    expect(html).not.toContain("onerror");
  });

  it("keeps the secret for the owner, as enriched output would", async () => {
    withEnricher(async () => {
      throw new Error("a module's enricher broke");
    });
    const { html } = await enrichFor({ isOwner: true }, text);
    expect(html).toContain("I did it.");
  });

  it("uses the enriched output when enrichment works", async () => {
    withEnricher(async (input: string) => input.replace("dead", "<em>dead</em>"));
    const { html } = await enrichFor({ isOwner: false }, text);
    expect(html).toContain("<em>dead</em>");
  });
});
