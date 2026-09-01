/**
 * @vitest-environment jsdom
 *
 * The one assumption every placement rests on — a TileDocument's point is the tile's
 * centre — was measured in a live world, and the type definitions for the same core
 * generation say the opposite. Nothing readable at build time will announce the day core
 * changes its mind, so the module asks the first drawn tile of every scene.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTileGeometry } from "../src/canvas/PinnedTile";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

afterEach(() => {
  uninstallWorld();
  vi.restoreAllMocks();
});

describe("checkTileGeometry", () => {
  it("agrees with a canvas whose tile bounds are centred on the document's point", () => {
    installWorld({ tiles: [fakeTile({ id: "a", x: 300, y: 400, width: 400, height: 560 })] });
    expect(checkTileGeometry()).toBe("agree");
  });

  it("agrees for a rotated tile, whose bounds are the box turned about the point", () => {
    installWorld({
      tiles: [fakeTile({ id: "a", x: 300, y: 400, width: 400, height: 560, rotation: 30 })],
    });
    expect(checkTileGeometry()).toBe("agree");
  });

  it("warns out loud when core reports the point as a corner", () => {
    const tile = fakeTile({ id: "a", x: 300, y: 400, width: 400, height: 560 });
    Object.defineProperty(tile.object, "bounds", {
      get: () => ({ x: 300, y: 400, width: 400, height: 560 }),
    });
    Object.defineProperty(tile.object, "center", { get: () => ({ x: 500, y: 680 }) });
    installWorld({ tiles: [tile] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(checkTileGeometry()).toBe("disagree");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("tileRect");
  });

  it("reports untested on a scene with no drawn tile, rather than guessing", () => {
    installWorld({ tiles: [] });
    expect(checkTileGeometry()).toBe("untested");
  });
});
