/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCALE_MAX,
  SCALE_MIN,
  arm,
  disarm,
  initialState,
  sizeOf,
  snap,
  stepKey,
  stepWheel,
  type GhostState,
} from "../src/apps/PlacementGhost";
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
});
