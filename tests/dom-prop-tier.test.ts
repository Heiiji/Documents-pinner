/**
 * @vitest-environment jsdom
 *
 * The DOM tier is what the `rendering: dom` setting and the WebKit fallback have been
 * pointing at all along. Before this existed, both paths rendered nothing whatsoever —
 * `OverlayRoot.mount` had two callers and neither of them was a prop — while the README,
 * the CHANGELOG and DESIGN A7 all said props still worked there.
 *
 * So the assertions are deliberately about the OBSERVABLE thing: is there a card in the
 * overlay, at the prop's scene coordinates, for exactly the props that deserve one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAudience } from "../src/data/audience";
import { defaultPin } from "../src/data/pin-schema";
import type { DpPinFlags } from "../src/types/dp";

// `resolveCard` reaches for `game` and enriches a real document; the tier's contract is
// that it mounts and positions a card, not what the card says.
vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => ({
    html: '<div class="dp-card">letter</div>',
    title: "Letter",
    readable: true,
    contentHash: "h",
    missing: false,
  })),
}));

vi.mock("../src/effects/level", () => ({ currentLevel: () => "full" }));

// The real write queue, spied on, so a test can count style writes per pass.
vi.mock("../src/apps/OverlayRoot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/apps/OverlayRoot")>();
  return { ...actual, write: vi.fn(actual.write) };
});

import {
  clearDomTier,
  domPropCount,
  followDomProp,
  previewIntensity,
  setDomPropControlled,
  setDomPropHover,
  syncDomTier,
} from "../src/canvas/DomPropTier";
import { resolveCard } from "../src/render/ContentResolver";
import { write } from "../src/apps/OverlayRoot";

const pin = (over: Partial<DpPinFlags> = {}): DpPinFlags => ({
  ...defaultPin(),
  mode: "prop",
  source: {
    kind: "document",
    uuid: "JournalEntry.a",
    src: null,
    pageId: null,
    pdfPage: null,
    followName: true,
  },
  audience: makeAudience({ kind: "everyone" }),
  ...over,
});

const doc = (over: Record<string, any> = {}) => ({
  id: "t1",
  x: 100,
  y: 240,
  width: 400,
  height: 560,
  rotation: 15,
  ...over,
});

const entry = (over: Record<string, any> = {}) => ({
  id: "t1",
  doc: doc(),
  pin: pin(),
  tier: "L2b" as const,
  focused: false,
  alpha: 1,
  pdf: false,
  revealing: false,
  reveal: { animation: "fade", durationMs: 300 },
  controlled: false,
  ...over,
});

/** A pin whose metrics are stored, so nothing about its card depends on the tile. */
const sized = (typeSize = 12) =>
  pin({ display: { ...defaultPin().display, typeSize, margin: 1.5 } });

/** The tier batches its style writes through OverlayRoot's single rAF. */
async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await Promise.resolve();
}

function overlay() {
  return document.getElementById("documents-pinner-overlay");
}

beforeEach(() => {
  document.body.innerHTML = '<div id="board"></div>';
  vi.mocked(resolveCard).mockClear();
  vi.mocked(write).mockClear();
});

afterEach(() => clearDomTier());

describe("syncDomTier", () => {
  it("mounts a card into the overlay for a visible prop", async () => {
    syncDomTier([entry()]);
    await settle();

    expect(domPropCount()).toBe(1);
    const card = overlay()?.querySelector<HTMLElement>(".dp-prop");
    expect(card).not.toBeNull();
    expect(card!.innerHTML).toContain("letter");
  });

  it("positions the card in SCENE space, around the document's point, so the overlay matrix does the rest", async () => {
    syncDomTier([entry()]);
    await settle();

    // (100,240) is the tile's CENTRE on v14; the card's corner is half a box before it.
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.style.left).toBe("-100px");
    expect(card.style.top).toBe("-40px");
    expect(card.style.width).toBe("400px");
    expect(card.style.height).toBe("560px");
    expect(card.style.transform).toBe("rotate(15deg)");
  });

  it("draws nothing for a culled prop", async () => {
    syncDomTier([entry({ tier: "L0" })]);
    await settle();
    expect(domPropCount()).toBe(0);
  });

  it("still draws a silhouette-sized prop, because the mesh under it is at alpha 0", async () => {
    syncDomTier([entry({ tier: "L1" })]);
    await settle();
    expect(domPropCount()).toBe(1);
  });

  it("keeps the focused card mounted but hidden under the reader", async () => {
    // Unmounting it meant closing the reader re-resolved the card and replayed its
    // arrival under a reader that had already gone.
    syncDomTier([entry({ focused: true })]);
    await settle();
    expect(domPropCount()).toBe(1);
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.dataset.dpFocused).toBe("true");

    syncDomTier([entry({ focused: false })]);
    await settle();
    expect(card.dataset.dpFocused).toBeUndefined();
    expect(resolveCard).toHaveBeenCalledTimes(1);
  });

  it("removes a card whose prop is gone from the scene", async () => {
    syncDomTier([entry(), entry({ id: "t2", doc: doc({ id: "t2" }) })]);
    await settle();
    expect(domPropCount()).toBe(2);

    syncDomTier([entry()]);
    await settle();
    expect(domPropCount()).toBe(1);
    expect(overlay()!.querySelectorAll(".dp-prop")).toHaveLength(1);
  });

  it("resolves a card once per content change, not once per LOD pass", async () => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry()]);
    syncDomTier([entry()]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(1);

    syncDomTier([entry({ pin: pin({ effect: { ...defaultPin().effect, id: "glitch" } }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("never lets a resolve from before a redraw land on the new card for the same tile", async () => {
    let land = () => {};
    vi.mocked(resolveCard).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              html: '<div class="dp-card">before the redraw</div>',
              title: "Letter",
              readable: true,
              contentHash: "old",
              missing: false,
              naturalHeight: null,
            });
        })
    );
    syncDomTier([entry()]);
    // The same scene drawn again — a v14 Level switch — while that resolve is in flight.
    clearDomTier();
    syncDomTier([entry()]);
    await settle();

    land();
    await settle();
    expect(overlay()!.querySelector(".dp-prop")!.innerHTML).toContain("letter");
  });

  it("re-positions without re-resolving when only the geometry moved", async () => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry({ doc: doc({ x: 900 }) })]);
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(1);
    expect(overlay()!.querySelector<HTMLElement>(".dp-prop")!.style.left).toBe("700px");
  });

  /**
   * The defect: `contentKeyOf` omitted geometry on the stated premise that a resized
   * prop is re-laid-out by CSS. The card carried its own width, height and font size
   * as inline pixels, so nothing re-laid it out — the `.dp-prop` box took the new size
   * and the old card sat inside it, clipped or short, until an LOD boundary happened
   * to be crossed. The card now fills its box, and this is what that buys.
   */
  it("re-lays-out the card when the prop is resized, without re-resolving", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    syncDomTier([entry({ pin: sized(), doc: doc({ height: 900 }) })]);
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(1);
    const box = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(box.style.height).toBe("900px");
  });

  it("re-resolves when the chosen page changes, or the setting does nothing at all", async () => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry({ pin: pin({ source: { ...pin().source, pageId: "aBcD1234eFgH5678" } }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the text an actor or an item shows changes", async () => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry({ pin: pin({ source: { ...pin().source, field: "details.notes" } }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the PDF page changes", async () => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry({ pin: pin({ source: { ...pin().source, pdfPage: 3 } }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the type size changes, because that is drawn into the card", async () => {
    syncDomTier([entry({ pin: sized(12) })]);
    await settle();
    syncDomTier([entry({ pin: sized(20) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  /**
   * The dressing is drawn from the effect's speed and motion, and neither was in the key:
   * a GM who stopped a preset's loop, or slowed it, saw the card go on as it was until a
   * rung happened to be crossed.
   */
  it.each([
    ["speed", { speed: 0.5 }],
    ["motion", { motion: "none" as const }],
  ])("re-resolves when the effect's %s changes", async (_what, change) => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry({ pin: pin({ effect: { ...defaultPin().effect, ...change } }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  /**
   * The natural height is measured at the card's width, so a narrower prop with the same
   * height kept the old measurement and its overflow mark said the wrong thing. A cached
   * body makes the re-resolve one measurement. Height alone still costs nothing.
   */
  it("re-resolves when a text prop's width changes, and not when only its height does", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    syncDomTier([entry({ pin: sized(), doc: doc({ height: 900 }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(1);

    syncDomTier([entry({ pin: sized(), doc: doc({ width: 300, height: 900 }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the pin's own typeface changes, and not before", async () => {
    const faced = (font: string | null) =>
      pin({ display: { ...defaultPin().display, typeSize: 12, margin: 1.5, font } });
    syncDomTier([entry({ pin: faced(null) })]);
    await settle();
    syncDomTier([entry({ pin: faced(null) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(1);

    syncDomTier([entry({ pin: faced("monospace") })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("still re-resolves a legacy prop when its short edge changes, since its type derives from the tile", async () => {
    // Default pin: typeSize and margin are null, so the metrics follow min(width, height).
    syncDomTier([entry()]);
    await settle();
    // Taller only: the short edge is still 400, the derived metrics are unchanged.
    syncDomTier([entry({ doc: doc({ height: 900 }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(1);
    // Wider: the short edge is now 560, and the type with it.
    syncDomTier([entry({ doc: doc({ width: 800, height: 900 }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("re-resolves a PDF prop on resize, because its page is drawn at a size", async () => {
    syncDomTier([entry({ pin: sized(), pdf: true })]);
    await settle();
    syncDomTier([entry({ pin: sized(), pdf: true, doc: doc({ height: 900 }) })]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });

  it("writes geometry once per change, not once per pass", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    const afterFirst = vi.mocked(write).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    syncDomTier([entry({ pin: sized() })]);
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    expect(vi.mocked(write).mock.calls.length).toBe(afterFirst);

    syncDomTier([entry({ pin: sized(), doc: doc({ x: 900 }) })]);
    await settle();
    expect(vi.mocked(write).mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("stays pointer-transparent so PropHitLayer keeps owning interaction", async () => {
    syncDomTier([entry()]);
    await settle();
    // The rule lives in prop.css; what the element must not do is opt itself in.
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.style.pointerEvents).toBe("");
    expect(card.getAttribute("aria-hidden")).toBe("true");
  });
});

/**
 * Once a prop is a window rather than a zoom, under-sizing one is routine, and content
 * that is cut off with no signal looks like a rendering fault. The resolver reports the
 * height at which everything fits; the tier compares it to the box.
 */
describe("the overflow mark", () => {
  const overflowing = () =>
    vi.mocked(resolveCard).mockResolvedValueOnce({
      html: '<div class="dp-card">letter</div>',
      title: "Letter",
      readable: true,
      contentHash: "h",
      missing: false,
      naturalHeight: 800,
    } as any);

  it("marks a card whose content does not fit", async () => {
    overflowing();
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop .dp-card")!;
    expect(card.dataset.dpOverflow).toBe("true");
  });

  it("clears the mark when the prop is made tall enough, without re-resolving", async () => {
    overflowing();
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    await settle();

    syncDomTier([entry({ pin: sized(), doc: doc({ height: 900 }) })]);
    await settle();
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(1);
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop .dp-card")!;
    expect(card.dataset.dpOverflow).toBeUndefined();
  });

  it("never marks a card whose height is unknown", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop .dp-card")!;
    expect(card.dataset.dpOverflow).toBeUndefined();
  });
});

/**
 * The resolved markup and its overflow mark land in ONE write, in the frame. The mark is
 * set on the `.dp-card` the markup creates; decided before the write applied, it read the
 * card being replaced — on a first mount, no card at all.
 */
describe("landing a resolved card", () => {
  it("writes the markup inside the frame, with its overflow mark, not in the middle of one", async () => {
    let land = () => {};
    vi.mocked(resolveCard).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              html: '<div class="dp-card">letter</div>',
              title: "Letter",
              readable: true,
              contentHash: "h",
              missing: false,
              naturalHeight: 800,
            });
        })
    );
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    const prop = overlay()!.querySelector<HTMLElement>(".dp-prop")!;

    land();
    await Promise.resolve();
    await Promise.resolve();
    expect(prop.querySelector(".dp-card")).toBeNull();

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const card = prop.querySelector<HTMLElement>(".dp-card")!;
    expect(card.textContent).toBe("letter");
    expect(card.dataset.dpOverflow).toBe("true");
  });

  it("does not rewrite a card whose markup did not change, so its animations run on", async () => {
    const { invalidateDomProps } = await import("../src/canvas/DomPropTier");
    syncDomTier([entry()]);
    await settle();
    const card = overlay()!.querySelector(".dp-prop .dp-card");
    expect(card).not.toBeNull();

    invalidateDomProps(["t1"]);
    syncDomTier([entry()]);
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(2);
    expect(overlay()!.querySelector(".dp-prop .dp-card")).toBe(card);
  });
});

/**
 * Every card that changed key started its resolve in the same pass: fifty cards crossing a
 * rung began fifty enrichments at once. Two at a time now, started at once when a slot is
 * free, and a queued resolve nobody wants any more is passed over.
 */
describe("the resolve queue", () => {
  /** Resolves that wait to be told to land, in the order they started. */
  function holding() {
    const pending: { id: string; land: () => void }[] = [];
    vi.mocked(resolveCard).mockImplementation(
      (p: DpPinFlags) =>
        new Promise((resolve) => {
          pending.push({
            id: p.source.uuid ?? "",
            land: () =>
              resolve({
                html: `<div class="dp-card">${p.source.uuid}</div>`,
                title: "Letter",
                readable: true,
                contentHash: "h",
                missing: false,
                naturalHeight: null,
              }),
          });
        })
    );
    return pending;
  }

  const card = (n: number, over: Record<string, any> = {}) =>
    entry({
      id: `t${n}`,
      doc: doc({ id: `t${n}` }),
      pin: pin({ source: { ...pin().source, uuid: `JournalEntry.j${n}` } }),
      ...over,
    });

  afterEach(() => {
    vi.mocked(resolveCard).mockReset();
    vi.mocked(resolveCard).mockImplementation(async () => ({
      html: '<div class="dp-card">letter</div>',
      title: "Letter",
      readable: true,
      contentHash: "h",
      missing: false,
      naturalHeight: null,
    }));
  });

  it("runs at most two resolves at once, and starts the next as one lands", async () => {
    const pending = holding();
    syncDomTier([1, 2, 3, 4, 5].map((n) => card(n)));
    expect(resolveCard).toHaveBeenCalledTimes(2);

    pending[0].land();
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(3);
    expect(pending.map((job) => job.id)).toEqual([
      "JournalEntry.j1",
      "JournalEntry.j2",
      "JournalEntry.j3",
    ]);
  });

  it("starts a resolve at once when a slot is free", () => {
    holding();
    syncDomTier([card(1)]);
    expect(resolveCard).toHaveBeenCalledTimes(1);
  });

  it("passes over a queued resolve whose card changed again, or left the view", async () => {
    const pending = holding();
    syncDomTier([card(1), card(2), card(3), card(4)]);
    expect(resolveCard).toHaveBeenCalledTimes(2);

    // Card 3 is re-keyed while it waits: its newer job keeps its place. Card 4 goes off
    // screen (L0), which unmounts it.
    const glitched = card(3, {
      pin: pin({
        source: { ...pin().source, uuid: "JournalEntry.j3" },
        effect: { ...defaultPin().effect, id: "glitch" },
      }),
    });
    syncDomTier([card(1), card(2), glitched, card(4, { tier: "L0" })]);

    pending[0].land();
    pending[1].land();
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(3);
    expect(vi.mocked(resolveCard).mock.calls[2][0].effect.id).toBe("glitch");
  });

  it("forgets its queue with the scene, and the next scene starts with both slots free", async () => {
    holding();
    syncDomTier([1, 2, 3].map((n) => card(n)));
    expect(resolveCard).toHaveBeenCalledTimes(2);

    clearDomTier();
    syncDomTier([card(7), card(8)]);
    expect(resolveCard).toHaveBeenCalledTimes(4);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(4);
  });

  it("stops waiting for a resolve that never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      holding();
      syncDomTier([1, 2, 3].map((n) => card(n)));
      expect(resolveCard).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(resolveCard).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hover", () => {
  it("marks the card while the pointer is over it, and unmarks it after", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    setDomPropHover("t1", true);
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.dataset.dpHover).toBe("true");
    setDomPropHover("t1", false);
    await settle();
    expect(card.dataset.dpHover).toBeUndefined();
  });
});

describe("previewIntensity", () => {
  it("writes the intensity onto the mounted card, for the compositor to interpolate", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    previewIntensity("t1", 0.3);
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop .dp-card")!;
    expect(card.style.getPropertyValue("--dp-i")).toBe("0.3");
  });

  it("is a no-op for a prop that is not mounted", async () => {
    previewIntensity("nope", 0.3);
    await settle();
    expect(domPropCount()).toBe(0);
  });
});

describe("followDomProp", () => {
  it("moves a mounted card to the document's current geometry without resolving", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();

    followDomProp(doc({ width: 640, height: 900 }));
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(1);
    const box = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(box.style.width).toBe("640px");
    expect(box.style.height).toBe("900px");
  });

  it("is a no-op for a prop that is not mounted", async () => {
    followDomProp(doc({ id: "nope" }));
    await settle();
    expect(domPropCount()).toBe(0);
    expect(vi.mocked(write)).not.toHaveBeenCalled();
  });

  /**
   * Core refreshes a dragged or resized tile from inside its own frame; a write queued
   * from there landed on the next one, and the card trailed the handles by a frame.
   */
  it("writes the new geometry at once, not on the next frame", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();

    followDomProp(doc({ x: 500, width: 640, height: 900 }));

    const box = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(box.style.left).toBe("180px");
    expect(box.style.width).toBe("640px");
    expect(box.style.height).toBe("900px");
  });

  it("is not put back by a placement an earlier LOD pass queued", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();

    // A pass queues the committed position; the drag then moves the card past it.
    syncDomTier([entry({ pin: sized(), doc: doc({ x: 900 }) })]);
    followDomProp(doc({ x: 500 }));
    await settle();

    expect(overlay()!.querySelector<HTMLElement>(".dp-prop")!.style.left).toBe("300px");
  });
});

describe("placement by the LOD pass", () => {
  it("still batches into the next frame, with every other card", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();
    const box = overlay()!.querySelector<HTMLElement>(".dp-prop")!;

    syncDomTier([entry({ pin: sized(), doc: doc({ x: 900 }) })]);
    expect(box.style.left).toBe("-100px");

    await settle();
    expect(box.style.left).toBe("700px");
  });
});

describe("the reveal", () => {
  it("arrives with the preset's own animation and duration when the prop is being revealed", async () => {
    syncDomTier([
      entry({ revealing: true, reveal: { animation: "materialise", durationMs: 800 } }),
    ]);
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.dataset.dpReveal).toBe("materialise");
    expect(card.style.getPropertyValue("--dp-reveal-dur")).toBe("800ms");
    expect(card.style.getPropertyValue("--dp-reveal-ease")).toContain("cubic-bezier");
  });

  it("arrives with a plain fade at the enter duration when merely mounted again", async () => {
    // Panning back over a culled prop is not a reveal, whatever the preset says.
    syncDomTier([entry({ reveal: { animation: "materialise", durationMs: 800 } })]);
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.dataset.dpReveal).toBe("fade");
    expect(card.style.getPropertyValue("--dp-reveal-dur")).toBe("");
  });

  it("fades a newly mounted card in rather than snapping it on", async () => {
    syncDomTier([entry()]);
    await settle();
    // Two frames: the class lands on the frame after mount so the transition has an
    // initial state to run from.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.classList.contains("dp-prop--in")).toBe(true);
  });

  it("does not re-run the reveal when an existing card merely moves", async () => {
    syncDomTier([entry()]);
    await settle();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    card.classList.remove("dp-prop--in");

    syncDomTier([entry({ doc: doc({ x: 900 }) })]);
    await settle();
    expect(card.classList.contains("dp-prop--in")).toBe(false);
  });
});

/**
 * Core's selection, mirrored on the card: the frame and the grip core draws lie under
 * an opaque card, so the card draws its own copy of both in the rectangle it now shares
 * with the tile.
 */
describe("the controlled mark", () => {
  it("mounts a card already marked when its tile is controlled", async () => {
    syncDomTier([entry({ controlled: true })]);
    await settle();
    expect(overlay()!.querySelector<HTMLElement>(".dp-prop")!.dataset.dpControlled).toBe("true");
  });

  it("setDomPropControlled marks and unmarks a mounted card", async () => {
    syncDomTier([entry()]);
    await settle();
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.dataset.dpControlled).toBeUndefined();

    setDomPropControlled("t1", true);
    await settle();
    expect(card.dataset.dpControlled).toBe("true");

    setDomPropControlled("t1", false);
    await settle();
    expect(card.dataset.dpControlled).toBeUndefined();
  });

  it("is a no-op for a prop that is not mounted", () => {
    expect(() => setDomPropControlled("nope", true)).not.toThrow();
  });
});

describe("followDomProp under another id", () => {
  it("places the original's card from a preview clone's document", async () => {
    syncDomTier([entry({ pin: sized() })]);
    await settle();

    // A drag clone: a copy of the document with its own id, moved by core.
    followDomProp(doc({ id: "preview-of-t1", x: 500, y: 640 }), "t1");
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(1);
    const box = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(box.style.left).toBe("300px");
    expect(box.style.top).toBe("360px");
  });
});

/**
 * The key is claimed before the resolve, so a card whose resolve failed once kept its key
 * and stayed blank for the session. It is retried now — but a bounded number of times, so
 * a card that always throws does not warn after every pan for the rest of the evening.
 */
describe("a card that fails to resolve", () => {
  it("is tried again on the next passes, then left alone", async () => {
    vi.mocked(resolveCard).mockRejectedValue(new Error("enricher broke"));
    try {
      for (let pass = 0; pass < 6; pass++) {
        syncDomTier([entry()]);
        await settle();
      }
      // The first attempt and two retries.
      expect(resolveCard).toHaveBeenCalledTimes(3);
    } finally {
      vi.mocked(resolveCard).mockReset();
      vi.mocked(resolveCard).mockImplementation(async () => ({
        html: '<div class="dp-card">letter</div>',
        title: "Letter",
        readable: true,
        contentHash: "h",
        missing: false,
        naturalHeight: null,
      }));
    }
  });

  it("starts over when its source is edited", async () => {
    const { invalidateDomProps } = await import("../src/canvas/DomPropTier");
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry()]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(1);

    invalidateDomProps(["t1"]);
    syncDomTier([entry()]);
    await settle();
    expect(resolveCard).toHaveBeenCalledTimes(2);
  });
});

/**
 * A ping is drawn inside the canvas and a card is drawn over it, so Flash and Locate
 * pinged underneath the one thing they pointed at.
 */
describe("flashDomProp", () => {
  it("lays a ring over the card in the card's own rectangle, which then removes itself", async () => {
    const { flashDomProp } = await import("../src/canvas/DomPropTier");
    syncDomTier([entry()]);
    await settle();

    expect(flashDomProp(doc())).toBe(true);
    const ring = overlay()!.querySelector<HTMLElement>(".dp-flash")!;
    expect(ring).not.toBeNull();
    expect(ring.style.left).toBe("-100px");
    expect(ring.style.width).toBe("400px");
    expect(ring.style.transform).toBe("rotate(15deg)");
    // After the card, so it paints over it.
    expect(overlay()!.lastElementChild).toBe(ring);

    ring.dispatchEvent(new Event("animationend"));
    expect(overlay()!.querySelector(".dp-flash")).toBeNull();
  });

  it("does nothing for a prop this tier is not drawing, which the canvas ping can reach", async () => {
    const { flashDomProp } = await import("../src/canvas/DomPropTier");
    expect(flashDomProp(doc({ id: "elsewhere" }))).toBe(false);
  });
});
