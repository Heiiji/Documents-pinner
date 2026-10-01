/**
 * @vitest-environment jsdom
 *
 * The hooks `main.ts` registers for actors and items, called as core calls them (A9).
 *
 * A handler that only a test calls directly is a feature nobody can reach: so each test
 * here imports `main.ts` with a recording `Hooks.on` and calls the handler it recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import {
  DATA_FIELDS,
  dataModel,
  fakeActor,
  fakeItem,
  fakeJournal,
  fakeTile,
  installSources,
  installWorld,
  uninstallWorld,
} from "./helpers/fake-foundry";

// The ledger's own rebase is tested in `ownership-sync.test.ts`; here, only that an
// actor's ownership edit reaches it.
vi.mock("../src/data/ownership-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/ownership-sync")>()),
  onSourceOwnershipEdited: vi.fn(async () => {}),
}));

vi.mock("../src/apps/PlacementGhost", () => ({
  arm: vi.fn(() => true),
  armAt: vi.fn(() => true),
  disarm: vi.fn(),
}));

import { armAt } from "../src/apps/PlacementGhost";
import { onSourceOwnershipEdited } from "../src/data/ownership-sync";

let world: ReturnType<typeof installWorld>;
const registered = new Map<string, ((...args: any[]) => unknown)[]>();

/** The world, then `main.ts`, with every handler it registers recorded by name. */
async function boot(
  options: { isGM?: boolean; tiles?: any[]; actors?: any[]; journals?: any[] } = {}
) {
  world = installWorld({ isGM: options.isGM ?? true, tiles: options.tiles ?? [] });
  installSources(world, { actors: options.actors ?? [], journals: options.journals ?? [] });
  registered.clear();
  (globalThis as any).Hooks.on = (name: string, fn: (...args: any[]) => unknown) =>
    registered.set(name, [...(registered.get(name) ?? []), fn]);
  await import("../src/main");
}

const fire = (name: string, ...args: unknown[]) => {
  for (const handler of registered.get(name) ?? []) handler(...args);
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(armAt).mockClear();
  vi.mocked(onSourceOwnershipEdited).mockClear();
  document.body.innerHTML = '<div id="board"></div>';
});
afterEach(() => uninstallWorld());

describe("an actor's or an item's sheet header", () => {
  const jack = () => fakeActor({ id: "jack", name: "Black Jack" });

  it.each([
    ["a GM, on an actor's sheet", true, () => jack(), "Actor.jack"],
    [
      "a GM, on an item's sheet",
      true,
      () => fakeItem({ id: "amulet", name: "Amulet" }),
      "Item.amulet",
    ],
    ["a player, on an actor's sheet", false, () => jack(), null],
    [
      "a GM, on the sheet of an item an actor owns",
      true,
      () => fakeItem({ id: "knife", name: "Knife", parent: jack() }),
      null,
    ],
  ])("offers Pin to scene to %s", async (_who, isGM, doc, armed) => {
    await boot({ isGM });
    const controls: any[] = [];

    fire("getHeaderControlsApplicationV2", { document: doc() }, controls);
    controls[0]?.onClick();

    expect(controls).toHaveLength(armed ? 1 : 0);
    expect(vi.mocked(armAt).mock.calls.map((call) => call[0].uuid)).toEqual(armed ? [armed] : []);
  });
});

/**
 * A v14 directory fires `get${documentName}ContextOptions`; the 14.366 types name the
 * journal sidebar's `getJournalContextOptions`, which was not registered. Both are, and the
 * entry is added once however many fire.
 */
describe("Pin to scene in the journal sidebar's menu", () => {
  it.each([
    ["the types' name for it", ["getJournalContextOptions"]],
    ["both names, for one menu", ["getJournalEntryContextOptions", "getJournalContextOptions"]],
  ])("is there once, when %s fires", async (_what, hooks) => {
    await boot();
    const options: any[] = [];

    for (const hook of hooks) fire(hook, { collection: world.game.journal }, options);

    expect(options.map((option) => option.label)).toEqual(["DP.controls.pinThis"]);
  });
});

describe("an edit to an actor with a poster on the map", () => {
  const { HTMLField, SchemaField, StringField } = DATA_FIELDS;
  const jack = () =>
    fakeActor({
      id: "jack",
      name: "Black Jack",
      type: "npc",
      system: {
        details: { biography: { value: "<p>Owes the guild.</p>", public: "<p>Wanted.</p>" } },
        attributes: { hp: { value: 12 } },
      },
    });
  const nothing = { redrawn: false, renamed: false, rebased: false };

  it.each([
    [
      "to the biography it shows redraws it",
      "updateActor",
      { system: { details: { biography: { public: "<p>Dead or alive.</p>" } } } },
      { ...nothing, redrawn: true },
    ],
    [
      "to the biography it does not show leaves it",
      "updateActor",
      { system: { details: { biography: { value: "<p>Paid the guild.</p>" } } } },
      nothing,
    ],
    [
      "to its hit points, in combat, leaves it",
      "updateActor",
      { system: { attributes: { hp: { value: 3 } } } },
      nothing,
    ],
    [
      "to its name redraws it, and its label follows",
      "updateActor",
      { name: "Jack the Black" },
      { ...nothing, redrawn: true, renamed: true },
    ],
    [
      "to its ownership redraws it, and rebases the ledger",
      "updateActor",
      { ownership: { ali: 1 } },
      { ...nothing, redrawn: true, rebased: true },
    ],
    ["to an item it owns leaves it", "updateItem", { name: "Rusty Knife" }, nothing],
    [
      "to a journal no pin on the scene shows leaves it",
      "updateJournalEntry",
      { pages: [] },
      nothing,
    ],
  ])("%s", async (_what, hook, change, expected) => {
    const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
    tile.flags = {
      [MODULE_ID]: {
        [FLAGS.PIN]: {
          ...defaultPin(),
          source: { ...defaultPin().source, uuid: "Actor.jack", field: null },
        },
      },
    };
    const actor = jack();
    const knife = fakeItem({ id: "knife", name: "Knife", parent: actor });
    const ledger = fakeJournal({ id: "ledger", name: "Ledger" });
    await boot({ tiles: [tile], actors: [actor], journals: [ledger] });
    (globalThis as any).CONFIG.Actor.dataModels.npc = dataModel({
      details: new SchemaField({
        biography: new SchemaField({ value: new HTMLField(), public: new HTMLField() }),
      }),
      attributes: new SchemaField({ hp: new SchemaField({ value: new StringField() }) }),
    });
    const { propManager } = await import("../src/canvas/PropManager");
    const invalidate = vi.spyOn(propManager(), "invalidate");
    const redraw = vi.spyOn(tile.object.renderFlags, "set");

    const doc = { updateActor: actor, updateItem: knife, updateJournalEntry: ledger }[hook];
    fire(hook, doc, change, {}, "gm");

    expect({
      redrawn: invalidate.mock.calls.length > 0,
      renamed: redraw.mock.calls.length > 0,
      rebased: vi.mocked(onSourceOwnershipEdited).mock.calls.length > 0,
    }).toEqual(expected);
  });
});

/**
 * Only the update hooks were wired. A deleted journal, page or actor reached no handler, so
 * every client went on drawing it until the canvas was next drawn; and a page added to a
 * journal a pin shows whole never appeared.
 */
describe("a pin's source created or deleted", () => {
  /** A prop on `uuid`, revealed, on the viewed scene. */
  const propOn = (uuid: string) => {
    const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
    tile.flags = {
      [MODULE_ID]: {
        [FLAGS.PIN]: {
          ...defaultPin(),
          mode: "prop",
          source: { ...defaultPin().source, uuid, field: null },
          audience: { ...defaultPin().audience, kind: "everyone" },
        },
      },
    };
    return tile;
  };
  const ledger = () =>
    fakeJournal({ id: "ledger", name: "Ledger", pages: [{ id: "debts", name: "Debts" }] });

  it.each([
    ["the actor a poster shows, deleted", "deleteActor", "Actor.jack", "Actor.jack"],
    [
      "a page of the journal a pin shows whole, deleted",
      "deleteJournalEntryPage",
      "JournalEntry.ledger",
      "JournalEntry.ledger.JournalEntryPage.debts",
    ],
    [
      "a page added to that journal",
      "createJournalEntryPage",
      "JournalEntry.ledger",
      "JournalEntry.ledger.JournalEntryPage.debts",
    ],
  ])("redraws the pin: %s", async (_what, hook, shown, uuid) => {
    const journal = ledger();
    const jack = fakeActor({ id: "jack", name: "Black Jack" });
    await boot({ tiles: [propOn(shown)], actors: [jack], journals: [journal] });
    const { propManager } = await import("../src/canvas/PropManager");
    const invalidate = vi.spyOn(propManager(), "invalidate");
    const doc = uuid === "Actor.jack" ? jack : journal.pages.get("debts");

    fire(hook, doc, {}, "gm");

    expect(invalidate.mock.calls).toEqual([[uuid]]);
  });

  it("closes the reader of a journal the GM deletes, and says why", async () => {
    const journal = ledger();
    const tile = propOn("JournalEntry.ledger");
    await boot({ tiles: [tile], journals: [journal] });
    const { openReader, isReaderOpen } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    expect(isReaderOpen()).toBe(true);

    world.game.journal.delete("ledger");
    fire("deleteJournalEntry", journal, {}, "gm");

    expect(isReaderOpen()).toBe(false);
    expect(world.notifications.map((n) => n.message)).toContain("DP.notice.sourceMissing");
  });
});
