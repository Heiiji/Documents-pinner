/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Deferred resolves, so a test can decide which preview lands first. */
const pending: { html: string; resolve: () => void }[] = [];
vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(
    (pin: any) =>
      new Promise((resolve) => {
        const html = `<div class="dp-card">type ${pin.display.typeSize}</div>`;
        const card = { html, title: "", readable: true, contentHash: "h", missing: false };
        pending.push({ html, resolve: () => resolve(card) });
      })
  ),
}));

import {
  SCALE_MAX,
  SCALE_MIN,
  TYPE_SIZE_GHOST_MAX,
  arm,
  disarm,
  initialState,
  sizeOf,
  snap,
  stepKey,
  stepWheel,
  type GhostState,
} from "../src/apps/PlacementGhost";
import { TYPE_SIZE_MIN } from "../src/data/pin-schema";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";

const source = {
  kind: "document" as const,
  uuid: "JournalEntry.abc",
  src: null,
  pageId: null,
  followName: true,
};

const ghost = (over: Partial<GhostState> = {}): GhostState => ({
  ...initialState(source, "prop"),
  ...over,
});

describe("stepWheel", () => {
  it("rotates in 15° steps, which lands a letter square without fiddling", () => {
    expect(stepWheel(ghost(), 1, {}).rotation).toBe(15);
    expect(stepWheel(ghost(), -1, {}).rotation).toBe(345);
  });

  it("drops to 1° with shift, for a prop that should look dropped not placed", () => {
    expect(stepWheel(ghost(), 1, { shift: true }).rotation).toBe(1);
  });

  it("wraps rotation into 0..359 in both directions", () => {
    expect(stepWheel(ghost({ rotation: 350 }), 1, {}).rotation).toBe(5);
    expect(stepWheel(ghost({ rotation: 5 }), -1, {}).rotation).toBe(350);
  });

  it("scales with alt, and never past the documented bounds", () => {
    let state = ghost();
    for (let i = 0; i < 100; i++) state = stepWheel(state, -1, { alt: true });
    expect(state.scale).toBe(SCALE_MAX);

    for (let i = 0; i < 200; i++) state = stepWheel(state, 1, { alt: true });
    expect(state.scale).toBe(SCALE_MIN);
  });

  it("leaves rotation alone while scaling", () => {
    expect(stepWheel(ghost({ rotation: 45 }), 1, { alt: true }).rotation).toBe(45);
  });
});

describe("the type size", () => {
  it("starts at the default type size for the grid", () => {
    expect(initialState(source, "prop", 100).typeSize).toBeCloseTo(400 / 26, 6);
    expect(initialState(source, "prop", 200).typeSize).toBeCloseTo(800 / 26, 6);
  });

  it("starts at the type size used last, when there is one", () => {
    installWorld({ isGM: true, settings: { lastTypeSize: 12 } });
    try {
      expect(initialState(source, "prop", 100).typeSize).toBe(12);
    } finally {
      uninstallWorld();
    }
  });

  it("changes the type with shift+alt and never the box", () => {
    const next = stepWheel(ghost(), -1, { alt: true, shift: true });
    expect(next.typeSize).toBeCloseTo(ghost().typeSize + 0.5, 6);
    expect(next.scale).toBe(1);
  });

  it("scales the box with alt and never the type", () => {
    const next = stepWheel(ghost(), -1, { alt: true });
    expect(next.scale).toBeCloseTo(1.1, 6);
    expect(next.typeSize).toBe(ghost().typeSize);
  });

  it("clamps the type size at both ends", () => {
    let state = ghost();
    for (let i = 0; i < 300; i++) state = stepWheel(state, -1, { alt: true, shift: true });
    expect(state.typeSize).toBe(TYPE_SIZE_GHOST_MAX);
    for (let i = 0; i < 300; i++) state = stepWheel(state, 1, { alt: true, shift: true });
    expect(state.typeSize).toBe(TYPE_SIZE_MIN);
  });

  it("requests a fit on F and claims the key", () => {
    expect(stepKey(ghost(), "f")).toMatchObject({ fitPending: true });
    expect(stepKey(ghost(), "F")).not.toBeNull();
  });

  it("forgets a fitted height when the box is scaled or the shape changes", () => {
    const fitted = ghost({ heightOverride: 900 });
    expect(sizeOf(fitted, 100).height).toBe(900);
    expect(stepWheel(fitted, 1, { alt: true }).heightOverride).toBeNull();
    expect(stepWheel(fitted, 1, { alt: true, shift: true }).heightOverride).toBeNull();
    expect((stepKey(fitted, " ") as GhostState).heightOverride).toBeNull();
  });

  it("ignores a fitted height in pin mode, which is one grid square", () => {
    expect(sizeOf(ghost({ mode: "pin", heightOverride: 900 }), 100).height).toBe(100);
  });
});

describe("the shown rotation", () => {
  it("accumulates rather than wrapping, so a step across zero never turns the long way", () => {
    let state = ghost();
    for (let i = 0; i < 24; i++) state = stepWheel(state, 1, {});
    expect(state.rotation).toBe(0);
    expect(state.rotationShown).toBe(360);
    state = stepWheel(state, -1, {});
    expect(state.rotation).toBe(345);
    expect(state.rotationShown).toBe(345);
  });

  it("resets to square by the nearest full turn", () => {
    expect((stepKey(ghost({ rotation: 30, rotationShown: 390 }), "r") as GhostState).rotationShown).toBe(360);
    expect((stepKey(ghost({ rotation: 330, rotationShown: -30 }), "r") as GhostState).rotationShown).toBe(0);
  });
});

describe("stepKey", () => {
  it("claims only the keys it handles, so other shortcuts still work while armed", () => {
    expect(stepKey(ghost(), "a")).toBeNull();
    expect(stepKey(ghost(), "Tab")).toBeNull();
    expect(stepKey(ghost(), "F5")).toBeNull();
  });

  it("switches shape on space", () => {
    expect(stepKey(ghost({ mode: "prop" }), " ")).toMatchObject({ mode: "pin" });
    expect(stepKey(ghost({ mode: "pin" }), " ")).toMatchObject({ mode: "prop" });
  });

  it("cycles effects forward and backward, wrapping at both ends", () => {
    const last = CORE_PRESETS.length - 1;
    expect(stepKey(ghost({ effectIndex: last }), "e")).toMatchObject({ effectIndex: 0 });
    expect(stepKey(ghost({ effectIndex: 0 }), "E", { shift: true })).toMatchObject({
      effectIndex: last,
    });
  });

  it("accepts the shifted form of every letter key", () => {
    for (const key of ["V", "R", "E"]) expect(stepKey(ghost(), key)).not.toBeNull();
  });

  it("toggles the audience and resets rotation", () => {
    expect(stepKey(ghost({ audience: "everyone" }), "v")).toMatchObject({ audience: "hidden" });
    expect(stepKey(ghost({ rotation: 137 }), "r")).toMatchObject({ rotation: 0 });
  });

  it("cancels on escape", () => {
    expect(stepKey(ghost(), "Escape")).toBe("cancel");
  });
});

describe("snap", () => {
  it("snaps to half a grid square, which is where placeables sit", () => {
    expect(snap({ x: 103, y: 47 }, 100, false)).toEqual({ x: 100, y: 50 });
  });

  it("does not snap while free placement is held", () => {
    expect(snap({ x: 103, y: 47 }, 100, true)).toEqual({ x: 103, y: 47 });
  });

  it("leaves a gridless scene alone rather than collapsing it to the origin", () => {
    expect(snap({ x: 103, y: 47 }, 0, false)).toEqual({ x: 103, y: 47 });
  });
});

describe("sizeOf", () => {
  it("gives a pin one grid square and a prop a portrait sheet", () => {
    expect(sizeOf(ghost({ mode: "pin" }), 100)).toEqual({ width: 100, height: 100 });
    expect(sizeOf(ghost({ mode: "prop" }), 100)).toEqual({ width: 400, height: 566 });
  });

  it("applies the ghost's scale to both axes and rounds to whole pixels", () => {
    expect(sizeOf(ghost({ mode: "pin", scale: 2.5 }), 100)).toEqual({ width: 250, height: 250 });
    expect(Number.isInteger(sizeOf(ghost({ scale: 1.37 }), 100).width)).toBe(true);
  });
});

/**
 * Acceptance criterion 4 — "a token standing on a prop renders in front of it" — is one
 * of the two visual claims the whole primary-group architecture was chosen for, and every
 * ghost-placed prop broke it.
 *
 * `place()` wrote `elevation: canvas.scene.foregroundElevation`, which is the scene's
 * foreground THRESHOLD (default 20), not an elevation to inherit. A tile at or above it
 * is an overhead tile and sorts above tokens in `canvas.primary`.
 */
describe("placement elevation", () => {
  const created: Record<string, unknown>[] = [];

  beforeEach(() => {
    created.length = 0;
    const world = installWorld({ isGM: true });
    // A default scene: the foreground threshold is 20, which is what used to be copied.
    expect(world.canvas.scene.foregroundElevation).toBe(20);
    world.canvas.scene.createEmbeddedDocuments = async (
      _type: string,
      docs: Record<string, unknown>[]
    ) => {
      created.push(...docs);
      return [];
    };
    document.body.innerHTML = '<div id="board"></div>';
  });

  afterEach(() => {
    disarm();
    uninstallWorld();
  });

  it("places a prop at ground level, not above the foreground threshold", async () => {
    const armed = arm({
      kind: "document",
      uuid: "JournalEntry.a",
      src: null,
      pageId: null,
      followName: true,
    });
    expect(armed).toBe(true);

    document
      .getElementById("board")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created).toHaveLength(1);
    expect(created[0].elevation).toBe(0);
  });

  it("places once for two presses while the first is still landing", async () => {
    arm(source);
    const board = document.getElementById("board")!;
    board.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    board.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toHaveLength(1);
  });

  it("shows the held modifiers on the ghost and keeps stamping across a shifted press", async () => {
    arm(source);
    const live = () => document.querySelector<HTMLElement>(".dp-ghost:not(.dp-ghost--out)")!;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(live().dataset.dpFree).toBe("true");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(live().dataset.dpFree).toBeUndefined();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    expect(live().dataset.dpSticky).toBe("true");
    expect(live().textContent).toContain("DP.ghost.stamping");

    document
      .getElementById("board")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toHaveLength(1);
    expect(document.querySelector(".dp-ghost:not(.dp-ghost--out)")).not.toBeNull();
  });

  it("passes the chosen type size to the pin it places", async () => {
    arm(source);
    document
      .getElementById("board")!
      .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1, altKey: true, shiftKey: true }));
    document
      .getElementById("board")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pin = created[0]["flags.documents-pinner.pin"] as any;
    expect(pin.display.typeSize).toBeCloseTo(400 / 26 + 0.5, 6);
    expect(pin.display.margin).toBe(1.5);
  });
});

describe("the preview", () => {
  beforeEach(() => {
    pending.length = 0;
    installWorld({ isGM: true });
    document.body.innerHTML = '<div id="board"></div>';
  });

  afterEach(() => {
    disarm();
    uninstallWorld();
  });

  const body = () =>
    document.querySelector<HTMLElement>(".dp-ghost:not(.dp-ghost--out) .dp-ghost__body")!;

  it("shows the swatch at once and the real page once it resolves", async () => {
    arm(source);
    expect(body().querySelector(".dp-card")).not.toBeNull();
    expect(body().textContent).toBe("");

    expect(pending).toHaveLength(1);
    pending[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(body().textContent).toContain("type");
  });

  it("previews the real content at the chosen size, and a slow resolve cannot overwrite a newer one", async () => {
    arm(source);
    const board = document.getElementById("board")!;
    board.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1, altKey: true, shiftKey: true }));
    board.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1, altKey: true, shiftKey: true }));
    expect(pending).toHaveLength(3);

    // The newest lands first, then the stale ones straggle in.
    pending[2].resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newest = body().textContent;
    pending[0].resolve();
    pending[1].resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(body().textContent).toBe(newest);
    expect(newest).toContain(String(Math.round((400 / 26 + 1) * 100) / 100).slice(0, 4));
  });
});
