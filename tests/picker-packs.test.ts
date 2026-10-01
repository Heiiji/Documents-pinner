/**
 * @vitest-environment jsdom
 *
 * Finding a compendium document to pin.
 *
 * The picker and `/pin` searched the world's journals only, and "Pin to scene" in a
 * compendium window looked its row up in the world and did nothing. A GM whose handouts
 * ship in an adventure's compendium had one route left: an Alt-drop from the pack — onto
 * a document their players' role might not even be able to open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_ID } from "../src/const";
import {
  contentOf,
  fakeJournal,
  fakePack,
  installSources,
  installWorld,
  uninstallWorld,
  USER_ROLES,
  type FakePackOptions,
  type InstalledSources,
} from "./helpers/fake-foundry";

vi.mock("../src/apps/PlacementGhost", () => ({
  arm: vi.fn(() => true),
  armAt: vi.fn(() => true),
  disarm: vi.fn(),
}));

import { arm, armAt } from "../src/apps/PlacementGhost";

const PACK = "world.handouts";
const ENTRY = `Compendium.${PACK}.JournalEntry.letters`;
const TRUSTED_ONLY = { PLAYER: "NONE", TRUSTED: "OBSERVER", ASSISTANT: "OWNER" };

const handouts = (over: Partial<FakePackOptions> = {}) =>
  fakePack({
    id: PACK,
    label: "Handouts",
    entries: [
      { _id: "letters", name: "Letters" },
      { _id: "ledger", name: "Ledger" },
    ],
    ...over,
  });

let world: ReturnType<typeof installWorld>;
let sources: InstalledSources;

function install(packs: any[], journals: any[] = []) {
  world = installWorld({
    isGM: true,
    players: [
      { id: "ali", role: USER_ROLES.PLAYER },
      { id: "ben", role: USER_ROLES.TRUSTED },
    ],
  });
  sources = installSources(world, {
    packs,
    journals: [fakeJournal({ id: "mayor", name: "Letter to the Mayor" }), ...journals],
  });
}

/** Let an import, an index load and the renders they start run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function picker(search = "") {
  const { definePicker } = await import("../src/apps/DocumentPicker");
  const app = new (definePicker())();
  app.search = search;
  await app.render();
  return app;
}

const rows = (app: any) =>
  [...contentOf(app).querySelectorAll<HTMLElement>(".dp-picker__item")].map((row) => [
    row.querySelector(".dp-picker__name")!.textContent,
    row.querySelector(".dp-picker__context")?.textContent ?? "",
    row.classList.contains("dp-picker__item--locked"),
  ]);

beforeEach(() => {
  vi.resetModules();
  vi.mocked(arm).mockClear();
  vi.mocked(armAt).mockClear();
  document.body.innerHTML = "";
});
afterEach(() => uninstallWorld());

describe("the picker's compendium rows", () => {
  it.each([
    ["", [["Letter to the Mayor", "", false]]],
    ["l", [["Letter to the Mayor", "", false]]],
    [
      "le",
      [
        ["Letter to the Mayor", "", false],
        ["Letters", "Handouts", false],
        ["Ledger", "Handouts", false],
      ],
    ],
  ])(
    "follow the world's, labelled with their pack, from two letters (%j)",
    async (search, expected) => {
      install([handouts()]);
      expect(rows(await picker(search))).toEqual(expected);
    }
  );

  it("are read from the index core holds, and an empty index is asked for once", async () => {
    const lore = fakePack({
      id: "world.lore",
      label: "Lore",
      unindexed: true,
      entries: [{ _id: "legends", name: "Legends of the Keep" }],
    });
    const pack = handouts();
    install([pack, lore]);
    const app = await picker("le");
    const before = rows(app);
    await flush(); // the index arrives, and the open picker searches again

    expect(before).toEqual([
      ["Letter to the Mayor", "", false],
      ["Letters", "Handouts", false],
      ["Ledger", "Handouts", false],
    ]);
    expect(rows(app).slice(1)).toEqual([
      ["Letters", "Handouts", false],
      ["Ledger", "Handouts", false],
      ["Legends of the Keep", "Lore", false],
    ]);
    expect(pack.getIndexCalls).toBe(0);
    expect(lore.getIndexCalls).toBe(1);
  });
});

describe("Import & pin", () => {
  it.each([
    ["imports a copy into the module's folder", [], "JournalEntry.copy-letters", 1],
    [
      "pins the copy already imported, and imports nothing",
      [
        Object.assign(fakeJournal({ id: "mine", name: "Letters" }), {
          _stats: { compendiumSource: ENTRY },
        }),
      ],
      "JournalEntry.mine",
      0,
    ],
  ])("on a pack a player cannot read %s", async (_what, journals, armed, imports) => {
    install([handouts({ ownership: TRUSTED_ONLY })], journals);
    const app = await picker("letters");
    const row = contentOf(app).querySelector<HTMLElement>(".dp-picker__item--locked");
    expect(row).not.toBeNull();

    row!.click();
    await flush();

    expect(arm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(arm).mock.calls[0][0]).toMatchObject({ kind: "document", uuid: armed });
    expect(sources.imports).toHaveLength(imports);
    if (imports) {
      const copy = sources.journal.get("copy-letters");
      const folder = world.game.folders.contents[0];
      expect(folder).toMatchObject({
        type: "JournalEntry",
        flags: { [MODULE_ID]: { imports: true } },
      });
      expect(copy.folder).toBe(folder.id);
      expect(copy.flags[MODULE_ID].importedFrom).toBe(ENTRY);
    }
  });

  it.each([
    ["throws", async () => Promise.reject(new Error("the server refused"))],
    ["creates nothing", async () => undefined],
  ])("says so and arms nothing when the import %s", async (_how, importFromCompendium) => {
    install([handouts({ ownership: TRUSTED_ONLY })]);
    world.game.journal.importFromCompendium = importFromCompendium;
    const app = await picker("letters");
    const search = contentOf(app).querySelector<HTMLInputElement>(".dp-picker__search")!;

    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(arm).not.toHaveBeenCalled();
    expect(world.notifications).toEqual([{ type: "warn", message: "DP.notice.importFailed" }]);
  });
});

describe("/pin and the compendium window's menu", () => {
  it.each([
    ["arms a match in a pack every player reads", undefined, "ledger"],
    ["opens the picker on the search when only a locked pack matches", TRUSTED_ONLY, null],
  ])("/pin %s", async (_what, ownership, armed) => {
    install([handouts({ ownership })]);
    const { onChatMessage } = await import("../src/ui/entry-points");
    const { openPicker } = await import("../src/apps/DocumentPicker");

    expect(onChatMessage(null, "/pin ledger")).toBe(false);
    await flush();

    expect(world.notifications).toEqual([]);
    if (armed) {
      expect(vi.mocked(armAt).mock.calls[0][0]).toMatchObject({
        uuid: `Compendium.${PACK}.JournalEntry.${armed}`,
      });
    } else {
      expect(armAt).not.toHaveBeenCalled();
      // The same reused picker, opened on the query, its row offering the import.
      const app = openPicker();
      await flush();
      expect(app.search).toBe("ledger");
      expect(rows(app)).toEqual([["Ledger", "Handouts", true]]);
    }
  });

  it.each([
    ["a compendium window", () => world.game.packs.get(PACK), "letters", ENTRY],
    ["the journal sidebar", () => world.game.journal, "mayor", "JournalEntry.mayor"],
  ])("Pin to scene in %s arms the row's document", async (_where, collection, id, uuid) => {
    install([handouts()]);
    const registered = new Map<string, ((...args: any[]) => void)[]>();
    (globalThis as any).Hooks.on = (name: string, fn: (...args: any[]) => void) =>
      registered.set(name, [...(registered.get(name) ?? []), fn]);
    await import("../src/main");

    const options: any[] = [];
    for (const handler of registered.get("getJournalEntryContextOptions") ?? []) {
      handler({ collection: collection() }, options);
    }
    const row = document.createElement("li");
    row.dataset.entryId = id;
    options[0].onClick(new Event("click"), row);

    expect(vi.mocked(armAt).mock.calls.map((call) => call[0].uuid)).toEqual([uuid]);
  });
});
