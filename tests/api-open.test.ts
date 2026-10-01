/**
 * @vitest-environment jsdom
 *
 * The player-side half of the key glyph, and the flash that leaked a hidden pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

let world: ReturnType<typeof installWorld>;
let tile: any;
let source: any;

function pinned(mode: "pin" | "prop", audience: Record<string, unknown> = {}) {
  const t = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  t.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode,
        source: {
          kind: "document",
          uuid: "JournalEntry.j",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
        },
        audience: { ...defaultPin().audience, kind: "everyone", ...audience },
      },
    },
  };
  return t;
}

beforeEach(() => {
  vi.resetModules();
  source = {
    name: "The Duke's Letter",
    documentName: "JournalEntry",
    sheet: { render: vi.fn() },
    testUserPermission: vi.fn(() => false),
  };
  (globalThis as any).fromUuid = async () => source;
});

afterEach(() => {
  delete (globalThis as any).fromUuid;
  uninstallWorld();
});

describe("openLocally for a player", () => {
  it("says the GM has not granted access yet, instead of letting the sheet refuse", async () => {
    tile = pinned("pin");
    world = installWorld({ isGM: false, tiles: [tile] });
    const { openLocally } = await import("../src/api");
    await openLocally(tile);

    expect(source.sheet.render).not.toHaveBeenCalled();
    expect(world.notifications.map((n) => n.type)).toContain("info");
  });

  it("opens the sheet when they can read it", async () => {
    source.testUserPermission = vi.fn(() => true);
    tile = pinned("pin");
    world = installWorld({ isGM: false, tiles: [tile] });
    const { openLocally } = await import("../src/api");
    await openLocally(tile);

    expect(source.sheet.render).toHaveBeenCalled();
  });

  // The four places that ask "can this player open it?" are one function now, and it
  // fails closed: the sheet's own open used to read "can open" from a document that cannot
  // say, where the key glyph and the card read "cannot".
  it("tells a player not yet when the document cannot say who may open it", async () => {
    delete source.testUserPermission;
    tile = pinned("pin");
    world = installWorld({ isGM: false, tiles: [tile] });
    const { openLocally } = await import("../src/api");
    await openLocally(tile);

    expect(source.sheet.render).not.toHaveBeenCalled();
    expect(world.notifications).toEqual([{ type: "info", message: "DP.notice.cannotOpenYet" }]);
  });

  it("never gates the GM", async () => {
    tile = pinned("pin");
    world = installWorld({ isGM: true, tiles: [tile] });
    const { openLocally } = await import("../src/api");
    await openLocally(tile);
    expect(source.sheet.render).toHaveBeenCalled();
  });
});

describe("revealing a pin without access", () => {
  it("tells the GM once that the sheet will refuse", async () => {
    tile = pinned("pin", { kind: "hidden", ownershipSync: { enabled: false, level: 2 } });
    world = installWorld({ isGM: true, tiles: [tile] });
    const { setAudience } = await import("../src/api");
    const pin = tile.flags[MODULE_ID][FLAGS.PIN];
    await setAudience(tile, { ...pin.audience, kind: "everyone" });
    expect(world.notifications.map((n) => n.type)).toContain("info");
  });

  it("says nothing for a prop, which reads in place whatever the ownership says", async () => {
    tile = pinned("prop", { kind: "hidden", ownershipSync: { enabled: false, level: 2 } });
    world = installWorld({ isGM: true, tiles: [tile] });
    const { setAudience } = await import("../src/api");
    const pin = tile.flags[MODULE_ID][FLAGS.PIN];
    await setAudience(tile, { ...pin.audience, kind: "everyone" });
    expect(world.notifications).toEqual([]);
  });
});

describe("flash", () => {
  it("pings every client for a visible pin", async () => {
    tile = pinned("prop");
    world = installWorld({ isGM: true, tiles: [tile] });
    world.canvas.scene.id = "s1";
    world.canvas.ping = vi.fn();
    world.canvas.controls = { handlePing: vi.fn() };
    const { flash } = await import("../src/api");
    flash(tile);
    // The document's point IS the centre; the ping lands on it. The options are stated,
    // never left to core: it reads a held Shift as "pull every view" (K11). This asserted
    // the bare `ping(origin)` that let it.
    expect(world.canvas.ping).toHaveBeenCalledWith({ x: 0, y: 0 }, { pull: false, style: "pulse" });
    expect(world.canvas.controls.handlePing).not.toHaveBeenCalled();
  });

  it("pings this client only for a hidden pin, so players are not shown where it is", async () => {
    tile = pinned("prop");
    tile.hidden = true;
    world = installWorld({ isGM: true, tiles: [tile] });
    world.canvas.scene.id = "s1";
    world.canvas.ping = vi.fn();
    world.canvas.controls = { handlePing: vi.fn() };
    const { flash } = await import("../src/api");
    flash(tile);
    expect(world.canvas.ping).not.toHaveBeenCalled();
    // With the viewed scene's id, which core requires to draw anything at all: this
    // asserted only that it was called, and it was called with `{}` and drew nothing.
    expect(world.canvas.controls.handlePing).toHaveBeenCalledWith(
      world.game.user,
      { x: 0, y: 0 },
      { scene: "s1", style: "pulse" }
    );
  });

  it("says so rather than leaking when this build cannot ping locally", async () => {
    tile = pinned("prop");
    tile.hidden = true;
    world = installWorld({ isGM: true, tiles: [tile] });
    world.canvas.ping = vi.fn();
    world.canvas.controls = {};
    const { flash } = await import("../src/api");
    flash(tile);
    expect(world.canvas.ping).not.toHaveBeenCalled();
    expect(world.notifications.map((n) => n.type)).toContain("warn");
  });
});
