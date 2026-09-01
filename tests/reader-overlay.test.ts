/**
 * @vitest-environment jsdom
 *
 * Acceptance criterion 17, verbatim: "with ownership sync off, a player without
 * permission still opens the viewer". DESIGN §3.1 says the same thing — ownership sync
 * is a convenience, not a security necessity, and with it off the module opens its own
 * read-only viewer instead.
 *
 * The reader refused on `!card.readable`, so the prop was visible, the cursor said
 * clickable, and the click did nothing: no reader, no sheet, no notification. And the
 * card had ALREADY been built and secret-stripped for that user at the point of refusal,
 * so the module was withholding content it was holding in its hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const card = {
  html:
    '<div class="dp-card"><div class="dp-card__sheet">' +
    '<div class="dp-card__body"><p>The Duke is dead.</p></div></div></div>',
  title: "The Duke's Letter",
  readable: false,
  contentHash: "h",
  missing: false,
  naturalHeight: null,
};

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => card),
}));

vi.mock("../src/canvas/PropManager", () => ({
  propManager: () => ({ setFocused: vi.fn() }),
}));

let tile: any;
let world: ReturnType<typeof installWorld>;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';

  tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        audience: {
          ...defaultPin().audience,
          kind: "everyone",
          ownershipSync: { enabled: false, level: 2 },
        },
      },
    },
  };
  // A player, not the GM: the GM escape hatch is not what criterion 17 is about.
  world = installWorld({ isGM: false, tiles: [tile] });
  card.readable = false;
  card.missing = false;
});

afterEach(() => uninstallWorld());

/** The OPEN reader: one on its way out is still in the document while it fades. */
const reader = () => document.querySelector<HTMLElement>(".dp-reader:not(.dp-reader--out)");

describe("the focus reader", () => {
  it("opens for a player who can see the prop but lacks OBSERVER on the source", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    expect(reader()).not.toBeNull();
    expect(reader()!.innerHTML).toContain("The Duke is dead.");
  });

  it("still opens when the user CAN read it — the permitted path is unchanged", async () => {
    card.readable = true;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    expect(reader()).not.toBeNull();
  });

  it("refuses only a genuinely missing source, and says so", async () => {
    card.missing = true;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    expect(reader()).toBeNull();
    expect(world.notifications.map((n) => n.type)).toContain("warn");
  });

  it("says there is more below while the body can still scroll, and stops at the end", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    const body = reader()!.querySelector<HTMLElement>(".dp-card__body")!;

    // jsdom lays nothing out, so the scroll geometry is stated.
    let scrollTop = 0;
    Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(body, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => (scrollTop = v),
      configurable: true,
    });

    body.dispatchEvent(new Event("scroll"));
    expect(reader()!.dataset.dpMore).toBe("true");

    body.scrollTop = 600;
    body.dispatchEvent(new Event("scroll"));
    expect(reader()!.dataset.dpMore).toBe("false");
  });

  it("leaves with its exit class, and is gone once the exit has run", async () => {
    const { openReader, closeReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    closeReader();

    // The state is reset at once; the node dissolves.
    expect(reader()).toBeNull();
    expect(document.querySelector(".dp-reader--out")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector(".dp-reader")).toBeNull();
  });

  it("opens a pin-mode anchor at a readable sheet centred on it, not one grid square", async () => {
    tile.flags["documents-pinner"].pin.mode = "pin";
    tile.width = 100;
    tile.height = 100;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // Centred on the pin's own point, which is the tile's centre.
    expect(reader()!.style.width).toBe("400px");
    expect(reader()!.style.height).toBe("566px");
    expect(reader()!.style.left).toBe("-200px");
    expect(reader()!.style.top).toBe("-283px");
  });

  it("brings the view in first when the type is too small to read, and not otherwise", async () => {
    const pans: any[] = [];
    world.canvas.animatePan = async (target: any) => {
      pans.push(target);
    };
    // A natural-size prop derives ~15.4px type; zoomed well out it reads as 4.6px.
    tile.width = 400;
    tile.height = 560;
    world.canvas.stage.worldTransform.a = 0.3;
    world.canvas.stage.worldTransform.d = 0.3;
    const { openReader, closeReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    expect(pans).toHaveLength(1);
    expect(pans[0].scale).toBeGreaterThan(0.3);
    expect(pans[0].scale).toBeLessThanOrEqual(3);
    expect(reader()).not.toBeNull();

    closeReader();
    world.canvas.stage.worldTransform.a = 1;
    world.canvas.stage.worldTransform.d = 1;
    await openReader(tile);
    expect(pans).toHaveLength(1);
  });

  it("ignores a press on the prop being read, so the hit layer's tap can toggle it", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    const board = document.getElementById("board")!;

    // Inside the 200x280 prop centred on the origin, which spans -100..100 by -140..140.
    board.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }));
    expect(reader()).not.toBeNull();

    // Just beside it — inside the old reading of the point as a corner, and not the prop.
    board.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 150, clientY: 150 }));
    expect(reader()).toBeNull();
  });

  it("closes on a second click, which is what a click on what you are reading means", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    await openReader(tile);

    expect(reader()).toBeNull();
  });
});
