import { describe, expect, it } from "vitest";
import { LOD, RES_TIERS } from "../src/const";
import {
  PERF_BUDGET_MS,
  PERF_FRAMES,
  TIER_ORDER,
  demote,
  effectScale,
  initialPerf,
  isHeavier,
  lodFor,
  priorityOf,
  snapToTier,
  stepPerf,
  tapBudget,
  textureLongEdge,
  type LodTier,
} from "../src/canvas/lod";

const input = (over: Partial<Parameters<typeof lodFor>[0]> = {}) => ({
  apparentWidth: 400,
  apparentTypeSize: 15,
  onScreen: true,
  visible: true,
  focused: false,
  readable: true,
  ...over,
});

describe("lodFor", () => {
  it("culls a prop this user is not in the audience for, at any size", () => {
    expect(lodFor(input({ visible: false, apparentWidth: 4000 }))).toBe("L0");
  });

  it("culls a prop that is off-screen", () => {
    expect(lodFor(input({ onScreen: false }))).toBe("L0");
  });

  it("walks the ladder as a prop grows", () => {
    expect(lodFor(input({ apparentWidth: LOD.SILHOUETTE - 1 }))).toBe("L1");
    expect(lodFor(input({ apparentWidth: LOD.SILHOUETTE }))).toBe("L2a");
    expect(lodFor(input({ apparentWidth: LOD.COARSE - 1 }))).toBe("L2a");
    expect(lodFor(input({ apparentWidth: LOD.COARSE }))).toBe("L2b");
  });

  it("opens the reader only when focused, readable and the TYPE is big enough to read", () => {
    expect(lodFor(input({ focused: true, apparentTypeSize: LOD.READER_TYPE }))).toBe("L3");
    expect(lodFor(input({ focused: true, apparentTypeSize: LOD.READER_TYPE - 0.01 }))).toBe("L2b");
    expect(lodFor(input({ focused: true, readable: false, apparentTypeSize: 40 }))).toBe("L2b");
    expect(lodFor(input({ focused: false, apparentTypeSize: 40 }))).toBe("L2b");
  });

  // The type no longer follows the tile, so the box's width says nothing about
  // legibility. A small scrap with legible type is exactly the prop whose clipped tail
  // the reader exists to scroll.
  it("opens the reader for a small prop whose type is legible", () => {
    expect(lodFor(input({ focused: true, apparentWidth: 200, apparentTypeSize: 12 }))).toBe("L3");
  });

  it("refuses the reader for a large prop whose type is too small to read", () => {
    expect(lodFor(input({ focused: true, apparentWidth: 2000, apparentTypeSize: 4 }))).toBe("L2b");
  });

  it("never opens the reader for a prop the user cannot see", () => {
    expect(lodFor(input({ focused: true, visible: false, apparentWidth: 2000 }))).toBe("L0");
  });
});

describe("textureLongEdge", () => {
  it("asks for nothing at the culled and silhouette tiers", () => {
    expect(textureLongEdge("L0", 4000, 1)).toBe(0);
    expect(textureLongEdge("L1", 4000, 1)).toBe(0);
  });

  it("pins the coarse tier at a fixed 512", () => {
    expect(textureLongEdge("L2a", 100, 1)).toBe(512);
    expect(textureLongEdge("L2a", 300, 2)).toBe(512);
  });

  it("snaps the full tier up to a power of two", () => {
    expect(textureLongEdge("L2b", 600, 1)).toBe(1024);
    expect(textureLongEdge("L2b", 1025, 1)).toBe(2048);
  });

  it("caps at the largest tier rather than growing without bound", () => {
    expect(textureLongEdge("L2b", 100000, 2)).toBe(RES_TIERS[RES_TIERS.length - 1]);
  });

  it("accounts for the renderer resolution", () => {
    expect(textureLongEdge("L2b", 600, 2)).toBe(2048);
  });

  it("gives the reader the same pixels as the tier below, so focusing reallocates nothing", () => {
    expect(textureLongEdge("L3", 600, 1)).toBe(textureLongEdge("L2b", 600, 1));
  });
});

describe("snapToTier", () => {
  it("only ever returns a declared tier", () => {
    for (const px of [1, 100, 255, 256, 257, 900, 4096]) {
      expect(RES_TIERS).toContain(snapToTier(px) as never);
    }
  });

  it("is monotonic, so zooming in never asks for fewer pixels", () => {
    let previous = 0;
    for (let px = 1; px < 4000; px += 37) {
      const tier = snapToTier(px);
      expect(tier).toBeGreaterThanOrEqual(previous);
      previous = tier;
    }
  });
});

describe("effectScale and tapBudget", () => {
  it("halves the effect at the coarse tier rather than switching it off", () => {
    expect(effectScale("L2a")).toBe(0.5);
    expect(effectScale("L2b")).toBe(1);
    expect(effectScale("L1")).toBe(0);
  });

  it("bounds shader taps where the texture is already coarse", () => {
    expect(tapBudget("L2a")).toBe(3);
    expect(tapBudget("L2b")).toBeGreaterThan(3);
    expect(tapBudget("L0")).toBe(0);
  });
});

describe("demote and isHeavier", () => {
  it("steps down one rung and stops at the bottom", () => {
    expect(demote("L3")).toBe("L2b");
    expect(demote("L2b")).toBe("L2a");
    expect(demote("L0")).toBe("L0");
  });

  it("orders the tiers by cost", () => {
    expect(isHeavier("L2b", "L1")).toBe(true);
    expect(isHeavier("L1", "L2b")).toBe(false);
    expect(isHeavier("L2a", "L2a")).toBe(false);
  });

  it("can demote every tier without leaving the ladder", () => {
    for (const tier of TIER_ORDER) expect(TIER_ORDER).toContain(demote(tier as LodTier));
  });
});

describe("stepPerf", () => {
  const overBudget = PERF_BUDGET_MS + 1;

  it("ignores a single expensive frame, which is just a texture upload", () => {
    const { state, degrade } = stepPerf(initialPerf(), overBudget);
    expect(degrade).toBe(false);
    expect(state.over).toBe(1);
  });

  it("resets on one good frame, so it measures sustained cost not a grudge", () => {
    let state = initialPerf();
    for (let i = 0; i < PERF_FRAMES - 1; i++) state = stepPerf(state, overBudget).state;
    state = stepPerf(state, 1).state;
    expect(state.over).toBe(0);
  });

  it("degrades after a sustained run over budget", () => {
    let state = initialPerf();
    let degraded = false;
    for (let i = 0; i < PERF_FRAMES; i++) {
      const step = stepPerf(state, overBudget);
      state = step.state;
      degraded ||= step.degrade;
    }
    expect(degraded).toBe(true);
  });

  it("degrades and warns exactly once, however long the scene stays slow", () => {
    let state = initialPerf();
    let degradations = 0;
    for (let i = 0; i < PERF_FRAMES * 5; i++) {
      const step = stepPerf(state, overBudget);
      state = step.state;
      if (step.degrade) degradations++;
    }
    expect(degradations).toBe(1);
  });

  it("stays quiet on a scene that is comfortably inside budget", () => {
    let state = initialPerf();
    for (let i = 0; i < 1000; i++) {
      const step = stepPerf(state, 0.5);
      state = step.state;
      expect(step.degrade).toBe(false);
    }
  });
});

describe("priorityOf", () => {
  const centre = { x: 1000, y: 1000 };

  it("ranks what the GM is looking at first", () => {
    const near = priorityOf({ x: 990, y: 990, width: 20, height: 20 }, centre);
    const far = priorityOf({ x: 5000, y: 5000, width: 20, height: 20 }, centre);
    expect(near).toBeLessThan(far);
  });

  it("measures from the prop's centre, not its corner", () => {
    expect(priorityOf({ x: 900, y: 900, width: 200, height: 200 }, centre)).toBe(0);
  });

  it("is symmetric in every direction", () => {
    const left = priorityOf({ x: 500, y: 990, width: 20, height: 20 }, centre);
    const right = priorityOf({ x: 1480, y: 990, width: 20, height: 20 }, centre);
    expect(left).toBeCloseTo(right, 6);
  });
});
