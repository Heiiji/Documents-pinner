/**
 * @vitest-environment jsdom
 *
 * The API half of the UX audit's Medium and Low findings: a pin icon of the GM's own, a
 * "Find on the map" that found the wrong scene, and a "show" that said nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID, PLACEHOLDER_TEXTURE } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpSource } from "../src/types/dp";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

const documentSource = (uuid = "JournalEntry.a"): DpSource => ({
  kind: "document",
  uuid,
  src: null,
  pageId: null,
  pdfPage: null,
  followName: true,
});

function pinned(source: DpSource = documentSource()) {
  const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "pin",
        source,
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

let world: ReturnType<typeof installWorld>;

beforeEach(() => vi.resetModules());
afterEach(() => uninstallWorld());

describe("setPinIcon", () => {
  it("writes the icon a document pin wears, and puts the shared one back on null", async () => {
    const tile = pinned();
    world = installWorld({ isGM: true, tiles: [tile] });
    const { setPinIcon } = await import("../src/api");

    expect(await setPinIcon(tile, "icons/svg/anchor.svg")).toBe(true);
    expect(tile.texture.src).toBe("icons/svg/anchor.svg");
    expect(await setPinIcon(tile, null)).toBe(true);
    expect(tile.texture.src).toBe(PLACEHOLDER_TEXTURE);
  });

  it("leaves an image pin alone, which shows its image", async () => {
    const tile = pinned({ ...documentSource(), kind: "image", uuid: null, src: "maps/scrap.webp" });
    world = installWorld({ isGM: true, tiles: [tile] });
    const { setPinIcon } = await import("../src/api");
    expect(await setPinIcon(tile, "icons/svg/anchor.svg")).toBe(false);
  });
});

describe("retarget and the icon", () => {
  it("keeps the GM's icon from one document to another, like the size and the effect", async () => {
    const tile = pinned();
    tile.texture.src = "icons/svg/anchor.svg";
    world = installWorld({ isGM: true, tiles: [tile] });
    const { retarget } = await import("../src/api");

    await retarget(tile, documentSource("JournalEntry.b"));
    expect(tile.texture.src).toBe("icons/svg/anchor.svg");
    expect(tile.flags[MODULE_ID][FLAGS.PIN].source.uuid).toBe("JournalEntry.b");
  });
});

describe("locate", () => {
  it("views the pin's own scene first, rather than panning this one to its coordinates", async () => {
    const tile = pinned();
    world = installWorld({ isGM: true, tiles: [tile] });
    world.canvas.scene.id = "viewed";
    const order: string[] = [];
    tile.parent = { id: "elsewhere", view: vi.fn(async () => order.push("view")) };
    world.canvas.animatePan = vi.fn(async () => order.push("pan"));
    world.canvas.ping = vi.fn();

    const { locate } = await import("../src/api");
    await locate(tile);
    expect(order).toEqual(["view", "pan"]);
  });

  it("pans straight there on the scene already being viewed", async () => {
    const tile = pinned();
    world = installWorld({ isGM: true, tiles: [tile] });
    world.canvas.scene.id = "viewed";
    const view = vi.fn();
    tile.parent = { id: "viewed", view };
    world.canvas.animatePan = vi.fn(async () => {});
    world.canvas.ping = vi.fn();

    const { locate } = await import("../src/api");
    await locate(tile);
    expect(view).not.toHaveBeenCalled();
    expect(world.canvas.animatePan).toHaveBeenCalledTimes(1);
  });
});

describe("flash", () => {
  it("tells the DOM tier, whose card covers the ping", async () => {
    const tile = pinned();
    world = installWorld({ isGM: true, tiles: [tile] });
    world.canvas.ping = vi.fn();
    const { flash } = await import("../src/api");
    flash(tile);
    expect(world.hooks.map((h) => h.name)).toContain(`${MODULE_ID}.flash`);
  });
});

describe("showToAudience", () => {
  it("says the document is gone rather than doing nothing", async () => {
    const tile = pinned();
    world = installWorld({ isGM: true, tiles: [tile] });
    const { showToAudience } = await import("../src/api");
    await showToAudience(tile);
    expect(world.notifications.map((n) => n.message)).toContain("DP.notice.sourceMissing");
  });
});
