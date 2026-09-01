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
  setDomPropHover,
  syncDomTier,
} from "../src/canvas/DomPropTier";
import { resolveCard } from "../src/render/ContentResolver";
import { write } from "../src/apps/OverlayRoot";

const pin = (over: Partial<DpPinFlags> = {}): DpPinFlags => ({
  ...defaultPin(),
  mode: "prop",
  source: { kind: "document", uuid: "JournalEntry.a", src: null, pageId: null, followName: true },
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

  it("positions the card in SCENE space, so the overlay matrix does the rest", async () => {
    syncDomTier([entry()]);
    await settle();

    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.style.left).toBe("100px");
    expect(card.style.top).toBe("240px");
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

  it("re-positions without re-resolving when only the geometry moved", async () => {
    syncDomTier([entry()]);
    await settle();
    syncDomTier([entry({ doc: doc({ x: 900 }) })]);
    await settle();

    expect(resolveCard).toHaveBeenCalledTimes(1);
    expect(overlay()!.querySelector<HTMLElement>(".dp-prop")!.style.left).toBe("900px");
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

  it("re-resolves when the type size changes, because that is drawn into the card", async () => {
    syncDomTier([entry({ pin: sized(12) })]);
    await settle();
    syncDomTier([entry({ pin: sized(20) })]);
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
