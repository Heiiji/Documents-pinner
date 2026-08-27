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
  html: '<div class="dp-card"><p>The Duke is dead.</p></div>',
  title: "The Duke's Letter",
  readable: false,
  contentHash: "h",
  missing: false,
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
        audience: { ...defaultPin().audience, kind: "everyone", ownershipSync: { enabled: false, level: 2 } },
      },
    },
  };
  // A player, not the GM: the GM escape hatch is not what criterion 17 is about.
  world = installWorld({ isGM: false, tiles: [tile] });
  card.readable = false;
  card.missing = false;
});

afterEach(() => uninstallWorld());

const reader = () => document.querySelector<HTMLElement>(".dp-reader");

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

  it("closes on a second click, which is what a click on what you are reading means", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    await openReader(tile);

    expect(reader()).toBeNull();
  });
});
