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
import { FLAGS, INTERNAL_OPTION, MODULE_ID } from "../src/const";
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
function pinnedTile(audience: Partial<DpAudience>, over: Partial<DpPinFlags> = {}, id = "t1") {
  const anchor = fakeTile({ id, uuid: `Scene.s1.Tile.${id}` });
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

/** The world, with these anchors on its scene and these journals beside "Chapter 3". */
async function install(anchors: any | any[], journals: any[] = []) {
  vi.resetModules();
  const tiles = [anchors].flat();
  tile = tiles[0];
  world = installWorld({
    isGM: true,
    players: [{ id: "ali" }, { id: "ben" }, { id: "cy" }],
    tiles,
  });
  // The tiles live on the scene. Core's scene update lands each change on its document,
  // and core's delete takes the tile off the scene's collection.
  const scene = world.canvas.scene;
  for (const anchor of tiles) anchor.parent = scene;
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
    // In place: the fake scene's `tiles.get` reads this same array.
    const contents = scene.tiles.contents;
    for (const id of ids)
      contents.splice(
        contents.findIndex((t: any) => t.id === id),
        1
      );
    return ids;
  };
  const roots = [entry, ...journals];
  byUuid = Object.fromEntries(
    roots.flatMap((root) => [root, ...root.pages.contents]).map((doc: any) => [doc.uuid, doc])
  );
  (globalThis as any).fromUuid = async (uuid: string) => byUuid[uuid] ?? null;
  (globalThis as any).fromUuidSync = (uuid: string) => byUuid[uuid] ?? null;
  world.game.journal.contents = roots;

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

describe("deleting pins with a chip click still landing", () => {
  /** Every write the tile and the scene receive, in the order they land; the tile's are slow. */
  function recordOrder() {
    const order: string[] = [];
    const scene = world.canvas.scene;
    const write = tile.update;
    tile.update = async (data: any, options: any) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("tile write");
      return write(data, options);
    };
    const remove = scene.deleteEmbeddedDocuments;
    scene.deleteEmbeddedDocuments = async (type: string, ids: string[], options: any) => {
      order.push("delete");
      return remove(type, ids, options);
    };
    return order;
  }

  it("lets the click land, then releases everything, in one delete", async () => {
    await install(pinnedTile({ kind: "selected", users: ["ali"] }));
    await sync.syncAnchor(tile);
    const order = recordOrder();

    const chip = api.setUserVisible(tile, "ben", true);
    await api.deletePins(world.canvas.scene, [tile]);
    await chip;
    await landed();

    expect(order).toEqual(["tile write", "delete"]);
    expect(world.canvas.scene.deleted).toEqual([["t1"]]);
    expect(holdersOn(entry)).toBeNull();
    expect(entry.ownership).toEqual({ default: 0 });
    expect(pages.p1.ownership).toEqual({ default: -1 });
  });

  // Pin Studio's Delete released first, outside the pin's write queue, then deleted
  // through it: a chip click still landing was written after the release, and the sync
  // it started granted for a pin about to go (A29).
  it("lets the click land before a single pin's release and delete, too", async () => {
    await install(pinnedTile({ kind: "selected", users: ["ali"] }));
    await sync.syncAnchor(tile);
    const order = recordOrder();
    const scene = world.canvas.scene;
    const remove = tile.delete;
    // A round trip, as core's is: a sync that checked for its pin before it landed found
    // it still on the scene.
    tile.delete = async (options: any) => {
      order.push("delete");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const contents = scene.tiles.contents;
      contents.splice(contents.indexOf(tile), 1);
      return remove(options);
    };

    const chip = api.setUserVisible(tile, "ben", true);
    await api.deletePin(tile);
    await chip;
    await landed();

    expect(order).toEqual(["tile write", "delete"]);
    expect(holdersOn(entry)).toBeNull();
    expect(holdersOn(pages.p1)).toBeNull();
    expect(entry.ownership).toEqual({ default: 0 });
    expect(pages.p1.ownership).toEqual({ default: -1 });
  });

  it("grants nothing for a click whose sync runs after the pin is gone", async () => {
    await install(pinnedTile({ kind: "selected", users: ["ali"] }));
    await sync.syncAnchor(tile);

    const deleting = api.deletePins(world.canvas.scene, [tile]);
    // Queued behind the delete: by the time its sync runs, the tile is off the scene.
    const chip = api.setUserVisible(tile, "ben", true);
    await Promise.all([deleting, chip]);
    await landed();

    expect(holdersOn(entry)).toBeNull();
    expect(holdersOn(pages.p1)).toBeNull();
    expect(entry.ownership).toEqual({ default: 0 });
    expect(pages.p1.ownership).toEqual({ default: -1 });
  });
});

describe("a bulk reveal's access", () => {
  /** A second journal, and a hidden pin on each, both remembering Ali. */
  async function twoPins() {
    const other = journal("k", "Chapter 4");
    const forAli = {
      kind: "hidden" as const,
      restore: { kind: "selected" as const, users: ["ali"] },
    };
    const second = pinnedTile(
      forAli,
      { source: { ...defaultPin().source, uuid: "JournalEntry.k", pageId: "p1" } },
      "t2"
    );
    await install([pinnedTile(forAli), second], [other]);
    return { other, second };
  }

  it("is granted for every pin at once, not one round trip after another", async () => {
    const { other } = await twoPins();
    // The first pin's journal is slow to resolve; the second's is not.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resolve = (globalThis as any).fromUuid;
    (globalThis as any).fromUuid = async (uuid: string) => {
      if (uuid === "JournalEntry.j") await gate;
      return resolve(uuid);
    };

    const revealing = api.setVisibilityMany(
      world.canvas.scene,
      world.canvas.scene.tiles.contents,
      true
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    expect(other.ownership.ali).toBe(1);
    expect(entry.ownership.ali).toBeUndefined();
    release();
    await expect(revealing).resolves.toBe(2);
    expect(entry.ownership.ali).toBe(1);
  });

  it("still reaches every pin when one of them fails, and says so once", async () => {
    const { other } = await twoPins();
    other.pages.get = () => {
      throw new Error("a page that cannot be read");
    };

    await expect(
      api.setVisibilityMany(world.canvas.scene, world.canvas.scene.tiles.contents, true)
    ).resolves.toBe(2);

    expect(entry.ownership.ali).toBe(1);
    expect(pages.p1.ownership.ali).toBe(2);
    expect(
      world.notifications.filter((n) => n.message === "DP.notice.ownershipWriteFailed")
    ).toHaveLength(1);
  });
});

/**
 * `patch` is public — other modules reach it through the module's API — and it was a bare
 * store write: a patched audience showed the pin and granted nothing, and a patched source
 * moved the pin onto another document still naming the old one's page.
 */
describe("patch, as other modules call it", () => {
  it("brings ownership in line with a patched audience, and returns the update", async () => {
    await install(pinnedTile({ kind: "hidden" }));

    const result = await api.patch(tile, { audience: { kind: "everyone" } });

    expect(result).toBe(tile);
    expect(tile.hidden).toBe(false);
    expect(entry.ownership.default).toBe(1);
    expect(pages.p1.ownership.default).toBe(2);
  });

  it("moves a pin to the document a patched uuid names, as a retarget does", async () => {
    const other = journal("k", "Chapter 4");
    await install(
      pinnedTile(
        { kind: "selected", users: ["ali"] },
        {
          source: {
            ...defaultPin().source,
            uuid: "JournalEntry.j",
            pageId: "p1",
            pdfPage: 3,
            field: "details.biography.value",
            followName: false,
          },
        }
      ),
      [other]
    );
    await sync.syncAnchor(tile);
    expect(pages.p1.ownership.ali).toBe(2);

    const result = await api.patch(tile, { source: { uuid: "JournalEntry.k" } });

    expect(result).toBe(tile);
    expect(pinOf(tile).source).toMatchObject({
      kind: "document",
      uuid: "JournalEntry.k",
      pageId: null,
      pdfPage: null,
      field: null,
      followName: false,
    });
    // The old uuid reached the sync: the journal the pin left gave everything back.
    expect(entry.ownership).toEqual({ default: 0 });
    expect(pages.p1.ownership).toEqual({ default: -1 });
    expect(other.ownership.ali).toBe(2);
  });

  it("still patches a page of the same document in place, and moves the grant with it", async () => {
    await install(pinnedTile({ kind: "selected", users: ["ali"] }));
    await sync.syncAnchor(tile);

    await api.patch(tile, { source: { uuid: "JournalEntry.j", pageId: "p2" } });

    expect(pinOf(tile).source).toMatchObject({ uuid: "JournalEntry.j", pageId: "p2" });
    expect(pages.p2.ownership.ali).toBe(2);
    expect(pages.p1.ownership.ali).toBeUndefined();
  });
});

describe("retarget, given part of a source", () => {
  it("clears the page fields the old document's source named", async () => {
    const other = journal("k", "Chapter 4");
    await install(
      pinnedTile(
        { kind: "selected", users: ["ali"] },
        { source: { ...defaultPin().source, uuid: "JournalEntry.j", pageId: "p1", pdfPage: 3 } }
      ),
      [other]
    );

    await expect(api.retarget(tile, { uuid: "JournalEntry.k" })).resolves.toBe(true);

    expect(pinOf(tile).source).toMatchObject({
      kind: "document",
      uuid: "JournalEntry.k",
      pageId: null,
      pdfPage: null,
      field: null,
    });
  });

  it("writes nothing for the document the pin already shows", async () => {
    await install(pinnedTile({ kind: "everyone" }));
    await expect(api.retarget(tile, { uuid: "JournalEntry.j" })).resolves.toBe(false);
    expect(tile.updates).toEqual([]);
  });
});

describe("setPinIcon", () => {
  it("writes the icon as the module's own change", async () => {
    await install(pinnedTile({ kind: "everyone" }));

    await expect(api.setPinIcon(tile, "icons/svg/skull.svg")).resolves.toBe(true);

    expect(tile.texture.src).toBe("icons/svg/skull.svg");
    expect(tile.lastContext?.[INTERNAL_OPTION]).toBe(true);
  });

  it("waits for a retarget still landing, and leaves the image it brought alone", async () => {
    await install(pinnedTile({ kind: "everyone" }));

    const toImage = api.retarget(tile, { kind: "image", src: "maps/letter.webp" });
    const icon = api.setPinIcon(tile, "icons/svg/skull.svg");

    await expect(toImage).resolves.toBe(true);
    await expect(icon).resolves.toBe(false);
    expect(tile.texture.src).toBe("maps/letter.webp");
    expect(tile.updates.filter((u: any) => "texture.src" in u)).toHaveLength(1);
  });
});
