/**
 * @vitest-environment jsdom
 *
 * The card cache (DESIGN A29): what a card is made of, kept between resolves.
 *
 * The DOM tier's key carries the LOD rung and the effects level, because the dressing
 * depends on both — and every rung crossed, every focus, every trip off screen and every
 * level flip re-ran the whole of `resolveCard`: `enrichHTML`, the sanitiser's parse and
 * re-parse, and a forced layout in the measuring probe. These tests hold the cache to two
 * promises at once: it changes what a card COSTS, and never what it SAYS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeJournal, installSources, installWorld, uninstallWorld } from "./helpers/fake-foundry";
import type { DpPinFlags } from "../src/types/dp";
import type { LodTier } from "../src/canvas/lod";

const PAGE = "JournalEntry.letters.JournalEntryPage.note";
const DEED = "JournalEntry.letters.JournalEntryPage.deed";
const SIZE = { width: 400, height: 560 };
const TIERS: LodTier[] = ["L1", "L2a", "L2b", "L3"];

let world: ReturnType<typeof installWorld>;
let enrichHTML: ReturnType<typeof vi.fn>;
let measured: ReturnType<typeof vi.fn>;
let letters: any;

/** A world with one journal: a text page with a secret, and a PDF page. */
function boot(options: { isOwner?: boolean; height?: number } = {}) {
  world = installWorld({ isGM: false, settings: { effectsLevel: "full" } });
  letters = fakeJournal({
    id: "letters",
    name: "Letters",
    pages: [
      { id: "note", name: "Note" },
      { id: "deed", name: "Deed", type: "pdf" },
    ],
  });
  Object.assign(letters.pages.get("note"), {
    text: {
      content:
        '<p>Meet at dawn.</p><section class="secret"><p>Bring the knife.</p></section>' +
        '<section class="secret revealed"><p>The door is open.</p></section>',
    },
    isOwner: options.isOwner ?? false,
  });
  Object.assign(letters.pages.get("deed"), { src: "deed.pdf" });
  installSources(world, { journals: [letters] });

  enrichHTML = vi.fn(async (text: string) => text.replace("dawn", "<em>dawn</em>"));
  (globalThis as any).foundry.applications.ux.TextEditor = { implementation: { enrichHTML } };

  measured = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ height: options.height ?? 640 } as DOMRect) as any;
}

const pinOn = (uuid: string, over: Partial<DpPinFlags["display"]> = {}): DpPinFlags => ({
  ...defaultPin(),
  mode: "prop",
  source: { ...defaultPin().source, uuid },
  display: { ...defaultPin().display, typeSize: 14, margin: 1.5, label: "The letter", ...over },
});

async function resolve(
  pin: DpPinFlags,
  tier: LodTier = "L2b",
  size: { width: number; height: number } = SIZE
) {
  const { resolveCard } = await import("../src/render/ContentResolver");
  return resolveCard(pin, size, { tier, baked: false });
}

async function cache() {
  return import("../src/render/card-cache");
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as any).fonts;
  uninstallWorld();
});

describe("one enrichment, every rung", () => {
  it("enriches and measures a card once across L1, L2a, L2b and L3, while its dressing follows the rung", async () => {
    boot();
    const cards: Awaited<ReturnType<typeof resolve>>[] = [];
    for (const tier of TIERS) cards.push(await resolve(pinOn(PAGE), tier));

    expect(enrichHTML).toHaveBeenCalledTimes(1);
    expect(measured).toHaveBeenCalledTimes(1);
    for (const [index, tier] of TIERS.entries()) {
      expect(cards[index].html).toContain(`data-dp-tier="${tier}"`);
      expect(cards[index].html).toContain("<em>dawn</em>");
    }
  });

  it("shares one enrichment between two resolves of the same card in flight", async () => {
    boot();
    await Promise.all([resolve(pinOn(PAGE), "L2b"), resolve(pinOn(PAGE), "L3")]);
    expect(enrichHTML).toHaveBeenCalledTimes(1);
  });

  it("keeps the revealed secret and strips the other for a player, from the cache too", async () => {
    boot();
    for (const tier of ["L2b", "L3"] as const) {
      const card = await resolve(pinOn(PAGE), tier);
      expect(card.html).toContain("The door is open.");
      expect(card.html).not.toContain("Bring the knife.");
    }
  });
});

describe("forgetting a source", () => {
  it("matches a document, its parts and its parent — never a neighbour whose id starts the same", async () => {
    const { concerns } = await cache();
    expect(concerns("JournalEntry.a", "JournalEntry.a")).toBe(true);
    expect(concerns("JournalEntry.a.JournalEntryPage.p", "JournalEntry.a")).toBe(true);
    expect(concerns("JournalEntry.a", "JournalEntry.a.JournalEntryPage.p")).toBe(true);
    expect(concerns("JournalEntry.ab", "JournalEntry.a")).toBe(false);
    expect(concerns("JournalEntry.a", "JournalEntry.ab")).toBe(false);
    expect(concerns("JournalEntry.ab.JournalEntryPage.p", "JournalEntry.a")).toBe(false);
  });

  it("re-enriches the forgotten card and leaves a neighbour named like it alone", async () => {
    boot();
    const a = fakeJournal({ id: "a", name: "A", pages: [{ id: "p", name: "P" }] });
    const ab = fakeJournal({ id: "ab", name: "AB", pages: [{ id: "p", name: "P" }] });
    a.pages.get("p").text = { content: "<p>a</p>" };
    ab.pages.get("p").text = { content: "<p>ab</p>" };
    world.game.journal.set("a", a);
    world.game.journal.set("ab", ab);
    const { forgetSource } = await cache();

    await resolve(pinOn("JournalEntry.a"));
    await resolve(pinOn("JournalEntry.ab"));
    expect(enrichHTML).toHaveBeenCalledTimes(2);

    forgetSource("JournalEntry.a");
    await resolve(pinOn("JournalEntry.a"));
    await resolve(pinOn("JournalEntry.ab"));
    expect(enrichHTML).toHaveBeenCalledTimes(3);
    expect(enrichHTML.mock.calls[2][0]).toBe("<p>a</p>");
  });

  it("forgets a whole journal's card when one of its pages is edited, and a page's when its journal is", async () => {
    boot();
    const { forgetSource } = await cache();
    // The whole journal shows its first page — the same text, but its own body, keyed by
    // the journal: the owner of a page and of its journal can differ.
    await resolve(pinOn("JournalEntry.letters"));
    await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(2);

    forgetSource(PAGE);
    await resolve(pinOn("JournalEntry.letters"));
    await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(4);

    forgetSource("JournalEntry.letters");
    await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(5);
  });

  it("does not keep what a resolve in flight read before the edit", async () => {
    boot();
    const { forgetSource } = await cache();
    let finish = (_html: string) => {};
    enrichHTML.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = (html) => resolve(html)))
    );

    const before = resolve(pinOn(PAGE));
    await vi.waitFor(() => expect(enrichHTML).toHaveBeenCalledTimes(1));
    letters.pages.get("note").text.content = "<p>Meet at dusk.</p>";
    forgetSource(PAGE);
    finish("<p>Meet at dawn.</p>");
    expect((await before).html).toContain("dawn");

    const after = await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(2);
    expect(after.html).toContain("dusk");
  });

  it("misses on changed text even when no hook said so", async () => {
    boot();
    await resolve(pinOn(PAGE));
    letters.pages.get("note").text.content = "<p>Meet at noon.</p>";
    const card = await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(2);
    expect(card.html).toContain("noon");
  });

  it("clearResolved forgets everything", async () => {
    boot();
    const { clearResolved, cardCacheStats } = await cache();
    await resolve(pinOn(PAGE));
    expect(cardCacheStats().bodies).toBe(1);
    clearResolved();
    expect(cardCacheStats()).toEqual({ bodies: 0, bodyBytes: 0, heights: 0 });
    await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(2);
  });
});

describe("what is never kept", () => {
  it("keeps no placeholder for a source that is gone", async () => {
    boot();
    const { cardCacheStats } = await cache();
    const card = await resolve(pinOn("JournalEntry.gone"));
    expect(card.missing).toBe(true);
    expect(cardCacheStats()).toEqual({ bodies: 0, bodyBytes: 0, heights: 0 });
  });

  it("keeps no raw text from an enrichment that threw, so the next resolve enriches", async () => {
    boot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    enrichHTML.mockRejectedValueOnce(new Error("a module's enricher broke"));

    const raw = await resolve(pinOn(PAGE));
    expect(raw.html).toContain("Meet at dawn.");
    expect(raw.html).not.toContain("Bring the knife.");

    const enriched = await resolve(pinOn(PAGE), "L3");
    expect(enrichHTML).toHaveBeenCalledTimes(2);
    expect(enriched.html).toContain("<em>dawn</em>");
  });

  it("keeps no rejection: a resolve that threw is tried again", async () => {
    boot();
    const { cachedBody } = await cache();
    const failing = vi.fn(async () => {
      throw new Error("no");
    });
    await expect(cachedBody("k", "JournalEntry.x", failing)).rejects.toThrow("no");
    await expect(cachedBody("k", "JournalEntry.x", failing)).rejects.toThrow("no");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("re-enriches when this user's ownership of the page changes, which decides its secrets", async () => {
    boot();
    const player = await resolve(pinOn(PAGE));
    expect(player.html).not.toContain("Bring the knife.");

    letters.pages.get("note").isOwner = true;
    const owner = await resolve(pinOn(PAGE));
    expect(enrichHTML).toHaveBeenCalledTimes(2);
    expect(owner.html).toContain("Bring the knife.");
    expect(owner.contentHash).not.toBe(player.contentHash);
  });
});

describe("a PDF page", () => {
  let toDataURL: ReturnType<typeof vi.fn>;
  let edges: number[];

  async function pdf() {
    boot();
    edges = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    toDataURL = vi.fn(() => "data:image/png;base64,AAAA");
    HTMLCanvasElement.prototype.toDataURL = toDataURL as never;
    (globalThis as any).foundry.utils.getRoute = (p: string) => `/${p}`;
    const { setPdfLibrary } = await import("../src/render/PdfPage");
    setPdfLibrary({
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => {
              if (scale !== 1) edges.push(Math.round(850 * scale));
              return { width: 600 * scale, height: 850 * scale };
            },
            render: () => ({ promise: Promise.resolve() }),
          }),
        }),
      }),
    });
  }

  it("encodes the page once per edge, not once per resolve, at 1x on the silhouette rung", async () => {
    await pdf();
    for (const tier of TIERS) await resolve(pinOn(DEED), tier);

    // L1 and L2a share the 1x edge (560 -> 1024); L2b and L3 the 2x one (1120 -> 2048).
    expect(edges).toEqual([1024, 2048]);
    expect(toDataURL).toHaveBeenCalledTimes(2);
  });

  it("snaps the edge up to a power of two, so a resize inside it draws nothing new", async () => {
    await pdf();
    await resolve(pinOn(DEED), "L2b", { width: 400, height: 560 });
    await resolve(pinOn(DEED), "L2b", { width: 430, height: 600 });
    expect(edges).toEqual([2048]);
    expect(toDataURL).toHaveBeenCalledTimes(1);
  });
});

describe("the byte budget", () => {
  const body = (html: string) => ({
    html,
    figureHtml: "",
    kind: "text",
    isOwner: false,
    contentHash: "h",
  });

  it("evicts the oldest body once the bytes are over, however few the entries", async () => {
    const { BODY_BUDGET, cachedBody, cardCacheStats } = await cache();
    const big = vi.fn(async () => ({
      value: body("x"),
      keep: true,
      bytes: Math.ceil(BODY_BUDGET * 0.6),
    }));

    await cachedBody("first", "JournalEntry.a", big);
    await cachedBody("second", "JournalEntry.b", big);
    expect(cardCacheStats().bodies).toBe(1);

    await cachedBody("second", "JournalEntry.b", big);
    expect(big).toHaveBeenCalledTimes(2);
    await cachedBody("first", "JournalEntry.a", big);
    expect(big).toHaveBeenCalledTimes(3);
  });

  it("does not keep one body larger than the whole budget", async () => {
    const { BODY_BUDGET, cachedBody, cardCacheStats } = await cache();
    await cachedBody("huge", "JournalEntry.a", async () => ({
      value: body("x"),
      keep: true,
      bytes: BODY_BUDGET + 1,
    }));
    expect(cardCacheStats().bodies).toBe(0);
  });
});

describe("measurements", () => {
  it("measures once per width, type and face — and never for a rung or a taller box", async () => {
    boot();
    await resolve(pinOn(PAGE), "L2b");
    await resolve(pinOn(PAGE), "L3");
    await resolve(pinOn(PAGE), "L2a", { width: 400, height: 900 });
    expect(measured).toHaveBeenCalledTimes(1);

    await resolve(pinOn(PAGE), "L2b", { width: 500, height: 560 });
    expect(measured).toHaveBeenCalledTimes(2);

    await resolve(pinOn(PAGE, { typeSize: 18 }));
    expect(measured).toHaveBeenCalledTimes(3);

    await resolve(pinOn(PAGE, { font: "Courier" }));
    expect(measured).toHaveBeenCalledTimes(4);
  });

  it("keeps no measurement that gave up on its face", async () => {
    boot();
    vi.useFakeTimers();
    (document as any).fonts = { load: () => new Promise(() => {}), ready: Promise.resolve() };
    const { MEASURE_DEADLINE_MS } = await import("../src/render/measure");

    const first = resolve(pinOn(PAGE));
    await vi.advanceTimersByTimeAsync(MEASURE_DEADLINE_MS);
    expect((await first).naturalHeight).toBe(640);

    (document as any).fonts = { load: async () => [], ready: Promise.resolve() };
    await resolve(pinOn(PAGE), "L3");
    expect(measured).toHaveBeenCalledTimes(2);
    await resolve(pinOn(PAGE), "L2a");
    expect(measured).toHaveBeenCalledTimes(2);
  });
});

/**
 * The promise the whole cache rests on: it changes what a card costs, never what it says.
 * Every rung at every level, built once from nothing and once on top of a body and a
 * measurement another rung left behind, must be the same card byte for byte.
 */
describe("a card from the cache is the card a fresh resolve draws", () => {
  const cases = [
    ["a page, its title shown", pinOn(PAGE)],
    ["a whole journal, no title", pinOn("JournalEntry.letters", { showTitle: false })],
  ] as const;

  it.each(cases)("%s", async (_what, pin) => {
    // Taller than the box, so the overflow mark is part of what must agree.
    boot({ height: 900 });
    const { clearResolved } = await cache();

    for (const level of ["full", "reduced", "off"]) {
      world.game.settings.set("", "effectsLevel", level);
      for (const tier of TIERS) {
        clearResolved();
        const fresh = await resolve(pin, tier);

        clearResolved();
        const other = TIERS.find((t) => t !== tier)!;
        await resolve(pin, other);
        const enriched = enrichHTML.mock.calls.length;
        const cached = await resolve(pin, tier);

        expect(enrichHTML.mock.calls.length, `${level} ${tier}`).toBe(enriched);
        expect(cached, `${level} ${tier}`).toEqual(fresh);
        expect(cached.html).toContain(`data-dp-level="${level}"`);
      }
    }
  });
});
