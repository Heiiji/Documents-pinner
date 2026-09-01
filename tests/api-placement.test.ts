/**
 * @vitest-environment jsdom
 *
 * What a NEW anchor is born with. The type size has to be stored from the first write —
 * in both modes — or a prop's first resize is a zoom rather than a change of window, and
 * a pin that later becomes a prop has no type to draw at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { DEFAULT_MARGIN_EM } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

const FLAG_PATH = `flags.${MODULE_ID}.${FLAGS.PIN}`;

const source = {
  kind: "document" as const,
  uuid: "JournalEntry.j",
  src: null,
  pageId: null,
  followName: true,
};

let world: ReturnType<typeof installWorld>;
let created: any[];

beforeEach(() => {
  vi.resetModules();
  world = installWorld({ isGM: true });
  created = [];
  world.canvas.scene.createEmbeddedDocuments = async (_type: string, data: any[]) => {
    created.push(...data);
    return data.map((d, i) => ({ ...d, id: `new${i}` }));
  };
});

afterEach(() => uninstallWorld());

describe("pinAt", () => {
  it("places a new prop at the natural size with the default type size for this grid", async () => {
    const { pinAt } = await import("../src/api");
    await pinAt(world.canvas.scene, source, { x: 0, y: 0, mode: "prop" });

    expect(created).toHaveLength(1);
    expect(created[0].width).toBe(400);
    expect(created[0].height).toBe(566);
    const pin = created[0][FLAG_PATH];
    expect(pin.display.typeSize).toBeCloseTo(400 / 26, 6);
    expect(pin.display.margin).toBe(DEFAULT_MARGIN_EM);
  });

  it("gives a pin-mode anchor the type too, for the day it becomes a prop", async () => {
    const { pinAt } = await import("../src/api");
    await pinAt(world.canvas.scene, source, { x: 0, y: 0, mode: "pin" });

    expect(created[0].width).toBe(100);
    expect(created[0][FLAG_PATH].display.typeSize).toBeCloseTo(400 / 26, 6);
  });

  it("honours a type size the caller chose", async () => {
    const { pinAt } = await import("../src/api");
    await pinAt(world.canvas.scene, source, { x: 0, y: 0, mode: "prop", typeSize: 12, margin: 2 });

    expect(created[0][FLAG_PATH].display.typeSize).toBe(12);
    expect(created[0][FLAG_PATH].display.margin).toBe(2);
  });
});

describe("adoptTile", () => {
  it("freezes the type a tile adopted as a prop is already drawn at", async () => {
    const { adoptTile } = await import("../src/api");
    const tile = fakeTile({ id: "big", width: 800, height: 1132 });
    await adoptTile(tile, source);

    const pin = tile.flags[MODULE_ID][FLAGS.PIN];
    expect(pin.mode).toBe("prop");
    expect(pin.display.typeSize).toBeCloseTo(800 / 26, 6);
    expect(pin.display.margin).not.toBeNull();
  });

  it("leaves a small tile's type to be decided when it becomes a prop", async () => {
    const { adoptTile } = await import("../src/api");
    const tile = fakeTile({ id: "small", width: 100, height: 100 });
    await (globalThis as any).game.settings.set("documents-pinner", "defaultMode", "pin");
    await adoptTile(tile, source);

    const pin = tile.flags[MODULE_ID][FLAGS.PIN];
    expect(pin.mode).toBe("pin");
    expect(pin.display.typeSize).toBeNull();
  });
});
