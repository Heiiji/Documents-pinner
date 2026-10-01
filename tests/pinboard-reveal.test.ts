/**
 * @vitest-environment jsdom
 *
 * The Pinboard's bulk reveal honours each pin's own audience, and "Reveal all" asks.
 *
 * A note for the rogue alone (`selected: [ali]`) was hidden for a beat; at the climax the
 * GM hit "Reveal all" to light up the ritual glyphs, and the rogue's note appeared to the
 * whole table. The same pin revealed with Space would have gone to the rogue: the eye
 * restores the remembered audience, the bulk paths wrote `everyone`. Both now call
 * `revealed`; what it writes for every audience a pin can hold is `audience-reveal`'s table.
 *
 * Driven through the real dispatch path and a scene write that lands on the tiles the
 * way core's does, so the assertions read what a player's client would read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpAudience } from "../src/types/dp";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

const aliOnly = (): Partial<DpAudience> => ({
  kind: "hidden",
  restore: { kind: "selected", users: ["ali"] },
});

function pinnedTile(id: string, audience: Partial<DpAudience>, sort = 0) {
  const tile = fakeTile({
    id,
    uuid: `Scene.s1.Tile.${id}`,
    sort,
    // The store keeps core's field in step with the audience.
    hidden: (audience.kind ?? "hidden") === "hidden",
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

const stored = (tile: any): DpAudience => tile.flags[MODULE_ID][FLAGS.PIN].audience;

let world: ReturnType<typeof installWorld>;
let tiles: any[];
let board: any;
let asked: any[];
/** The module generation the board was loaded with, so its write queue is the one awaited. */
let settled: () => Promise<void>;

async function setup(list: any[]) {
  vi.resetModules();
  tiles = list;
  world = installWorld({ isGM: true, tiles });
  world.game.i18n.format = (key: string, data: Record<string, unknown>) =>
    `${key} ${Object.entries(data)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ")}`;

  // Core's `updateEmbeddedDocuments`: one call, each change applied to its document
  // with the document's own update semantics.
  const scene = world.canvas.scene;
  scene.updates = [];
  scene.updateEmbeddedDocuments = async (_type: string, updates: any[]) => {
    scene.updates.push(updates);
    for (const { _id, ...changes } of updates) {
      await tiles.find((tile) => tile.id === _id)?.update(changes);
    }
    return updates;
  };

  asked = [];
  answer(true);

  ({ settled } = await import("../src/data/PinStore"));
  const { definePinboard } = await import("../src/apps/Pinboard");
  board = new (definePinboard())();
  board.query = { filter: "all", search: "", level: null };
  board.selected = [];
  board.render = vi.fn();
}

/** What the confirmation resolves to; `null` is a dialog closed with its ✕. */
function answer(value: boolean | null) {
  (globalThis as any).foundry.applications.api.DialogV2.confirm = async (options: any) => {
    asked.push(options);
    return value;
  };
}

afterEach(() => uninstallWorld());

describe("the bulk bar's Reveal", () => {
  beforeEach(() => setup([pinnedTile("t1", aliOnly()), pinnedTile("t2", aliOnly(), 10)]));

  it("shows a note for Ali alone to Ali alone, in one scene write, without asking", async () => {
    board.selected = ["t1", "t2"];
    await board.dispatch("bulkReveal");
    await settled();

    expect(stored(tiles[0])).toMatchObject({ kind: "selected", users: ["ali"], restore: null });
    expect(tiles[0].hidden).toBe(false);
    const api = await import("../src/api");
    expect(api.canUserSee(tiles[0], "ali")).toBe(true);
    expect(api.canUserSee(tiles[0], "ben")).toBe(false);
    expect(world.canvas.scene.updates).toHaveLength(1);
    expect(world.canvas.scene.updates[0].map((u: any) => u._id)).toEqual(["t1", "t2"]);
    expect(asked).toEqual([]);
  });
});

/**
 * A revealed icon pin opens its document's sheet, which refuses without access; a prop
 * reads in place. The eye says so when it reveals one with access off. The bulk bar said
 * nothing — the same "I can see it but it won't open", for every pin it touched. It now
 * says it once for the batch, as the eye does for one.
 */
describe("the bulk bar's Reveal, of an icon pin with access off", () => {
  /** A hidden pin of this mode, with access sync on or off, opening as it says. */
  const shaped = (
    id: string,
    mode: "pin" | "prop",
    sync: boolean,
    sort: number,
    open: "double" | "readInPlace" | "never" = "double"
  ) => {
    const tile = pinnedTile(id, { kind: "hidden" }, sort);
    const pin = tile.flags[MODULE_ID][FLAGS.PIN];
    pin.mode = mode;
    pin.interaction = { ...pin.interaction, open };
    pin.audience.ownershipSync = { ...pin.audience.ownershipSync, enabled: sync };
    return tile;
  };
  const notices = () =>
    world.notifications.filter((n: any) => n.message === "DP.notice.revealedNoAccess");

  it.each([
    [
      "says so once for two icon pins",
      [
        shaped("t1", "pin", false, 0),
        shaped("t2", "pin", false, 10),
        shaped("t3", "prop", false, 20),
      ],
      [{ type: "info", message: "DP.notice.revealedNoAccess" }],
    ],
    [
      "says nothing when every icon pin grants access, and a prop reads in place",
      [shaped("t1", "pin", true, 0), shaped("t2", "prop", false, 10)],
      [],
    ],
    [
      "says nothing for an icon pin that reads in place, or opens nothing at all",
      [shaped("t1", "pin", false, 0, "readInPlace"), shaped("t2", "pin", false, 10, "never")],
      [],
    ],
  ])("%s", async (_what, list, expected) => {
    await setup(list);
    board.selected = list.map((tile: any) => tile.id);
    await board.dispatch("bulkReveal");
    await settled();

    expect(list.every((tile: any) => tile.hidden === false)).toBe(true);
    expect(notices()).toEqual(expected);
  });
});

describe("Reveal all", () => {
  it("reveals one hidden pin to its own audience without asking", async () => {
    await setup([
      pinnedTile("t1", aliOnly()),
      pinnedTile("t2", { kind: "everyone" }, 10),
      // Remembering only a player who has left: its reveal reaches nobody, so it is not
      // the second pin that would make this ask.
      pinnedTile("t3", { kind: "hidden", restore: { kind: "selected", users: ["gone"] } }, 20),
    ]);
    await board.dispatch("revealAll");

    expect(asked).toEqual([]);
    expect(stored(tiles[0])).toMatchObject({ kind: "selected", users: ["ali"] });
    // One write, and the pin already showing is not in it.
    expect(world.canvas.scene.updates).toEqual([
      [
        expect.objectContaining({ _id: "t1", hidden: false }),
        expect.objectContaining({ _id: "t3" }),
      ],
    ]);
  });

  it("asks before showing two, naming the count, then reveals each to its own audience", async () => {
    await setup([
      pinnedTile("t1", aliOnly()),
      pinnedTile("t2", { kind: "hidden" }, 10),
      pinnedTile("t3", { kind: "everyone" }, 20),
    ]);
    await board.dispatch("revealAll");

    expect(asked).toHaveLength(1);
    expect(asked[0].content).toContain("DP.board.revealAllBody count=2");
    expect(world.canvas.scene.updates).toHaveLength(1);
    expect(stored(tiles[0])).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(stored(tiles[1])).toMatchObject({ kind: "everyone" });
  });

  it.each([
    ["answered no", false],
    ["closed with its ✕", null],
  ])("reveals nothing when the dialog is %s", async (_how, value) => {
    await setup([pinnedTile("t1", aliOnly()), pinnedTile("t2", aliOnly(), 10)]);
    answer(value);
    await board.dispatch("revealAll");

    expect(asked).toHaveLength(1);
    expect(world.canvas.scene.updates).toEqual([]);
    expect(stored(tiles[0]).kind).toBe("hidden");
  });

  it.each([
    ["enabled while a pin is hidden", [aliOnly(), { kind: "everyone" }], false],
    ["disabled with nothing hidden", [{ kind: "everyone" }, { kind: "everyone" }], true],
  ] as const)("is %s, and named in full", async (_state, audiences, disabled) => {
    await setup(audiences.map((audience, i) => pinnedTile(`t${i + 1}`, audience, i * 10)));
    const markup: HTMLElement = await board._renderHTML();
    const button = markup.querySelector<HTMLButtonElement>('[data-action="revealAll"]')!;
    expect(button.disabled).toBe(disabled);
    // Its group is named for the selection it does not act on, so it names itself.
    expect(button.getAttribute("aria-label")).toBe("DP.board.revealAllHint");
  });

  it("says so when the reveal fails, rather than rejecting into the console", async () => {
    await setup([pinnedTile("t1", aliOnly())]);
    world.canvas.scene.updateEmbeddedDocuments = async () => {
      throw new Error("the server went away");
    };
    await expect(board.dispatch("revealAll")).resolves.toBeUndefined();
    expect(world.notifications).toEqual([{ type: "error", message: "DP.board.revealAllFailed" }]);
  });

  it("refuses, rather than acting unasked, on a build with no dialog to ask with", async () => {
    await setup([pinnedTile("t1", aliOnly()), pinnedTile("t2", aliOnly(), 10)]);
    delete (globalThis as any).foundry.applications.api.DialogV2;
    await board.dispatch("revealAll");
    expect(world.canvas.scene.updates).toEqual([]);
  });
});
