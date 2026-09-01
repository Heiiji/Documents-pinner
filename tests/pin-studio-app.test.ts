/**
 * @vitest-environment jsdom
 *
 * The Studio's type-size and margin sliders, driven through the real application: what
 * ONE change event writes to the anchor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { settled } from "../src/data/PinStore";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

let tile: any;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
  tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  installWorld({ isGM: true, tiles: [tile] });
});

afterEach(() => uninstallWorld());

async function studioOn(tab: string) {
  const { definePinStudio } = await import("../src/apps/PinStudio");
  const studio = new (definePinStudio())();
  studio.doc = tile;
  studio.tab = tab;
  await studio.render();
  return studio;
}

function change(studio: any, name: string, value: string) {
  const input = contentOf(studio).querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the type-size and margin sliders", () => {
  it("freezes the sibling metric before writing one of them", async () => {
    // A pin from before type sizes were stored: both metrics derive from the tile.
    const studio = await studioOn("appearance");
    change(studio, "display.typeSize", "12");
    await settled();

    const display = tile.flags[MODULE_ID][FLAGS.PIN].display;
    expect(display.typeSize).toBe(12);
    // Legacy padding of a 400 short edge is 24px; at the derived 15.38px type, 1.56em.
    expect(display.margin).toBeCloseTo(1.56, 2);
  });

  it("writes only the one metric when both are already stored", async () => {
    tile.flags[MODULE_ID][FLAGS.PIN].display.typeSize = 20;
    tile.flags[MODULE_ID][FLAGS.PIN].display.margin = 2;
    const studio = await studioOn("appearance");
    change(studio, "display.margin", "1");
    await settled();

    const display = tile.flags[MODULE_ID][FLAGS.PIN].display;
    expect(display.typeSize).toBe(20);
    expect(display.margin).toBe(1);
  });
});
