/**
 * @vitest-environment jsdom
 *
 * "Fit to content" and "reset size": the two verbs every size surface calls. The width
 * is the GM's choice and the height is the document's; the resolver's measurement is
 * mocked, since jsdom lays nothing out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const measured = { naturalHeight: 812.4 as number | null };

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => ({
    html: "",
    title: "Letter",
    readable: true,
    contentHash: "h",
    missing: false,
    naturalHeight: measured.naturalHeight,
  })),
}));

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

let tile: any;
let world: ReturnType<typeof installWorld>;

function pinned(mode: "prop" | "pin", display: Record<string, unknown> = {}) {
  const t = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  t.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode,
        display: { ...defaultPin().display, ...display },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return t;
}

beforeEach(() => {
  vi.resetModules();
  measured.naturalHeight = 812.4;
  tile = pinned("prop", { typeSize: 12, margin: 1.5 });
  world = installWorld({ isGM: true, tiles: [tile] });
});

afterEach(() => uninstallWorld());

/** The last change the anchor was asked to apply. */
const lastWrite = () => tile.updates[tile.updates.length - 1];

describe("fitToContent", () => {
  it("writes the measured height, keeps the width, and keeps the top edge where it was", async () => {
    const { fitToContent } = await import("../src/api");
    expect(await fitToContent(tile)).toBe(true);
    // The document's point is the centre: 560 → 812 tall moves it down by 126 so the
    // sheet grows downward from the same top edge.
    expect(lastWrite()).toEqual({ x: 0, y: 126, width: 400, height: 812 });
    expect(tile.height).toBe(812);
  });

  it("keeps a rotated prop's own corner, growing along its own edges", async () => {
    tile.rotation = 90;
    const { fitToContent } = await import("../src/api");
    await fitToContent(tile);
    expect(lastWrite()).toEqual({ x: -126, y: 0, width: 400, height: 812 });
  });

  it("clamps into the range a placeable can occupy", async () => {
    measured.naturalHeight = 1e9;
    const { fitToContent } = await import("../src/api");
    await fitToContent(tile);
    expect(lastWrite().height).toBe(65_536);
  });

  it("refuses a pin-mode anchor without writing", async () => {
    tile = pinned("pin");
    uninstallWorld();
    world = installWorld({ isGM: true, tiles: [tile] });
    const { fitToContent } = await import("../src/api");
    expect(await fitToContent(tile)).toBe(false);
    expect(tile.updates).toEqual([]);
  });

  it("says so when the content cannot be measured, and leaves the height alone", async () => {
    measured.naturalHeight = null;
    const { fitToContent } = await import("../src/api");
    expect(await fitToContent(tile)).toBe(false);
    expect(tile.updates).toEqual([]);
    expect(world.notifications.map((n) => n.type)).toContain("warn");
  });

  it("freezes a legacy pin's type first, so the fit cannot chase its own height", async () => {
    tile = pinned("prop");
    uninstallWorld();
    world = installWorld({ isGM: true, tiles: [tile] });
    const { fitToContent } = await import("../src/api");
    await fitToContent(tile);

    const display = tile.flags[MODULE_ID][FLAGS.PIN].display;
    expect(display.typeSize).toBeCloseTo(400 / 26, 6);
    expect(display.margin).not.toBeNull();
    expect(tile.height).toBe(812);
  });
});

describe("resetSize", () => {
  it("returns the box to the natural size for this grid, and touches nothing else", async () => {
    tile.width = 900;
    tile.height = 300;
    const { resetSize } = await import("../src/api");
    expect(await resetSize(tile)).toBe(true);
    expect(lastWrite()).toEqual({ x: -250, y: 133, width: 400, height: 566 });
    expect(tile.flags[MODULE_ID][FLAGS.PIN].display.typeSize).toBe(12);
  });

  it("resets a pin-mode anchor to one grid square", async () => {
    tile = pinned("pin");
    tile.width = 300;
    uninstallWorld();
    world = installWorld({ isGM: true, tiles: [tile] });
    const { resetSize } = await import("../src/api");
    await resetSize(tile);
    expect(lastWrite()).toEqual({ x: -100, y: -230, width: 100, height: 100 });
  });
});
