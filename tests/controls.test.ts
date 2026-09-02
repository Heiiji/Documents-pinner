/**
 * The gap between where a pin is PLACED and where it can be EDITED.
 *
 * DESIGN §5.1 puts these tools under Notes deliberately — the control rail is contested
 * and pins belong beside map notes — while the anchors are Tiles. Core only lets a Tile be
 * selected while the Tiles layer is active: `control()` returns `false` otherwise, with no
 * error, no notification and no cursor change to explain it.
 *
 * Measured in a live v14.365 world, on the pin the GM was trying to drag:
 *
 *     on the Notes layer   control() -> false, controlled: false
 *     on the Tiles layer   control() -> true,  controlled: true
 *
 * The way out is now the hit layer (a press on a prop from the Notes layer switches layer
 * and selects it), so the toolbar no longer carries a button to say "go there first".
 * `locate` still switches layer itself, and that is what these tests keep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateTilesLayer, onGetSceneControlButtons } from "../src/ui/controls";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

let activated: number;

beforeEach(() => {
  const world = installWorld({ isGM: true });
  activated = 0;
  world.canvas.tiles.activate = () => {
    activated++;
    world.canvas.tiles.active = true;
  };
});

afterEach(() => uninstallWorld());

const notesControl = () => {
  const controls: any = { notes: { tools: { note: { name: "note" } } } };
  onGetSceneControlButtons(controls);
  return controls.notes.tools;
};

describe("the Notes control tools", () => {
  it("no longer carries the Tiles-layer detour, which the hit layer made unnecessary", () => {
    expect(Object.keys(notesControl())).not.toContain("dp-edit");
  });

  it("keeps placing and the Pinboard alongside the core note tool", () => {
    const tools = notesControl();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["note", "dp-pin", "dp-board"]));
  });

  it("gives every tool a distinct order, so none lands on top of another", () => {
    const tools = notesControl();
    const orders = ["dp-pin", "dp-board"].map((k) => tools[k].order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("adds nothing for a player", () => {
    uninstallWorld();
    installWorld({ isGM: false });
    expect(Object.keys(notesControl())).toEqual(["note"]);
  });

  it("does not throw when the Notes control is absent", () => {
    const controls: any = {};
    expect(() => onGetSceneControlButtons(controls)).not.toThrow();
  });
});

describe("activateTilesLayer", () => {
  it("reports whether it could switch", () => {
    expect(activateTilesLayer()).toBe(true);
    expect(activated).toBe(1);
  });

  it("says so rather than throwing when there is no canvas", () => {
    uninstallWorld();
    expect(activateTilesLayer()).toBe(false);
  });
});

describe("locate", () => {
  it("selects the pin it just found, so the GM can drag it", async () => {
    const world = installWorld({ isGM: true });
    world.canvas.tiles.activate = () => {
      activated++;
    };
    world.canvas.animatePan = vi.fn(async () => {});
    world.canvas.ping = vi.fn();

    const controlled: unknown[] = [];
    const doc: any = {
      x: 100,
      y: 100,
      width: 400,
      height: 566,
      object: { control: (o: unknown) => controlled.push(o) },
    };

    const api = await import("../src/api");
    await api.locate(doc);

    expect(activated).toBe(1);
    expect(controlled).toHaveLength(1);
    // The pan lands on the document's point, which is the tile's centre.
    expect(world.canvas.animatePan).toHaveBeenCalledWith(
      expect.objectContaining({ x: 100, y: 100 })
    );
  });
});
