/**
 * @vitest-environment jsdom
 *
 * Which document a reveal grants access to.
 *
 * The grant used to land on `pin.source.uuid` whatever page the pin showed. A pin showing
 * page 3 of a journal names the JOURNAL, so revealing it raised the journal — and every
 * page that inherits its ownership, which is every page by default, went with it. The GM
 * showed a letter and handed over the chapter, in the players' sidebars, for good.
 *
 * Written against a journal with real pages, through `fakeDoc`, and asserted on what
 * each document ends up holding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { planGrant, serialiseLedger } from "../src/data/ownership-plan";
import { fakeDoc, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

let entry: any;
let pages: Record<string, any>;
let byUuid: Record<string, any>;
let world: ReturnType<typeof installWorld>;

const pageUuid = (id: string) => `JournalEntry.j.JournalEntryPage.${id}`;

function journal() {
  entry = fakeDoc({
    id: "j",
    uuid: "JournalEntry.j",
    documentName: "JournalEntry",
    name: "Chapter 3",
    ownership: { default: 0 },
  });
  const page = (id: string, name: string) =>
    fakeDoc({
      id,
      uuid: pageUuid(id),
      documentName: "JournalEntryPage",
      name,
      parent: entry,
      ownership: { default: -1 },
    });
  pages = { p1: page("p1", "Intro"), p3: page("p3", "The Letter"), p9: page("p9", "The Plan") };
  const list = Object.values(pages);
  entry.pages = { contents: list, get: (id: string) => pages[id] ?? null };
  byUuid = Object.fromEntries([entry, ...list].map((doc) => [doc.uuid, doc]));
}

function pinned(source: { uuid: string; pageId?: string | null }, level: 1 | 2 = 2) {
  const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: source.uuid,
          src: null,
          pageId: source.pageId ?? null,
          pdfPage: null,
          followName: true,
        },
        audience: {
          ...defaultPin().audience,
          kind: "selected",
          users: ["ali"],
          ownershipSync: { enabled: true, level },
        },
      },
    },
  };
  return tile;
}

const pinOf = (tile: any) => tile.flags[MODULE_ID][FLAGS.PIN];
const ledgerOn = (doc: any) => doc.flags?.[MODULE_ID]?.[FLAGS.GRANTS] ?? null;

function install(tile: any) {
  world = installWorld({ isGM: true, tiles: [tile] });
  (globalThis as any).fromUuid = async (uuid: string) => byUuid[uuid] ?? null;
  (globalThis as any).fromUuidSync = (uuid: string) => byUuid[uuid] ?? null;
  (globalThis as any).game.journal.contents = [entry];
}

beforeEach(() => {
  vi.resetModules();
  journal();
});

afterEach(() => {
  delete (globalThis as any).fromUuid;
  delete (globalThis as any).fromUuidSync;
  uninstallWorld();
});

describe("revealing a pin that shows one page", () => {
  it("grants the page, and only lists its journal", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(tile);

    expect(pages.p3.ownership.ali).toBe(2);
    // LIMITED, not OBSERVER: the journal is listed, and no page that inherits opens.
    expect(entry.ownership.ali).toBe(1);
    expect(pages.p1.ownership.ali).toBeUndefined();
    expect(pages.p9.ownership.ali).toBeUndefined();
  });

  it("lists the journal for a pin placed on the page itself, which it never did", async () => {
    const tile = pinned({ uuid: pageUuid("p3") });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(tile);

    expect(pages.p3.ownership.ali).toBe(2);
    expect(entry.ownership.ali).toBe(1);
  });

  it("keeps the tease a tease: LIMITED on both", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" }, 1);
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(tile);

    expect(pages.p3.ownership.ali).toBe(1);
    expect(entry.ownership.ali).toBe(1);
  });

  it("still shares the whole journal when the pin shows the whole journal", async () => {
    const tile = pinned({ uuid: "JournalEntry.j" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(tile);

    expect(entry.ownership.ali).toBe(2);
    for (const page of Object.values(pages)) expect(page.updates).toHaveLength(0);
  });

  it("grants nothing for a chosen page that has since been deleted", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "gone" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(tile);

    // Not the journal: a page the GM chose and then deleted is not a request to share it.
    expect(entry.updates).toHaveLength(0);
    for (const page of Object.values(pages)) expect(page.updates).toHaveLength(0);
  });
});

describe("taking it back", () => {
  it("restores the page and the journal exactly when the pin is hidden", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");
    await syncAnchor(tile);

    pinOf(tile).audience = { ...pinOf(tile).audience, kind: "hidden" };
    await syncAnchor(tile);

    expect(entry.ownership).toEqual({ default: 0 });
    expect(pages.p3.ownership).toEqual({ default: -1 });
    expect(ledgerOn(entry)).toBeNull();
    expect(ledgerOn(pages.p3)).toBeNull();
  });

  it("releases the page and the journal when the pin is deleted", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const { releaseAnchor, syncAnchor } = await import("../src/data/ownership-sync");
    await syncAnchor(tile);

    await releaseAnchor(tile);

    expect(entry.ownership).toEqual({ default: 0 });
    expect(pages.p3.ownership).toEqual({ default: -1 });
  });

  it("writes nothing to the pages that never held a grant", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const { releaseAnchor, syncAnchor } = await import("../src/data/ownership-sync");
    await syncAnchor(tile);

    await releaseAnchor(tile);

    expect(pages.p1.updates).toHaveLength(0);
    expect(pages.p9.updates).toHaveLength(0);
  });
});

describe("choosing another page", () => {
  it("moves the grant with it, from the Studio's own call", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");
    const api = await import("../src/api");
    await syncAnchor(tile);

    // `patchAndSync` synced only on an audience change, so the page moved and the grant
    // stayed on the page the pin no longer showed.
    await api.patchAndSync(tile, { source: { pageId: "p9" } } as any);

    expect(pages.p9.ownership.ali).toBe(2);
    expect(pages.p3.ownership.ali).toBeUndefined();
    expect(ledgerOn(pages.p3)).toBeNull();
    expect(entry.ownership.ali).toBe(1);
  });

  it("narrows a whole-journal grant to the page once one is chosen", async () => {
    const tile = pinned({ uuid: "JournalEntry.j" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");
    const api = await import("../src/api");
    await syncAnchor(tile);
    expect(entry.ownership.ali).toBe(2);

    await api.patchAndSync(tile, { source: { pageId: "p3" } } as any);

    expect(entry.ownership.ali).toBe(1);
    expect(pages.p3.ownership.ali).toBe(2);
  });

  it("keeps the new grant when a pin is re-pointed at a page of its own journal", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const { syncAnchor } = await import("../src/data/ownership-sync");
    const api = await import("../src/api");
    await syncAnchor(tile);

    await api.retarget(tile, {
      kind: "document",
      uuid: pageUuid("p9"),
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    });

    // The old document and the new one share a family. Releasing the old family after
    // granting the new one would have taken the fresh grant straight back.
    expect(pages.p9.ownership.ali).toBe(2);
    expect(entry.ownership.ali).toBe(1);
    expect(pages.p3.ownership.ali).toBeUndefined();
  });
});

describe("the ready sweep", () => {
  it("does not mistake a page's grant, or its journal's listing, for an orphan", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    const sync = await import("../src/data/ownership-sync");
    await sync.syncAnchor(tile);

    expect(await sync.reconcile()).toBe(0);
    expect(pages.p3.ownership.ali).toBe(2);
    expect(entry.ownership.ali).toBe(1);
  });

  it("narrows a whole-journal grant an earlier version made for a page pin", async () => {
    const tile = pinned({ uuid: "JournalEntry.j", pageId: "p3" });
    install(tile);
    // Exactly what 0.3.3 wrote: OBSERVER on the journal, held by this anchor.
    const legacy = planGrant({ default: 0 }, null, {
      anchorUuid: tile.uuid,
      keys: ["ali"],
      level: 2,
    });
    entry.ownership = { default: 0, ali: 2 };
    entry.flags = { [MODULE_ID]: { [FLAGS.GRANTS]: serialiseLedger(legacy.ledger!) } };
    const sync = await import("../src/data/ownership-sync");

    await sync.reconcile();

    expect(entry.ownership.ali).toBe(1);
    expect(pages.p3.ownership.ali).toBe(2);
    expect(pages.p9.ownership.ali).toBeUndefined();
    expect(world.notifications.map((n) => n.message)).toContain("DP.notice.grantsNarrowed");
  });
});

describe("what the Studio says a reveal shares", () => {
  it("names the page, and the journal it only lists", async () => {
    install(pinned({ uuid: "JournalEntry.j", pageId: "p3" }));
    const api = await import("../src/api");
    expect(api.grantScope(pinOf(pinned({ uuid: "JournalEntry.j", pageId: "p3" })))).toEqual({
      kind: "page",
      page: "The Letter",
      entry: "Chapter 3",
    });
  });

  it("says a whole journal is the whole journal, with how many pages go with it", async () => {
    install(pinned({ uuid: "JournalEntry.j" }));
    const api = await import("../src/api");
    expect(api.grantScope(pinOf(pinned({ uuid: "JournalEntry.j" })))).toEqual({
      kind: "journal",
      entry: "Chapter 3",
      pages: 3,
    });
  });

  it("appears on the Audience tab only while access is granted", async () => {
    const tile = pinned({ uuid: "JournalEntry.j" });
    install(tile);
    const { studioMarkup } = await import("../src/apps/PinStudio");

    const on = studioMarkup(tile, pinOf(tile), "audience");
    expect(on).toContain('data-dp-grants="journal"');
    expect(on).toContain("DP.studio.grantsJournalHint");

    const off = {
      ...pinOf(tile),
      audience: { ...pinOf(tile).audience, ownershipSync: { enabled: false, level: 2 } },
    };
    expect(studioMarkup(tile, off, "audience")).not.toContain("data-dp-grants");
  });
});
