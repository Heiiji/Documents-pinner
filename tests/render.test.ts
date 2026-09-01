import { afterEach, describe, expect, it } from "vitest";
import { cardHtml, paperOf, svgDocument } from "../src/render/CardTemplate";
import { textureBytes, textureFromCanvas, tierFor } from "../src/render/Rasterizer";
import { TextureCache, cacheKey, hashContent, plan } from "../src/render/TextureCache";

const card = (over: Record<string, any> = {}) =>
  cardHtml({
    title: "The Duke's Letter",
    bodyHtml: "<p>Signed.</p>",
    showTitle: true,
    paper: "parchment",
    fontPx: 15.38,
    padPx: 24,
    effectId: "aged-parchment",
    ...over,
  });

describe("paperOf", () => {
  it("returns the named stock", () => {
    expect(paperOf("slate").base).toBe("#2a2d33");
  });

  it("falls back to parchment for an unknown stock", () => {
    expect(paperOf("holographic-unobtanium")).toEqual(paperOf("parchment"));
  });
});

describe("cardHtml", () => {
  it("escapes the title, which comes from a document name", () => {
    expect(card({ title: '<img onerror="x">' })).not.toContain("<img onerror");
  });

  it("inserts the body HTML verbatim — it is already enriched and scrubbed", () => {
    expect(card({ bodyHtml: "<p><strong>bold</strong></p>" })).toContain("<strong>bold</strong>");
  });

  it("omits the title element entirely when the pin hides it", () => {
    expect(card({ showTitle: false })).not.toContain("dp-card__title");
  });

  it("sets the card's own paper variables, not Foundry's theme variables", () => {
    const html = card({ paper: "slate" });
    expect(html).toContain("--dp-paper-base:#2a2d33");
    expect(html).not.toContain("--color-");
  });

  it("writes the type size and the pad it was given, in card pixels", () => {
    const html = card({ fontPx: 12, padPx: 18 });
    expect(html).toContain("font-size:12px");
    expect(html).toContain("--dp-card-pad:18px");
  });

  // A prop is a window onto its document. The box it fills decides the size; a card
  // that carried its own width would have to be re-resolved on every resize, which is
  // exactly the defect the DOM tier had.
  it("does not bake the card's width or height into its style — the box it fills decides", () => {
    const html = card();
    expect(html).not.toMatch(/[^-]width:\d/);
    expect(html).not.toMatch(/[^-]height:\d/);
  });

  it("marks a missing source rather than drawing a blank sheet", () => {
    const html = card({ missing: true, title: "gone" });
    expect(html).toContain('data-dp-missing="true"');
    expect(html).toContain("dp-card__missing");
  });

  it("carries the effect id so the CSS renditions can key off it", () => {
    expect(card({ effectId: "glitch" })).toContain('data-dp-fx="glitch"');
  });
});

describe("svgDocument", () => {
  it("sets an explicit size on BOTH the svg and the foreignObject", () => {
    const svg = svgDocument("<div></div>", "", 400, 560);
    expect(svg).toMatch(/<svg[^>]*width="400"[^>]*height="560"/);
    expect(svg).toMatch(/<foreignObject[^>]*width="400"[^>]*height="560"/);
  });

  // The card is `100%` of its box, and a percentage height needs a definite containing
  // block. Inside a foreignObject the root div has none unless it is given one, and a
  // card with no definite height collapses to a transparent texture — silently.
  it("sizes the root div, so a card at 100% has a definite box to fill", () => {
    const svg = svgDocument("<div></div>", "", 400, 560);
    expect(svg).toMatch(/<div[^>]*dp-card-root[^>]*style="width:400px;height:560px"/);
  });

  it("declares the XHTML namespace, without which the div draws nothing", () => {
    expect(svgDocument("<div></div>", "", 10, 10)).toContain(
      'xmlns="http://www.w3.org/1999/xhtml"'
    );
  });

  it("inlines the stylesheet rather than linking it", () => {
    const svg = svgDocument("", ".dp-card{color:red}", 10, 10);
    expect(svg).toContain(".dp-card{color:red}");
    expect(svg).not.toContain("<link");
  });

  // XML gives <style> no implicit CDATA, so a bare `&` — every line of native CSS
  // nesting in card.css — would otherwise make the whole document ill-formed.
  it("wraps the stylesheet in CDATA", () => {
    expect(svgDocument("", "a &b", 10, 10)).toContain("<style><![CDATA[a &b]]></style>");
  });

  it("splits a literal ]]> so a stylesheet cannot end its own CDATA section", () => {
    const svg = svgDocument("", `.x{content:"]]>"}`, 10, 10);
    expect(svg).not.toContain(`"]]>"}`);
    expect(svg).toContain("]]]]><![CDATA[>");
  });
});

describe("tierFor", () => {
  it("snaps up to a power-of-two tier so a slow zoom cannot thrash", () => {
    expect(tierFor(1)).toBe(256);
    expect(tierFor(256)).toBe(256);
    expect(tierFor(257)).toBe(512);
    expect(tierFor(1500)).toBe(2048);
  });

  it("caps at the top tier rather than growing without bound", () => {
    expect(tierFor(100000)).toBe(2048);
  });
});

describe("textureBytes", () => {
  it("accounts for RGBA plus the mip chain on the GPU", () => {
    // 2048² RGBA8 is 16 MB before mips, ~21 MB with them.
    const gpuOnly = 2048 * 2048 * 4 * 1.34;
    expect(textureBytes(2048, 2048)).toBeGreaterThan(gpuOnly);
  });

  it("also counts the canvas backing store the base texture keeps alive", () => {
    // `PIXI.Texture.from(canvas)` retains the OffscreenCanvas as its resource, so every
    // prop costs its pixels twice — once in VRAM and once in system memory. Counting one
    // side made a 2048² prop look like ~22 MB against a true ~38 MB, and at the 256 MB
    // default the real footprint was approaching half a gigabyte.
    const pixels = 2048 * 2048;
    expect(textureBytes(2048, 2048)).toBeCloseTo(pixels * 4 * 1.34 + pixels * 4, -3);
    expect(textureBytes(2048, 2048)).toBeGreaterThan(36 * 1024 * 1024);
    expect(textureBytes(2048, 2048)).toBeLessThan(40 * 1024 * 1024);
  });

  it("scales with area", () => {
    // Rounded to whole bytes, so compare within one.
    expect(textureBytes(1024, 1024) * 4).toBeCloseTo(textureBytes(2048, 2048), -1);
  });
});

describe("cacheKey", () => {
  const base = {
    uuid: "JournalEntry.a",
    userId: "u1",
    resTier: 1024,
    presetBake: "aged",
    docHash: "abc",
  };

  it("separates two users, so a GM's texture can never reach a player", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, userId: "u2" }));
  });

  it("separates resolution tiers, presets and content", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, resTier: 512 }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, presetBake: "torn" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, docHash: "def" }));
  });

  it("is stable for identical inputs", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });

  it("starts with the uuid, which is what invalidation matches on", () => {
    expect(cacheKey(base).startsWith("JournalEntry.a|")).toBe(true);
  });
});

describe("hashContent", () => {
  it("changes when the content changes", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("is stable and short", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("x".repeat(10000)).length).toBeLessThan(12);
  });
});

describe("plan", () => {
  const entry = (key: string, bytes: number, lastSeen: number) => ({ key, bytes, lastSeen });

  it("evicts nothing while inside the budget", () => {
    expect(plan([entry("a", 10, 1)], 100)).toEqual([]);
  });

  it("evicts least-recently-SEEN first, not least-recently-created", () => {
    const entries = [entry("new", 60, 5), entry("stale", 60, 1)];
    expect(plan(entries, 100)).toEqual(["stale"]);
  });

  it("stops as soon as it is back inside the budget", () => {
    const entries = [entry("a", 40, 1), entry("b", 40, 2), entry("c", 40, 3)];
    expect(plan(entries, 80)).toEqual(["a"]);
  });

  it("never evicts a protected key, even when it is the oldest", () => {
    const entries = [entry("focused", 60, 1), entry("other", 60, 9)];
    expect(plan(entries, 50, ["focused"])).toEqual(["other"]);
  });
});

describe("TextureCache", () => {
  const fake = () => ({ destroy() {} });

  it("tracks bytes as entries come and go", () => {
    const cache = new TextureCache();
    cache.set("a", fake(), 100);
    cache.set("b", fake(), 50);
    expect(cache.bytes).toBe(150);
    cache.delete("a");
    expect(cache.bytes).toBe(50);
  });

  it("does not double-count a key that is set twice", () => {
    const cache = new TextureCache();
    cache.set("a", fake(), 100);
    cache.set("a", fake(), 30);
    expect(cache.bytes).toBe(30);
    expect(cache.size).toBe(1);
  });

  it("destroys the base texture on eviction, which is what frees the GPU memory", () => {
    let destroyedWith: unknown = null;
    const cache = new TextureCache();
    cache.set("a", { destroy: (v: boolean) => (destroyedWith = v) }, 10);
    cache.delete("a");
    expect(destroyedWith).toBe(true);
  });

  it("reading marks an entry as seen, so a read cannot forget to touch it", () => {
    const cache = new TextureCache();
    cache.set("old", fake(), 60);
    cache.set("new", fake(), 60);
    cache.get("old");
    expect(cache.trim(100)).toEqual(["new"]);
  });

  it("invalidates every tier and user of one document at once", () => {
    const cache = new TextureCache();
    cache.set("JournalEntry.a|u1|512|x|h", fake(), 10);
    cache.set("JournalEntry.a|u2|1024|x|h", fake(), 10);
    cache.set("JournalEntry.b|u1|512|x|h", fake(), 10);
    expect(cache.invalidate("JournalEntry.a")).toBe(2);
    expect(cache.size).toBe(1);
  });

  it("clears everything, leaving no bytes behind", () => {
    const cache = new TextureCache();
    cache.set("a", fake(), 10);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

/**
 * The regression that broke a live game, and the rule that prevents it recurring.
 *
 * `PIXI.Texture.from(canvas)` does NOT upload — the upload happens during the next render.
 * So a tainted source throws `SecurityError` from inside PIXI's own render loop, where
 * nothing can catch it, and a renderer that throws mid-frame stops drawing entirely: the
 * scene collapsed to its clear colour, reported as "completely broken, full red
 * background". The prop was never the casualty; the whole canvas was.
 *
 * Browsers disagree about what taints — Chromium keeps a canvas clean when a generated
 * `feTurbulence` SVG is drawn onto it, WebKit does not — so the canvas is asked rather
 * than a browser matrix being encoded.
 */
describe("textureFromCanvas and tainted sources", () => {
  const PIXI = {
    MIPMAP_MODES: { ON: 1 },
    SCALE_MODES: { LINEAR: 1 },
    Texture: { from: () => ({ baseTexture: {}, destroy: () => {} }) },
  };

  function withCanvas(getImageData: () => void, bind?: () => void) {
    (globalThis as any).PIXI = PIXI;
    (globalThis as any).canvas = {
      app: { renderer: { resolution: 1, texture: { bind: bind ?? (() => {}) } } },
    };
    return { getContext: () => ({ getImageData }) } as never;
  }

  afterEach(() => {
    delete (globalThis as any).PIXI;
    delete (globalThis as any).canvas;
  });

  it("refuses a tainted canvas outright", () => {
    const tainted = withCanvas(() => {
      throw new Error("SecurityError: tainted");
    });
    expect(textureFromCanvas(tainted, 100, 100)).toBeNull();
  });

  it("accepts a clean one", () => {
    const clean = withCanvas(() => undefined);
    expect(textureFromCanvas(clean, 100, 100)).not.toBeNull();
  });

  it("uploads inside its own catch, so a failure is ours and not the renderer's", () => {
    const clean = withCanvas(
      () => undefined,
      () => {
        throw new Error("SecurityError: Tainted canvases may not be loaded");
      }
    );
    // The throw must be swallowed here rather than surfacing during a later frame.
    expect(() => textureFromCanvas(clean, 100, 100)).not.toThrow();
    expect(textureFromCanvas(clean, 100, 100)).toBeNull();
  });

  it("treats a source with no 2d context as usable rather than refusing it", () => {
    (globalThis as any).PIXI = PIXI;
    (globalThis as any).canvas = {
      app: { renderer: { resolution: 1, texture: { bind: () => {} } } },
    };
    expect(textureFromCanvas({ getContext: () => null } as never, 10, 10)).not.toBeNull();
  });
});
