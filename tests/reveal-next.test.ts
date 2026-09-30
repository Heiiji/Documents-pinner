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
  it("reveals the first hidden pin in order to the players it remembers", async () => {
    await setup([
      pinnedTile("t1", 0, { kind: "everyone" }),
      pinnedTile("t2", 10, ALI),
      pinnedTile("t3", 20, HIDDEN),
    ]);
    const { doc, left } = await api.revealNext(world.canvas.scene);

    expect(doc).toBe(tiles[1]);
    expect(left).toBe(1);
    expect(stored(tiles[1])).toMatchObject({ kind: "selected", users: ["ali"], restore: null });
    expect(api.canUserSee(tiles[1], "ali")).toBe(true);
    expect(api.canUserSee(tiles[1], "ben")).toBe(false);
    // Only the pin it revealed was touched.
    expect(tiles[0].updates).toEqual([]);
    expect(tiles[2].updates).toEqual([]);
  });

  it("walks the script in sort order and stops, saying so, at its end", async () => {
    await setup([pinnedTile("late", 20, HIDDEN), pinnedTile("early", 10, HIDDEN)]);
    const first = await api.revealNext(world.canvas.scene);
    const second = await api.revealNext(world.canvas.scene);
    const third = await api.revealNext(world.canvas.scene);

    expect([first.doc?.id, first.left]).toEqual(["early", 1]);
    expect([second.doc?.id, second.left]).toEqual(["late", 0]);
    expect(third).toEqual({ doc: null, left: 0 });
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.revealNextNone"]);
  });

  it("never toggles: with nothing hidden it writes nothing and hides nothing", async () => {
    await setup([pinnedTile("t1", 0, { kind: "everyone" })]);
    await api.revealNext(world.canvas.scene);
    expect(tiles[0].updates).toEqual([]);
    expect(stored(tiles[0]).kind).toBe("everyone");
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

  it("does nothing for a player", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)], false);
    expect(await api.revealNext(world.canvas.scene)).toEqual({ doc: null, left: 0 });
    expect(tiles[0].updates).toEqual([]);
  });
});

/** K1: a ping reaches every client only for an audience of everyone, and never pulls. */
describe("where Reveal next points", () => {
  it("pulses every client for a pin revealed to everyone, pulling nobody", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)]);
    await api.revealNext(world.canvas.scene);

    const broadcasts = recordedPings().filter((p) => p.kind === "broadcast");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].data).toMatchObject({ scene: "s1", pull: false, style: "pulse" });
    expect(recordedPings().some((p) => p.kind === "pan")).toBe(false);
  });

  it("points at a pin for one player on the GM's screen alone", async () => {
    await setup([pinnedTile("t1", 0, ALI)]);
    await api.revealNext(world.canvas.scene);

    expect(recordedPings().map((p) => p.kind)).toEqual(["local"]);
    expect(recordedPings()[0].data).toMatchObject({ scene: "s1", style: "pulse" });
  });

  it("does not pull every view because the GM happened to hold Shift", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)]);
    holdModifier("Shift");
    await api.revealNext(world.canvas.scene);

    const broadcast = recordedPings().find((p) => p.kind === "broadcast");
    expect(broadcast?.data.pull).toBe(false);
    expect(recordedPings().some((p) => p.kind === "pan")).toBe(false);
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

  it("pulses the GM's own card, which covers the ping on the DOM tier", async () => {
    await setup([pinnedTile("t1", 0, HIDDEN)]);
    await api.revealNext(world.canvas.scene);
    expect(world.hooks).toContainEqual({ name: `${MODULE_ID}.flash`, args: [tiles[0]] });
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

  it("names what goes out next in the footer, where Reveal all used to be", () => {
    const button = root().querySelector<HTMLButtonElement>('[data-action="revealNext"]')!;
    expect(button.closest(".dp-board__foot")).not.toBeNull();
    expect(button.textContent).toBe("DP.board.revealNext name=Pin t2");
    expect(button.disabled).toBe(false);
    expect(root().querySelector('.dp-board__foot [data-action="revealAll"]')).toBeNull();
  });

  it("reveals the next row, says what it did, and moves the focus on", async () => {
    await press({});

    expect(stored(tiles[1])).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(root().querySelector('[role="status"]')!.textContent).toBe(
      "DP.board.statusRevealed name=Pin t2 count=2"
    );
    expect(board.focusedId).toBe("t3");
    expect(root().querySelector('[data-action="revealNext"]')!.textContent).toBe(
      "DP.board.revealNext name=Pin t3"
    );
  });

  it("walks the hidden rows in order, one per N, and says when the script is done", async () => {
    await press({});
    await press({});
    await press({});
    expect(tiles.map((tile) => stored(tile).kind)).toEqual([
      "everyone",
      "selected",
      "everyone",
      "everyone",
    ]);
    expect(root().querySelector('[role="status"]')!.textContent).toBe(
      "DP.board.statusRevealed name=Pin t4 count=0"
    );

    await press({});
    expect(tiles.map((tile) => tile.updates.length)).toEqual([0, 1, 1, 1]);
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.revealNextNone"]);
  });

  it("reveals from the footer button exactly as from the key", async () => {
    await board.dispatch("revealNext");
    await flush();
    expect(stored(tiles[1]).kind).toBe("selected");
    expect(stored(tiles[2]).kind).toBe("hidden");
  });

  it("ignores a held key's repeats, or holding N would reveal the scene", async () => {
    await press({ repeat: true });
    await press({ repeat: true });
    expect(tiles.map((tile) => tile.updates.length)).toEqual([0, 0, 0, 0]);
  });

  it("leaves N with Ctrl, ⌘ or Alt alone", async () => {
    await press({ ctrlKey: true });
    await press({ metaKey: true });
    await press({ altKey: true });
    expect(tiles.map((tile) => tile.updates.length)).toEqual([0, 0, 0, 0]);
  });

  it("follows the board's own view", async () => {
    board.query = { filter: "all", search: "t4", level: null };
    await board.render();
    await press({});
    expect(stored(tiles[3]).kind).toBe("everyone");
    expect(stored(tiles[1]).kind).toBe("hidden");
  });

  it("says, disabled, when there is nothing left — and when the view is hiding the rest", async () => {
    board.query = { filter: "visible", search: "", level: null };
    await board.render();
    let button = root().querySelector<HTMLButtonElement>('[data-action="revealNext"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("DP.board.revealNextNoneInView");

    for (const tile of tiles) tile.flags[MODULE_ID][FLAGS.PIN].audience.kind = "everyone";
    for (const tile of tiles) tile.hidden = false;
    await board.render();
    button = root().querySelector<HTMLButtonElement>('[data-action="revealNext"]')!;
    expect(button.textContent).toBe("DP.board.revealNextNone");
  });
});

describe("the revealNext keybinding", () => {
  async function binding() {
    const { registerKeybindings } = await import("../src/ui/keybindings");
    registerKeybindings();
    return world.game.keybindings.registered.find((r: any) => r.key === "revealNext")!;
  }

  it("is registered unbound, for the GM only, at core's normal precedence", async () => {
    await setup([]);
    const found = await binding();
    expect(found.options.editable).toEqual([]);
    expect(found.options.restricted).toBe(true);
    expect(found.options).not.toHaveProperty("precedence");
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

  it("stands down with no scene to reveal on", async () => {
    await setup([]);
    const found = await binding();
    world.canvas.scene = null;
    expect(found.options.onDown()).toBe(false);
  });
});
