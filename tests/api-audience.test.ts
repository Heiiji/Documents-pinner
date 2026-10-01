/**
 * @vitest-environment jsdom
 *
 * The audience verbs against a pin that is still being written (DESIGN A29).
 *
 * Every write to a pin waits its turn in one queue, and two quick chip clicks still lost
 * the first: each verb built the whole next audience from the payload as it was BEFORE its
 * turn, and the store replaces a list whole. The queue ordered two writes that had already
 * been decided wrong — and the ownership that follows each one was granted from whichever
 * audience its sync happened to read.
 *
 * Driven through the real API, store and ledger, against a journal with pages, and asserted
 * on what the pin and each document end up holding, as a player's client would read them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { readLedger } from "../src/data/ownership-plan";
import { defaultPin } from "../src/data/pin-schema";
import type { DpAudience, DpPinFlags } from "../src/types/dp";
import { fakeDoc, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const ANCHOR = "Scene.s1.Tile.t1";

let entry: any;
let pages: Record<string, any>;
let byUuid: Record<string, any>;
let tile: any;
let world: ReturnType<typeof installWorld>;
let api: typeof import("../src/api");
let store: typeof import("../src/data/PinStore");
let sync: typeof import("../src/data/ownership-sync");

/** "Chapter 3", whose pages inherit nothing of their own. */
function journal(id = "j", name = "Chapter 3") {
  const root = fakeDoc({
    id,
    uuid: `JournalEntry.${id}`,
    documentName: "JournalEntry",
    name,
    ownership: { default: 0 },
  });
  const page = (pageId: string, pageName: string) =>
    fakeDoc({
      id: pageId,
      uuid: `${root.uuid}.JournalEntryPage.${pageId}`,
      documentName: "JournalEntryPage",
      name: pageName,
      parent: root,
      ownership: { default: -1 },
    });
  const list = [page("p1", "The Letter"), page("p2", "The Plan")];
  root.pages = {
    contents: list,
    get: (pageId: string) => list.find((p) => p.id === pageId) ?? null,
  };
  return root;
}

/** A prop showing page p1 of the journal, to `audience`, access on unless said. */
function pinnedTile(audience: Partial<DpAudience>, over: Partial<DpPinFlags> = {}) {
  const anchor = fakeTile({ id: "t1", uuid: ANCHOR });
  anchor.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        source: { ...defaultPin().source, uuid: "JournalEntry.j", pageId: "p1" },
        ...over,
        audience: {
          ...defaultPin().audience,
          ownershipSync: { enabled: true, level: 2 },
          ...audience,
        },
      },
    },
  };
  anchor.hidden = (audience.kind ?? "hidden") === "hidden";
  return anchor;
}

const pinOf = (doc: any): DpPinFlags => doc.flags[MODULE_ID][FLAGS.PIN];
const holdersOn = (doc: any) => readLedger(doc.flags?.[MODULE_ID]?.[FLAGS.GRANTS])?.holders ?? null;

async function install(anchor: any, extra: any[] = []) {
  vi.resetModules();
  tile = anchor;
  world = installWorld({
    isGM: true,
    players: [{ id: "ali" }, { id: "ben" }, { id: "cy" }],
    tiles: [tile],
  });
  // The tile lives on the scene. Core's scene update lands each change on its document,
  // and core's delete takes the tile off the scene's collection.
  const scene = world.canvas.scene;
  tile.parent = scene;
  scene.updateEmbeddedDocuments = async (_type: string, updates: any[]) => {
    for (const change of updates) {
      const data = { ...change };
      delete data._id;
      await scene.tiles.get(change._id)?.update(data);
    }
    return updates;
  };
  scene.deleted = [] as string[][];
  scene.deleteEmbeddedDocuments = async (_type: string, ids: string[]) => {
    scene.deleted.push(ids);
    scene.tiles.contents = scene.tiles.contents.filter((t: any) => !ids.includes(t.id));
    return ids;
  };
  byUuid = Object.fromEntries(
    [entry, ...entry.pages.contents, ...extra].map((doc: any) => [doc.uuid, doc])
  );
  (globalThis as any).fromUuid = async (uuid: string) => byUuid[uuid] ?? null;
  (globalThis as any).fromUuidSync = (uuid: string) => byUuid[uuid] ?? null;
  world.game.journal.contents = [entry];

  store = await import("../src/data/PinStore");
  sync = await import("../src/data/ownership-sync");
  api = await import("../src/api");
}

/** Every write queued anywhere, and every sync those writes started, has landed. */
async function landed() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.settled();
  }
}

beforeEach(() => {
  entry = journal();
  pages = Object.fromEntries(entry.pages.contents.map((p: any) => [p.id, p]));
});

afterEach(() => {
  delete (globalThis as any).fromUuid;
  delete (globalThis as any).fromUuidSync;
  uninstallWorld();
});

describe("two chip clicks in the same tick", () => {
  it("both land, and the grants follow the audience they leave", async () => {
    await install(pinnedTile({ kind: "everyone" }));
    await sync.syncAnchor(tile);
    expect(entry.ownership.default).toBe(1);

    // Neither awaited before the other: two clicks faster than a write.
    const ali = api.setUserVisible(tile, "ali", false);
    const ben = api.setUserVisible(tile, "ben", false);
    await Promise.all([ali, ben]);
    await landed();

    expect(pinOf(tile).audience).toMatchObject({ kind: "selected", users: ["cy"] });
    // The journal is listed — LIMITED — to the one player left, and to nobody by default.
    expect(holdersOn(entry)).toEqual({ cy: { [ANCHOR]: 1 } });
    expect(entry.ownership).toEqual({ default: 0, cy: 1 });
    expect(holdersOn(pages.p1)).toEqual({ cy: { [ANCHOR]: 2 } });
    expect(pages.p1.ownership).toEqual({ default: -1, cy: 2 });
  });
});

describe("Hide all over a chip click still landing", () => {
  it("remembers the audience the click left, so the next reveal is for the same players", async () => {
    await install(pinnedTile({ kind: "everyone" }));

    const chip = api.setUserVisible(tile, "ali", false);
    const hideAll = api.setVisibilityMany(world.canvas.scene, [tile], false);
    await Promise.all([chip, hideAll]);

    expect(pinOf(tile).audience).toMatchObject({
      kind: "hidden",
      restore: { kind: "selected", users: ["ben", "cy"] },
    });
    await expect(hideAll).resolves.toBe(1);
  });
});

describe("chooseSome", () => {
  it("writes nothing, and resolves false, when there is nobody to choose", async () => {
    await install(pinnedTile({ kind: "everyone" }));

    await expect(api.chooseSome(tile)).resolves.toBe(false);
    await landed();

    expect(tile.updates).toEqual([]);
    expect(entry.updates).toEqual([]);
  });

  it("chooses from the list the pin holds when its write lands", async () => {
    await install(pinnedTile({ kind: "hidden", restore: { kind: "selected", users: ["ali"] } }));

    const chip = api.setUserVisible(tile, "ben", true);
    const chosen = api.chooseSome(tile);
    await chip;

    await expect(chosen).resolves.toBe(true);
    expect(pinOf(tile).audience).toMatchObject({ kind: "selected", users: ["ben"] });
  });
});

describe("the warning that a revealed pin will not open", () => {
  /** An icon pin that opens its sheet, hidden, with access off: the case the notice is for. */
  const iconPin = () =>
    pinnedTile(
      { kind: "hidden", ownershipSync: { enabled: false, level: 2 } },
      { mode: "pin", interaction: { ...defaultPin().interaction, open: "double" } }
    );
  const warned = () =>
    world.notifications.filter((n) => n.message === "DP.notice.revealedNoAccess").length;

  it("is decided from the pin as the reveal finds it, not as it was before the queue", async () => {
    await install(iconPin());

    // Becoming a prop — which reads in place, access or not — is still landing.
    const becomingProp = store.update(tile, { mode: "prop" });
    const reveal = api.toggleVisibility(tile);
    await Promise.all([becomingProp, reveal]);

    expect(pinOf(tile).audience.kind).toBe("everyone");
    expect(warned()).toBe(0);
  });

  it("is still said for the icon pin it is about", async () => {
    await install(iconPin());
    await api.toggleVisibility(tile);
    expect(warned()).toBe(1);
  });
});
