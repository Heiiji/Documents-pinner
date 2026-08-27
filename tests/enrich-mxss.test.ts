/**
 * @vitest-environment jsdom
 *
 * The sanitiser tested against the parser the BROWSER will use, not the one the
 * sanitiser used.
 *
 * `DOMParser` parses with scripting DISABLED. `innerHTML` on a live page — which is how
 * `ReaderOverlay` inserts this markup — parses with scripting ENABLED, and in that mode
 * `<noscript>` content is raw text, so a `</noscript>` inside an attribute value closes
 * the element early and everything after it becomes live markup.
 *
 * Amendment A6's round-trip cannot catch this by construction: it reaches a fixpoint of
 * the WRONG parser on the first pass and then agrees with itself forever. So these tests
 * re-parse the sanitised output with `scriptingEnabled: true` and assert on the tree the
 * browser would actually build.
 *
 * A6's other half — the tag-name fix — is genuinely sound, and is asserted here too so a
 * future edit cannot quietly undo it.
 */
import { describe, expect, it } from "vitest";
import * as parse5 from "parse5";
import { sanitise } from "../src/render/enrich";

interface Node {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
}

/** Every element the browser's own parser builds from this string, template content too. */
function elementsAsBrowserSees(html: string): Node[] {
  const fragment = parse5.parseFragment(html, { scriptingEnabled: true }) as unknown as Node;
  const out: Node[] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName) out.push(child);
      walk(child);
      if (child.content) walk(child.content);
    }
  };
  walk(fragment);
  return out;
}

const tagsIn = (html: string) => elementsAsBrowserSees(html).map((e) => e.tagName);

const attrsIn = (html: string) =>
  elementsAsBrowserSees(html).flatMap((e) => (e.attrs ?? []).map((a) => a.name));

const classesIn = (html: string) =>
  elementsAsBrowserSees(html).flatMap((e) =>
    (e.attrs ?? []).filter((a) => a.name === "class").map((a) => a.value)
  );

// The two payloads verified against parse5 before the fix. With scripting enabled the
// first resurrects a live event handler and the second resurrects a GM-only section.
const LIVE_HANDLER = `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>`;
const RESURRECTED_SECRET = `<noscript><p title="</noscript><section class=secret>GM ONLY</section>"></p></noscript>`;

describe("mutation XSS through <noscript>", () => {
  it("produces no event handler in the tree the browser builds", () => {
    const clean = sanitise(LIVE_HANDLER, false);
    expect(attrsIn(clean).filter((name) => name.startsWith("on"))).toEqual([]);
  });

  it("leaves no <noscript> for the browser to parse differently", () => {
    expect(tagsIn(sanitise(LIVE_HANDLER, false))).not.toContain("noscript");
    expect(tagsIn(sanitise(RESURRECTED_SECRET, false))).not.toContain("noscript");
  });

  it("cannot resurrect a GM-only section a player must never see", () => {
    const clean = sanitise(RESURRECTED_SECRET, false);
    expect(classesIn(clean)).not.toContain("secret");
    expect(clean).not.toContain("GM ONLY");
  });

  it("removes <noscript> even for an owner, who is not the threat but is the vector", () => {
    // The attacker is whoever can edit the page; the GM is who opens it.
    expect(tagsIn(sanitise(LIVE_HANDLER, true))).not.toContain("noscript");
  });
});

describe("<template> content", () => {
  it("does not carry a script past the scrub", () => {
    // `scrub` walks `querySelectorAll("*")`, which does not cross into a template's
    // DocumentFragment — so this survived byte-for-byte. Inert in the HTML reader, but
    // the same string is concatenated into an XML document where <template> means
    // nothing at all.
    const clean = sanitise("<template><script>alert(1)</script></template>", true);
    expect(tagsIn(clean)).not.toContain("script");
    expect(clean).not.toContain("alert(1)");
  });

  it("strips an event handler nested inside a template", () => {
    const clean = sanitise('<template><div onclick="x()">hi</div></template>', true);
    expect(attrsIn(clean).filter((name) => name.startsWith("on"))).toEqual([]);
  });

  it("strips a secret section nested inside a template", () => {
    const clean = sanitise('<template><section class="secret">no</section></template>', false);
    expect(clean).not.toContain("no");
  });
});

describe("A6's tag-name fix, which is sound and must stay so", () => {
  it("removes an element whose tag name a well-formed parse could not produce", () => {
    expect(sanitise("<scr<script>ipt>alert(1)</script>", true)).not.toContain("script");
  });
});

describe("failing closed", () => {
  it("returns nothing at all rather than markup that never settled", () => {
    // `sanitise` bounded its round-trip at three passes and then RETURNED the result —
    // markup that is by definition not at a fixpoint, which is exactly the shape mutation
    // XSS takes. Anything that will not converge is dropped instead.
    //
    // Proven through the contract rather than through a crafted payload: whatever comes
    // back must survive a re-sanitise unchanged.
    for (const payload of [LIVE_HANDLER, RESURRECTED_SECRET, "<p>a<br>b</p>", "<div><em>x"]) {
      const once = sanitise(payload, false);
      expect(sanitise(once, false), payload).toBe(once);
    }
  });
});

describe("data: URLs", () => {
  it("accepts the comma form, which is what a generated SVG texture actually looks like", async () => {
    const { isDangerousUrl } = await import("../src/render/enrich");
    expect(isDangerousUrl("data:image/png,AAAA")).toBe(false);
    expect(isDangerousUrl("data:image/svg+xml,%3Csvg%20/%3E")).toBe(false);
  });

  it("still accepts the base64 form", async () => {
    const { isDangerousUrl } = await import("../src/render/enrich");
    expect(isDangerousUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
  });

  it("still rejects a data URL that is not an image, in both forms", async () => {
    const { isDangerousUrl } = await import("../src/render/enrich");
    expect(isDangerousUrl("data:text/html,<script>alert(1)</script>")).toBe(true);
    expect(isDangerousUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(true);
    expect(isDangerousUrl("data:application/javascript,alert(1)")).toBe(true);
  });

  it("rejects a media type that merely starts like an image one", () => {
    // `data:image/pngx` and `data:image/png-evil` must not slip through on a prefix match.
    return import("../src/render/enrich").then(({ isDangerousUrl }) => {
      expect(isDangerousUrl("data:image/pngevil,AAAA")).toBe(true);
    });
  });
});
