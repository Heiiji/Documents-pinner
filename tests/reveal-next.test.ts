/**
 * @vitest-environment jsdom
 *
 * Reveal next: the Pinboard's order has always been called the reveal order, and nothing
 * consumed it. `N` on the board, a footer button naming what goes out, and a global
 * binding that works with the board closed — all one verb, `api.revealNext`.
 *
 * Through the real verb, the real board and the real keybinding, over tiles whose writes
 * land with core's update semantics, and a canvas whose ping reads the keyboard the way
 * core's does — so "Shift held" can be asserted not to pull.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpAudience } from "../src/types/dp";
import {
  contentOf,
  fakeTile,
  holdModifier,
  installWorld,
  recordedPings,
  uninstallWorld,
} from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

function pinnedTile(id: string, sort: number, audience: Partial<DpAudience>, elevation = 0) {
  const tile = fakeTile({
    id,
    uuid: `Scene.s1.Tile.${id}`,
    sort,
    elevation,
    x: 400 + sort,
    y: 300,
    hidden: (audience.kind ?? "hidden") === "hidden",
  });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        display: { ...defaultPin().display, label: `Pin ${id}` },
        audience: { ...defaultPin().audience, ...audience },
      },
    },
  };
  return tile;
}

const stored = (tile: any): DpAudience => tile.flags[MODULE_ID][FLAGS.PIN].audience;
const HIDDEN: Partial<DpAudience> = { kind: "hidden" };
const ALI: Partial<DpAudience> = { kind: "hidden", restore: { kind: "selected", users: ["ali"] } };

let world: ReturnType<typeof installWorld>;
let tiles: any[];
let api: typeof import("../src/api");

async function setup(list: any[], isGM = true) {
  vi.resetModules();
  document.body.innerHTML = "";
  tiles = list;
  world = installWorld({ isGM, tiles });
  world.canvas.scene.id = "s1";
  world.game.i18n.format = (key: string, data: Record<string, unknown>) =>
    `${key} ${Object.entries(data)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ")}`;
  api = await import("../src/api");
}

afterEach(() => uninstallWorld());

describe("api.revealNext", () => {
  it("walks the hidden pins in sort order, each to the players it remembers, and says when it is done", async () => {
    await setup([
      pinnedTile("t1", 0, { kind: "everyone" }),
      pinnedTile("late", 20, HIDDEN),
      pinnedTile("t2", 10, ALI),
    ]);
    const first = await api.revealNext(world.canvas.scene);

    expect([first.doc?.id, first.left]).toEqual(["t2", 1]);
    expect(stored(tiles[2])).toMatchObject({ kind: "selected", users: ["ali"], restore: null });
    expect(api.canUserSee(tiles[2], "ali")).toBe(true);
    expect(api.canUserSee(tiles[2], "ben")).toBe(false);
    // Only the pin it revealed was touched.
    expect(tiles[0].updates).toEqual([]);
    expect(tiles[1].updates).toEqual([]);

    const second = await api.revealNext(world.canvas.scene);
    expect([second.doc?.id, second.left]).toEqual(["late", 0]);
    expect(await api.revealNext(world.canvas.scene)).toEqual({ doc: null, left: 0 });
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.revealNextNone"]);
  });

  it("never toggles: with nothing hidden, two presses write nothing and say so once", async () => {
    await setup([pinnedTile("t1", 0, { kind: "everyone" })]);
    await Promise.all([api.revealNext(world.canvas.scene), api.revealNext(world.canvas.scene)]);
    expect(tiles[0].updates).toEqual([]);
    expect(stored(tiles[0]).kind).toBe("everyone");
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.revealNextNone"]);
  });

  it("tells 'nothing hidden in this view' from 'nothing hidden'", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN, 20)]);
    const result = await api.revealNext(world.canvas.scene, {
      filter: "all",
      search: "",
      level: 0,
    });
    expect(result.doc).toBeNull();
    expect(tiles[0].updates).toEqual([]);
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.revealNextNoneInView"]);
  });

  it("shares one reveal between two presses faster than a write: one row, one ping", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN), pinnedTile("t2", 10, HIDDEN)]);
    const first = api.revealNext(world.canvas.scene);
    const second = api.revealNext(world.canvas.scene);
    expect(second).toBe(first);
    expect(await second).toEqual({ doc: tiles[0], left: 1 });
    expect(tiles[0].updates).toHaveLength(1);
    expect(recordedPings().filter((ping) => ping.kind === "broadcast")).toHaveLength(1);

    // Once it has landed, the next press moves on.
    expect((await api.revealNext(world.canvas.scene)).doc).toBe(tiles[1]);
  });

  it("does nothing for a player", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)], false);
    expect(await api.revealNext(world.canvas.scene)).toEqual({ doc: null, left: 0 });
    expect(tiles[0].updates).toEqual([]);
  });
});

/** K1: a ping reaches every client only for an audience of everyone, and never pulls. */
describe("where Reveal next points", () => {
  it("pulses every client for a pin revealed to everyone, pulling nobody though Shift is held", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)]);
    holdModifier("Shift");
    await api.revealNext(world.canvas.scene);

    const broadcasts = recordedPings().filter((p) => p.kind === "broadcast");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].data).toMatchObject({ scene: "s1", pull: false, style: "pulse" });
    expect(recordedPings().some((p) => p.kind === "pan")).toBe(false);
    // And the GM's own card pulses, which covers the ping on the DOM tier.
    expect(world.hooks).toContainEqual({ name: `${MODULE_ID}.flash`, args: [tiles[0]] });
  });

  it("points at a pin for one player on the GM's screen alone", async () => {
    await setup([pinnedTile("t1", 0, ALI)]);
    await api.revealNext(world.canvas.scene);

    expect(recordedPings().map((p) => p.kind)).toEqual(["local"]);
    expect(recordedPings()[0].data).toMatchObject({ scene: "s1", style: "pulse" });
  });

  it("points only once the reveal has landed", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)]);
    const order: string[] = [];
    const update = tiles[0].update;
    tiles[0].update = async (...args: any[]) => {
      const result = await update(...args);
      order.push(`written, hidden=${tiles[0].hidden}`);
      return result;
    };
    const ping = world.canvas.ping;
    world.canvas.ping = (...args: any[]) => {
      order.push("pinged");
      return ping(...args);
    };
    await api.revealNext(world.canvas.scene);
    expect(order).toEqual(["written, hidden=false", "pinged"]);
  });
});

describe("N on the Pinboard", () => {
  let board: any;
  const root = () => contentOf(board).querySelector<HTMLElement>(".dp-board")!;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const press = async (init: KeyboardEventInit) => {
    root().dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, ...init }));
    await flush();
  };

  beforeEach(async () => {
    await setup([
      pinnedTile("t1", 0, { kind: "everyone" }),
      pinnedTile("t2", 10, ALI),
      pinnedTile("t3", 20, HIDDEN),
      pinnedTile("t4", 30, HIDDEN),
    ]);
    const { definePinboard } = await import("../src/apps/Pinboard");
    board = new (definePinboard())();
    document.body.appendChild(contentOf(board));
    await board.render();
  });

  it("names what goes out next in the footer, and says, disabled, when nothing is left", async () => {
    const button = () => root().querySelector<HTMLButtonElement>('[data-action="revealNext"]')!;
    expect(button().closest(".dp-board__foot")).not.toBeNull();
    expect(button().textContent).toBe("DP.board.revealNext name=Pin t2");
    expect(button().disabled).toBe(false);
    // Where "Reveal all" used to be.
    expect(root().querySelector('.dp-board__foot [data-action="revealAll"]')).toBeNull();

    // Nothing hidden in this view, though there is in the scene…
    board.query = { filter: "visible", search: "", level: null };
    await board.render();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("DP.board.revealNextNoneInView");

    // …and nothing hidden at all.
    for (const tile of tiles) tile.flags[MODULE_ID][FLAGS.PIN].audience.kind = "everyone";
    for (const tile of tiles) tile.hidden = false;
    await board.render();
    expect(button().textContent).toBe("DP.board.revealNextNone");
  });

  it("reveals the next row on N, and the one after from the footer, saying so and moving the focus on", async () => {
    await press({});

    expect(stored(tiles[1])).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(root().querySelector('[role="status"]')!.textContent).toBe(
      "DP.board.statusRevealed name=Pin t2 count=2"
    );
    expect(board.focusedId).toBe("t3");
    expect(root().querySelector('[data-action="revealNext"]')!.textContent).toBe(
      "DP.board.revealNext name=Pin t3"
    );

    await board.dispatch("revealNext");
    await flush();
    expect(stored(tiles[2]).kind).toBe("everyone");
    expect(stored(tiles[3]).kind).toBe("hidden");
  });

  it("ignores a held key's repeats, or holding N would reveal the scene; and N with Ctrl, ⌘ or Alt", async () => {
    await press({ repeat: true });
    await press({ repeat: true });
    await press({ ctrlKey: true });
    await press({ metaKey: true });
    await press({ altKey: true });
    expect(tiles.map((tile) => tile.updates.length)).toEqual([0, 0, 0, 0]);
  });
});

describe("the revealNext keybinding", () => {
  async function binding() {
    const { registerKeybindings } = await import("../src/ui/keybindings");
    registerKeybindings();
    return world.game.keybindings.registered.find((r: any) => r.key === "revealNext")!;
  }

  it("is registered unbound, for the GM only, at core's normal precedence, and stands down with no scene", async () => {
    await setup([]);
    const found = await binding();
    expect(found.options.editable).toEqual([]);
    expect(found.options.restricted).toBe(true);
    expect(found.options).not.toHaveProperty("precedence");

    world.canvas.scene = null;
    expect(found.options.onDown()).toBe(false);
  });

  it("reveals the next pin with no Pinboard open, and says what it revealed", async () => {
    await setup([pinnedTile("t1", 0, ALI), pinnedTile("t2", 10, HIDDEN)]);
    const found = await binding();
    expect(found.options.onDown()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored(tiles[0])).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(stored(tiles[1]).kind).toBe("hidden");
    expect(world.notifications.map((n) => n.message)).toEqual([
      "DP.notice.revealNext name=Pin t1 count=1",
    ]);
  });

  // The board's N runs the same method, so this is also where N is held to the board's view.
  it("plays an open Pinboard's own script: its view, its status line, its focus", async () => {
    await setup([
      pinnedTile("t1", 0, ALI),
      pinnedTile("t2", 10, HIDDEN),
      pinnedTile("t3", 20, HIDDEN),
    ]);
    const { openPinboard } = await import("../src/apps/Pinboard");
    const board = openPinboard();
    document.body.appendChild(contentOf(board));
    board.query = { filter: "all", search: "t2", level: null };
    await board.render();

    const found = await binding();
    expect(found.options.onDown()).toBe(true);
    await vi.waitFor(() =>
      expect(contentOf(board).querySelector('[role="status"]')!.textContent).toBe(
        "DP.board.statusRevealed name=Pin t2 count=0"
      )
    );
    expect(stored(tiles[1]).kind).toBe("everyone");
    expect(stored(tiles[0]).kind).toBe("hidden");
    // The board said it; a toast as well would say it twice.
    expect(world.notifications).toEqual([]);
  });

  it("says a reveal once when pressed twice while it is still writing", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN), pinnedTile("t2", 10, HIDDEN)]);
    const found = await binding();
    found.options.onDown();
    found.options.onDown();
    await vi.waitFor(() => expect(world.notifications).not.toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(world.notifications.map((n) => n.message)).toEqual([
      "DP.notice.revealNext name=Pin t1 count=1",
    ]);
    expect(stored(tiles[1]).kind).toBe("hidden");
  });
});
