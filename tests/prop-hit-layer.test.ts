import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerPropHitLayer, rotatedPolygon } from "../src/canvas/PropHitLayer";
import { defaultPin } from "../src/data/pin-schema";
import * as api from "../src/api";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

/** A stand-in for PIXI.Polygon: the maths is ours, the container is not. */
class FakePolygon {
  points: number[];
  constructor(points: number[]) {
    this.points = points;
  }
}
const PIXI = { Polygon: FakePolygon } as any;

const round = (n: number) => Math.round(n * 1000) / 1000;
const pairs = (poly: FakePolygon) => {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.points.length; i += 2) {
    out.push([round(poly.points[i]), round(poly.points[i + 1])]);
  }
  return out;
};

/**
 * The document's point is the tile's CENTRE on v14 — measured, see `tileRect` — so the
 * footprint is laid out around it. Every corner used to be derived from the point first,
 * which put each player's hit area half a card down and right of the paper.
 */
describe("rotatedPolygon", () => {
  it("traces the four corners of an unrotated prop around its point", () => {
    const poly = rotatedPolygon({ x: 100, y: 200, width: 40, height: 20, rotation: 0 }, PIXI);
    expect(pairs(poly)).toEqual([
      [80, 190],
      [120, 190],
      [120, 210],
      [80, 210],
    ]);
  });

  it("rotates about the point, matching the tile core draws", () => {
    const poly = rotatedPolygon({ x: 0, y: 0, width: 100, height: 100, rotation: 90 }, PIXI);
    const points = pairs(poly);
    // A square rotated 90° about its own centre covers exactly the same ground.
    for (const [px, py] of points) {
      expect(Math.abs(px)).toBeCloseTo(50, 6);
      expect(Math.abs(py)).toBeCloseTo(50, 6);
    }
  });

  it("keeps the point at the centre at any angle", () => {
    for (const rotation of [0, 17, 45, 90, 180, 275, 359]) {
      const poly = rotatedPolygon({ x: 10, y: 30, width: 80, height: 40, rotation }, PIXI);
      const points = pairs(poly);
      const cx = points.reduce((s, p) => s + p[0], 0) / 4;
      const cy = points.reduce((s, p) => s + p[1], 0) / 4;
      expect(cx, `rotation ${rotation}`).toBeCloseTo(10, 6);
      expect(cy, `rotation ${rotation}`).toBeCloseTo(30, 6);
    }
  });

  it("preserves the area, so a rotated prop is no easier or harder to click", () => {
    const area = (points: [number, number][]) => {
      let sum = 0;
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        sum += x1 * y2 - x2 * y1;
      }
      return Math.abs(sum) / 2;
    };
    // Raw points, not the rounded pairs: rounding for readability loses more
    // precision than the property being asserted.
    const raw = (poly: FakePolygon): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < poly.points.length; i += 2)
        out.push([poly.points[i], poly.points[i + 1]]);
      return out;
    };
    const flat = rotatedPolygon({ x: 0, y: 0, width: 80, height: 40, rotation: 0 }, PIXI);
    const tilted = rotatedPolygon({ x: 0, y: 0, width: 80, height: 40, rotation: 37 }, PIXI);
    expect(area(raw(tilted))).toBeCloseTo(area(raw(flat)), 6);
  });

  it("treats a missing rotation as none", () => {
    const poly = rotatedPolygon({ x: 0, y: 0, width: 10, height: 10 }, PIXI);
    expect(pairs(poly)[0]).toEqual([-5, -5]);
  });

  it("emits eight numbers, which is what PIXI.Polygon expects", () => {
    const poly = rotatedPolygon({ x: 5, y: 5, width: 10, height: 10, rotation: 12 }, PIXI);
    expect(poly.points.length).toBe(8);
    expect(poly.points.every((n: number) => Number.isFinite(n))).toBe(true);
  });
});

/**
 * The layer's OTHER half, which nothing covered: `sync()` deciding which placeables get
 * a hit area at all. The Tiles layer is GM-only — that is the premise of DESIGN §2 and
 * the reason this layer exists — so a mode the sync skips is a mode no player can ever
 * click. Pin mode was skipped, which is the brief's first promise.
 */
describe("PropHitLayer.sync", () => {
  // Registration is once-per-session by design, so the class is captured once and the
  // world is rebuilt per test around it.
  let LayerClass: any;

  beforeAll(() => {
    installWorld({});
    expect(registerPropHitLayer()).toBe(true);
    LayerClass = (Object.values((globalThis as any).CONFIG.Canvas.layers)[0] as any).layerClass;
    uninstallWorld();
  });

  function layerFor(tiles: any[], isGM: boolean, activeLayer: "notes" | "tiles" | "tokens" = "tiles") {
    const world = installWorld({ isGM, tiles });
    world.canvas.activeLayer =
      activeLayer === "notes" ? world.canvas.notes : activeLayer === "tiles" ? world.canvas.tiles : {};
    world.canvas.tiles.activate = vi.fn();
    const layer = new LayerClass();
    layer.hits = new Map();
    layer.suspended = false;
    layer.children = [];
    layer.addChild = (child: any) => {
      layer.children.push(child);
      return child;
    };
    layer.sync();
    return layer;
  }

  const pinned = (over: Record<string, any> = {}) => {
    const tile = fakeTile({ id: over.id ?? "t1" });
    tile.flags = {
      "documents-pinner": {
        pin: { ...defaultPin(), mode: over.mode ?? "prop", audience: { kind: "everyone" } },
      },
    };
    if (over.isVisible === false) tile.object.isVisible = false;
    return tile;
  };

  afterEach(() => uninstallWorld());

  it("builds a hit area for a PIN, which is the gesture the whole module promises", () => {
    const layer = layerFor([pinned({ mode: "pin" })], false);
    expect(layer.hits.size).toBe(1);
  });

  it("builds a hit area for a prop", () => {
    const layer = layerFor([pinned({ mode: "prop" })], false);
    expect(layer.hits.size).toBe(1);
  });

  it("builds nothing for the GM on the Tiles or Tokens layer, where the real placeable is theirs", () => {
    expect(layerFor([pinned({ mode: "pin" })], true, "tiles").hits.size).toBe(0);
    uninstallWorld();
    expect(layerFor([pinned({ mode: "pin" })], true, "tokens").hits.size).toBe(0);
  });

  /**
   * The most-reported failure in the changelog. The module's own tools live on the Notes
   * layer, and core refuses to control a Tile anywhere but the Tiles layer — silently —
   * so a GM who placed a pin and tried to drag it got nothing, and three code paths
   * existed to say "go to the Tiles layer first".
   */
  describe("the GM on the Notes layer", () => {
    it("gets a hit area, even on a pin players cannot open", () => {
      const tile = pinned({ mode: "prop" });
      tile.flags["documents-pinner"].pin.interaction = { open: "never", tooltip: "" };
      expect(layerFor([tile], true, "notes").hits.size).toBe(1);
    });

    it("selects the pin where core can move it: the Tiles layer, then control()", () => {
      const tile = pinned({ mode: "prop" });
      tile.object.control = vi.fn();
      const layer = layerFor([tile], true, "notes");
      const container = [...layer.hits.values()][0];

      container.emit("pointerdown", { button: 0 });
      expect((globalThis as any).canvas.tiles.activate).toHaveBeenCalledTimes(1);
      expect(tile.object.control).toHaveBeenCalledWith({ releaseOthers: true });
    });

    it("adds to the selection with shift", () => {
      const tile = pinned({ mode: "prop" });
      tile.object.control = vi.fn();
      const layer = layerFor([tile], true, "notes");
      [...layer.hits.values()][0].emit("pointerdown", { button: 0, shiftKey: true });
      expect(tile.object.control).toHaveBeenCalledWith({ releaseOthers: false });
    });

    it("opens the document on a double click, like a player", () => {
      const layer = layerFor([pinned({ mode: "prop" })], true, "notes");
      const spy = vi.spyOn(api, "openLocally").mockImplementation(async () => {});
      [...layer.hits.values()][0].emit("pointertap", { detail: 2 });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("fires the hover hook, so the GM can finally see the tooltip they wrote", () => {
      const world = installWorld({ isGM: true, tiles: [pinned({ mode: "prop" })] });
      uninstallWorld();
      const layer = layerFor([pinned({ mode: "prop" })], true, "notes");
      const hooks = (globalThis as any).Hooks;
      const calls: any[] = [];
      const original = hooks.callAll;
      hooks.callAll = (name: string, ...args: any[]) => calls.push([name, ...args]);
      [...layer.hits.values()][0].emit("pointerover");
      hooks.callAll = original;
      expect(calls.some(([name, , hovering]) => name.endsWith(".propHover") && hovering)).toBe(true);
      void world;
    });
  });

  it("skips a pin this player cannot see", () => {
    const layer = layerFor([pinned({ mode: "pin", isVisible: false })], false);
    expect(layer.hits.size).toBe(0);
  });

  it("opens the document when a player double-clicks it", () => {
    const layer = layerFor([pinned({ mode: "pin" })], false);
    const container = [...layer.hits.values()][0];
    const opened: any[] = [];
    const spy = vi.spyOn(api, "openLocally").mockImplementation(async (doc: any) => {
      opened.push(doc);
    });

    container.emit("pointertap", { detail: 2 });
    expect(opened).toHaveLength(1);
    spy.mockRestore();
  });
});
