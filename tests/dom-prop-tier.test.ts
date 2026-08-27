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

import { clearDomTier, domPropCount, syncDomTier } from "../src/canvas/DomPropTier";
import { resolveCard } from "../src/render/ContentResolver";

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
  ...over,
});

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

  it("draws nothing for a culled or silhouette prop", async () => {
    syncDomTier([entry({ tier: "L0" }), entry({ id: "t2", tier: "L1" })]);
    await settle();
    expect(domPropCount()).toBe(0);
  });

  it("leaves the focused prop to the reader rather than stacking two copies", async () => {
    syncDomTier([entry({ focused: true })]);
    await settle();
    expect(domPropCount()).toBe(0);
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

  it("stays pointer-transparent so PropHitLayer keeps owning interaction", async () => {
    syncDomTier([entry()]);
    await settle();
    // The rule lives in prop.css; what the element must not do is opt itself in.
    const card = overlay()!.querySelector<HTMLElement>(".dp-prop")!;
    expect(card.style.pointerEvents).toBe("");
    expect(card.getAttribute("aria-hidden")).toBe("true");
  });
});
