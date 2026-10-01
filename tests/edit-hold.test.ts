/**
 * @vitest-environment jsdom
 *
 * The Studio says when the table is watching, and can hide the pin while the GM edits.
 *
 * Every Studio control saves as it moves. On a revealed prop the players watched the GM
 * cycle papers, sizes and effects. The banner says so; "Hide while I edit" hides the pin
 * and reveals it again, to the same players, when the Studio closes or the GM asks.
 *
 * The one thing it must never do is strand a pin hidden. So the hold is written to a
 * client setting BEFORE the hide, and ended on close, on the second click, and on `ready`
 * after a reload — and a pin the GM revealed or re-hid by hand meanwhile is left alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpAudience } from "../src/types/dp";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

const UUID = "Scene.s1.Tile.t1";
const FOR_ALI: Partial<DpAudience> = { kind: "selected", users: ["ali"] };

function pinnedTile(audience: Partial<DpAudience>) {
  const tile = fakeTile({
    id: "t1",
    uuid: UUID,
    width: 400,
    height: 560,
    hidden: audience.kind === "hidden",
  });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        audience: { ...defaultPin().audience, ...audience },
      },
    },
  };
  return tile;
}

const stored = (): DpAudience => tile.flags[MODULE_ID][FLAGS.PIN].audience;
const holds = () => world.game.settings.get(MODULE_ID, "editHolds");
const banner = () => contentOf(studio).querySelector<HTMLElement>(".dp-studio__live");

let world: ReturnType<typeof installWorld>;
let tile: any;
let studio: any;
let order: string[];

async function setup(audience: Partial<DpAudience>, settings: Record<string, unknown> = {}) {
  vi.resetModules();
  document.body.innerHTML = "";
  tile = pinnedTile(audience);
  world = installWorld({ isGM: true, tiles: [tile], settings });
  world.game.i18n.format = (key: string, data: Record<string, unknown>) =>
    `${key} ${Object.entries(data)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ")}`;
  (globalThis as any).fromUuidSync = (uuid: string) => (uuid === UUID ? tile : null);

  // One record of the two writes a hold makes, in the order they land.
  order = [];
  const set = world.game.settings.set;
  world.game.settings.set = async (scope: string, key: string, value: unknown) => {
    order.push(`setting ${key}: ${JSON.stringify(value)}`);
    return set(scope, key, value);
  };
  const update = tile.update;
  tile.update = async (changes: any, context?: unknown) => {
    order.push(`tile hidden=${changes.hidden}`);
    return update(changes, context);
  };
}

async function openStudio() {
  const { definePinStudio } = await import("../src/apps/PinStudio");
  studio = new (definePinStudio())();
  studio.doc = tile;
  studio.tab = "appearance";
  document.body.appendChild(contentOf(studio));
  await studio.render();
  return studio;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete (globalThis as any).fromUuidSync;
  uninstallWorld();
});

describe("Hide while I edit", () => {
  beforeEach(() => setup(FOR_ALI));

  it("is offered by a banner above the tabs that says how many players are watching", async () => {
    await openStudio();
    expect(banner()!.textContent).toContain("DP.studio.liveBanner count=1");
    expect(banner()!.nextElementSibling?.classList.contains("dp-studio__tabs")).toBe(true);
  });

  it("writes the hold, THEN hides the pin, and reveals it again to the same players on close", async () => {
    await openStudio();
    await studio.dispatch("holdForEdit");
    await settle();

    expect(stored()).toMatchObject({
      kind: "hidden",
      restore: { kind: "selected", users: ["ali"] },
    });
    expect(tile.hidden).toBe(true);
    expect(holds()).toEqual([
      { anchor: UUID, world: null, restore: { kind: "selected", users: ["ali"] } },
    ]);
    expect(order[0]).toMatch(/^setting editHolds: \[\{"anchor"/);
    expect(order[1]).toBe("tile hidden=true");
    expect(banner()!.textContent).toContain("DP.studio.holdBanner");

    await studio.close();
    await vi.waitFor(() => expect(holds()).toEqual([]));
    expect(stored()).toMatchObject({ kind: "selected", users: ["ali"], restore: null });
    expect(tile.hidden).toBe(false);
  });

  it("keeps the keyboard on the banner as the pin hides and shows again", async () => {
    await openStudio();
    const button = (action: string) =>
      contentOf(studio).querySelector<HTMLElement>(`[data-action="${action}"]`)!;

    button("holdForEdit").focus();
    await studio.dispatch("holdForEdit", button("holdForEdit"));
    await settle();
    expect(document.activeElement).toBe(button("resumeEdit"));

    await studio.dispatch("resumeEdit", button("resumeEdit"));
    await vi.waitFor(() => expect(tile.hidden).toBe(false));
    await studio.render();
    expect(document.activeElement).toBe(button("holdForEdit"));
  });

  it("leaves no hold behind when the hide does not land", async () => {
    await openStudio();
    // A write core refuses: it resolves, and nothing changes.
    tile.update = async (changes: any) => {
      order.push(`tile hidden=${changes.hidden}`);
      return undefined;
    };
    await studio.dispatch("holdForEdit");
    await settle();

    expect(stored().kind).toBe("selected");
    expect(holds()).toEqual([]);
    expect(studio.hold).toBeNull();
    expect(world.notifications.map((n) => n.type)).toEqual(["error"]);
  });

  it("still ends the hold on close when the hide throws", async () => {
    await openStudio();
    tile.update = async () => {
      throw new Error("the server went away");
    };
    await studio.dispatch("holdForEdit");
    await settle();
    expect(world.notifications.map((n) => n.type)).toEqual(["error"]);

    await studio.close();
    await vi.waitFor(() => expect(holds()).toEqual([]));
    expect(stored().kind).toBe("selected");
  });

  it("ends the hold after the hide, when the Studio closes in the middle of it", async () => {
    await openStudio();
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const update = tile.update;
    tile.update = async (changes: any, context?: unknown) => {
      await landed;
      return update(changes, context);
    };
    studio.dispatch("holdForEdit");
    await vi.waitFor(() => expect(studio.hold).not.toBeNull());

    await studio.close();
    land();
    await vi.waitFor(() => expect(holds()).toEqual([]));
    await settle();
    expect(stored()).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(tile.hidden).toBe(false);
  });

  it("holds nothing when the Studio closes before the hold is written", async () => {
    await openStudio();
    studio.dispatch("holdForEdit");
    await studio.close();
    await settle();
    await settle();
    expect(holds()).toEqual([]);
    expect(stored().kind).toBe("selected");
    expect(tile.updates).toEqual([]);
  });

  it("reveals it again on the second click", async () => {
    await openStudio();
    await studio.dispatch("holdForEdit");
    await settle();
    studio.dispatch("resumeEdit");
    await vi.waitFor(() => expect(holds()).toEqual([]));

    expect(stored()).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(banner()!.textContent).toContain("DP.studio.liveBanner count=1");
    // And closing afterwards has nothing left to do.
    const writes = tile.updates.length;
    await studio.close();
    await settle();
    expect(tile.updates).toHaveLength(writes);
  });

  // A pin revealed again by hand and left showing is the other half of this rule, and
  // the pure one's (`audience-reveal`): a showing pin gives the close nothing to write.
  it("leaves alone a pin hidden again by hand over a different audience, and forgets the hold", async () => {
    const api = await import("../src/api");
    await openStudio();
    await studio.dispatch("holdForEdit");
    await settle();
    await api.setAudience(tile, { ...stored(), kind: "everyone", users: [], restore: null });
    await api.toggleVisibility(tile);
    await studio.close();
    await vi.waitFor(() => expect(holds()).toEqual([]));

    expect(stored()).toMatchObject({ kind: "hidden", restore: { kind: "everyone" } });
  });

  /**
   * Shown again and hidden again by hand, the pin remembers exactly what the hold
   * remembered, so "is it still as the hold left it?" answers yes — and the close used to
   * reveal it against the GM's last word. Once it has shown, the hold is over.
   */
  describe("a pin shown again by hand, then hidden again by hand", () => {
    const hiddenForAli = { kind: "hidden", restore: { kind: "selected", users: ["ali"] } };

    async function showThenHide() {
      const api = await import("../src/api");
      await openStudio();
      await studio.dispatch("holdForEdit");
      await settle();
      await api.toggleVisibility(tile);
      // What `refreshStudios` does when the tile's update lands.
      await studio.render();
      await api.toggleVisibility(tile);
      await studio.render();
    }

    it("stays hidden when the Studio closes, with no hold left for a reload to resume", async () => {
      await showThenHide();
      expect(stored()).toMatchObject(hiddenForAli);
      // What the `ready` sweep reads: nothing, so a reload has nothing to reveal either.
      expect(holds()).toEqual([]);
      // Hidden, and held by nobody: no banner at all.
      expect(banner()).toBeNull();

      await studio.close();
      await settle();
      await settle();
      expect(stored()).toMatchObject(hiddenForAli);
      expect(tile.hidden).toBe(true);
      expect(holds()).toEqual([]);
    });

    it("stays hidden when the chips did it", async () => {
      await setup({ kind: "everyone" });
      await openStudio();
      await studio.dispatch("holdForEdit");
      await settle();
      studio.tab = "audience";
      await studio.render();

      const chip = () =>
        contentOf(studio).querySelector<HTMLElement>('.dp-chip[data-dp-user="ali"]')!;
      // Ali alone sees it; then nobody does, which hides it remembering everyone — the
      // very audience the hold remembered.
      chip().click();
      await vi.waitFor(() => expect(stored()).toMatchObject({ kind: "selected" }));
      await settle();
      chip().click();
      await vi.waitFor(() => expect(stored().kind).toBe("hidden"));
      expect(stored().restore).toMatchObject({ kind: "everyone" });

      await studio.close();
      await settle();
      await settle();
      expect(stored().kind).toBe("hidden");
      expect(holds()).toEqual([]);
    });
  });
});

/** A reload between the hide and the close: the Studio never gets to end its hold. */
describe("the ready sweep", () => {
  const HELD: Partial<DpAudience> = {
    kind: "hidden",
    restore: { kind: "selected", users: ["ali"] },
  };
  const hold = (over: Record<string, unknown> = {}) => ({
    anchor: UUID,
    world: null,
    restore: { kind: "selected", users: ["ali"] },
    ...over,
  });

  it("reveals the pin again, clears the holds in one write, and says how many", async () => {
    await setup(HELD, { editHolds: [hold()] });
    const { resumeEditHolds } = await import("../src/apps/PinStudio");
    expect(await resumeEditHolds()).toBe(1);

    expect(stored()).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(holds()).toEqual([]);
    expect(order.filter((entry) => entry.startsWith("setting"))).toHaveLength(1);
    expect(world.notifications).toEqual([
      { type: "info", message: "DP.notice.editHoldsResumed count=1" },
    ]);
  });

  it("drops the hold of a pin deleted meanwhile, and throws nothing", async () => {
    await setup(HELD, { editHolds: [hold({ anchor: "Scene.s1.Tile.gone" })] });
    const { resumeEditHolds } = await import("../src/apps/PinStudio");
    await expect(resumeEditHolds()).resolves.toBe(0);
    expect(holds()).toEqual([]);
    expect(world.notifications).toEqual([]);
  });

  it("leaves alone a pin the GM changed since", async () => {
    await setup({ kind: "everyone" }, { editHolds: [hold()] });
    const { resumeEditHolds } = await import("../src/apps/PinStudio");
    expect(await resumeEditHolds()).toBe(0);
    expect(stored().kind).toBe("everyone");
    expect(tile.updates).toEqual([]);
    expect(holds()).toEqual([]);
  });

  /**
   * Whether the pin is still as the hold left it was decided from the payload read before
   * the resume's turn in the write queue (A29): a chip click still landing was then written
   * over by the audience the hold remembered — the GM showed the pin to Ben, and the resume
   * put it back to Ali.
   */
  it("keeps a chip click still landing as it resumes", async () => {
    await setup(HELD, { editHolds: [hold()] });
    // The click's write is in flight, held until the sweep has started.
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const update = tile.update;
    tile.update = async (changes: any, context?: unknown) => {
      await landed;
      return update(changes, context);
    };
    const api = await import("../src/api");
    const { resumeEditHolds } = await import("../src/apps/PinStudio");

    const click = api.setUserVisible(tile, "ben", true);
    const resumed = resumeEditHolds();
    land();
    await click;

    expect(await resumed).toBe(0);
    expect(stored()).toMatchObject({ kind: "selected", users: ["ben"] });
    expect(tile.hidden).toBe(false);
    // One write, the click's: the resume found the pin showing and wrote nothing.
    expect(order.filter((entry) => entry.startsWith("tile"))).toHaveLength(1);
    expect(holds()).toEqual([]);
    expect(world.notifications).toEqual([]);
  });

  it("keeps a hold of another world for that world's sweep", async () => {
    const elsewhere = hold({ world: "another", anchor: "Scene.x.Tile.y" });
    await setup(HELD, { editHolds: [hold({ world: "this" }), elsewhere] });
    world.game.world = { id: "this" };
    const { resumeEditHolds } = await import("../src/apps/PinStudio");
    expect(await resumeEditHolds()).toBe(1);
    expect(holds()).toEqual([elsewhere]);
  });

  it("sweeps nothing on a player's client", async () => {
    await setup(HELD, { editHolds: [hold()] });
    world.game.user = world.game.users.get("ali");
    const { resumeEditHolds } = await import("../src/apps/PinStudio");
    expect(await resumeEditHolds()).toBe(0);
    expect(holds()).toEqual([hold()]);
  });
});
