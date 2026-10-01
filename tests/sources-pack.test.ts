/**
 * @vitest-environment jsdom
 *
 * A pin on a compendium document.
 *
 * `fromUuidSync` answers a compendium uuid in three shapes: the pack's index entry (a
 * plain object with a name and no methods), the Document itself for five minutes after
 * anything loaded it, or a throw for a page whose journal is not cached. Sixteen places
 * read whatever came back, so one pin had one label, icon, key glyph and audience note
 * before its card was drawn and another after — and a player who could not read the pack
 * was told nothing at all. The fake models all three shapes and computes pack permission
 * by role, as core does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpSource } from "../src/types/dp";
import {
  contentOf,
  fakePack,
  fakeTile,
  installSources,
  installWorld,
  uninstallWorld,
  USER_ROLES,
  type FakePackOptions,
  type InstalledSources,
} from "./helpers/fake-foundry";

vi.mock("../src/render/PdfPage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/render/PdfPage")>()),
  pdfPageCount: vi.fn(async () => 12),
}));

const PACK = "world.handouts";
const ENTRY = `Compendium.${PACK}.JournalEntry.letters`;
const PAGE = `${ENTRY}.JournalEntryPage.baron`;
const PDF = `${ENTRY}.JournalEntryPage.deed`;

const handouts = (over: Partial<FakePackOptions> = {}) =>
  fakePack({
    id: PACK,
    label: "Handouts",
    entries: [
      {
        _id: "letters",
        name: "Letters",
        pages: [
          { _id: "baron", name: "The Baron's Letter" },
          { _id: "keep", name: "Map of the Keep", type: "image", src: "maps/keep.webp" },
          { _id: "deed", name: "Deed", type: "pdf", src: "deeds/deed.pdf" },
        ],
      },
    ],
    ...over,
  });

/** Ali is a player; Ben is trusted, so a pack open to trusted players only is his alone. */
const PLAYERS = [
  { id: "ali", role: USER_ROLES.PLAYER },
  { id: "ben", role: USER_ROLES.TRUSTED },
];
const TRUSTED_ONLY = { PLAYER: "NONE", TRUSTED: "OBSERVER", ASSISTANT: "OWNER" };

function pinTile(source: Partial<DpSource>, over: Record<string, any> = {}) {
  const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: ENTRY,
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
          ...source,
        },
        audience: {
          ...defaultPin().audience,
          kind: "everyone",
          ownershipSync: { enabled: true, level: 2 },
        },
        ...over,
      },
    },
  };
  return tile;
}

const pinOf = (tile: any) => tile.flags[MODULE_ID][FLAGS.PIN];

let world: ReturnType<typeof installWorld>;
let sources: InstalledSources;

function install(tile: any, pack = handouts(), isGM = true) {
  world = installWorld({ isGM, players: PLAYERS, tiles: [tile] });
  sources = installSources(world, { packs: [pack] });
  return pack;
}

beforeEach(() => vi.resetModules());
afterEach(() => uninstallWorld());

describe("what a compendium pin says it is", () => {
  it.each([
    ["the index entry", { uuid: ENTRY, pageId: "baron" }, false],
    ["the cached journal", { uuid: ENTRY, pageId: "baron" }, true],
    ["a throw, for a page whose journal is not cached", { uuid: PAGE }, false],
  ])(
    "has one label, crumb and icon whether fromUuidSync returns %s, and names the page once it loads",
    async (_shape, source, cached) => {
      const tile = pinTile(source);
      const pack = install(tile);
      if (cached) pack.holdInCache("letters");
      const { rowsFor } = await import("../src/apps/Pinboard");
      const row = () => rowsFor(world.canvas.scene)[0];

      expect(row()).toMatchObject({
        name: "Letters",
        breadcrumb: "Handouts › Letters",
        icon: "fa-file-lines",
      });

      const { resolveSource } = await import("../src/api");
      await resolveSource(pinOf(tile));
      expect(row()).toMatchObject({
        name: "The Baron's Letter",
        breadcrumb: "Handouts › Letters",
        icon: "fa-file-lines",
      });
    }
  );
});

describe("the key glyph on a compendium pin", () => {
  const unreadableByMethods = () => {
    const pack = handouts({ ownership: TRUSTED_ONLY });
    delete pack.testUserPermission;
    delete pack.getUserLevel;
    return pack;
  };

  it.each([
    ["prop", "a pack every role reads", () => handouts(), { ali: "visible", ben: "visible" }],
    [
      "prop",
      "a pack for trusted players",
      () => handouts({ ownership: TRUSTED_ONLY }),
      { ali: "seesButCannotOpen", ben: "visible" },
    ],
    ["pin", "a pack every role reads", () => handouts(), { ali: "visible", ben: "visible" }],
    [
      "pin",
      "a pack for trusted players",
      () => handouts({ ownership: TRUSTED_ONLY }),
      { ali: "seesButCannotOpen", ben: "visible" },
    ],
    [
      "prop",
      "a pack that only states its ownership",
      unreadableByMethods,
      { ali: "seesButCannotOpen", ben: "visible" },
    ],
  ])("on a %s from %s follows each player's role", async (mode, _pack, pack, expected) => {
    const tile = pinTile({ uuid: ENTRY }, { mode });
    install(tile, pack());
    const { chipUsersFor } = await import("../src/apps/PinHUD");
    const { chipState } = await import("../src/apps/chips");

    const states = Object.fromEntries(chipUsersFor(tile).map((u) => [u.id, chipState(u)]));
    expect(states).toEqual(expected);
  });
});

describe("the Audience tab on a compendium pin", () => {
  it.each([
    ["the index entry", false],
    ["the cached journal", true],
  ])(
    "says a reveal shows the content and adds nothing to sidebars, with %s",
    async (_shape, cached) => {
      const tile = pinTile({ uuid: ENTRY });
      const pack = install(tile);
      if (cached) pack.holdInCache("letters");
      const { studioMarkup } = await import("../src/apps/PinStudio");

      const markup = studioMarkup(tile, pinOf(tile), "audience");
      expect(markup).toContain('data-dp-grants="pack"');
      expect(markup).toContain("DP.studio.grantsPack");
    }
  );
});

describe("a PDF page from a compendium", () => {
  it.each([
    ["while its journal is not cached", false],
    ["while core holds it", true],
  ])("is drawn as a card everywhere %s", async (_shape, cached) => {
    // Version 2: drawn before the frame moved to the paper's centre, so the migration
    // re-anchors a card and leaves a texture where it is.
    const tile = pinTile({ uuid: PDF }, { v: 2 });
    const pack = install(tile);
    if (cached) pack.holdInCache("letters");
    const { setRasterisationAvailable } = await import("../src/render/Rasterizer");
    const { drawsAsDom } = await import("../src/canvas/PropManager");
    const { studioMarkup } = await import("../src/apps/PinStudio");
    const { migrateScene } = await import("../src/data/migrations");
    const writes = vi.spyOn(world.canvas.scene, "updateEmbeddedDocuments");

    setRasterisationAvailable(false);
    expect(drawsAsDom(pinOf(tile))).toBe(true);
    expect(studioMarkup(tile, pinOf(tile), "appearance")).not.toContain('data-dp-pdf="true"');
    await migrateScene(world.canvas.scene);
    expect((writes.mock.calls[0][1] as unknown[])[0]).toHaveProperty("x");
  });
});

describe("Pin Studio's Content tab on a compendium pin", () => {
  it.each([
    [
      "a journal, with its pages to choose from",
      { uuid: ENTRY },
      "Letters",
      '[name="source.pageId"]',
    ],
    ["a PDF page, with its page count", { uuid: PDF }, "Deed", '[name="source.pdfPage"][max="12"]'],
  ])("loads %s, and names it", async (_what, source, name, control) => {
    const tile = pinTile(source);
    install(tile);
    const { definePinStudio } = await import("../src/apps/PinStudio");
    const studio = new (definePinStudio())();
    studio.doc = tile;
    studio.tab = "content";
    await studio.render();

    const root = contentOf(studio);
    expect(root.querySelector(".dp-studio__source")!.textContent).toContain(name);
    expect(root.querySelector(control)).not.toBeNull();
    if (control.includes("pageId")) {
      const options = root.querySelectorAll<HTMLOptionElement>('[name="source.pageId"] option');
      expect([...options].map((option) => option.value)).toEqual(["", "baron", "keep", "deed"]);
    }
  });
});

describe("a player whose role cannot read the compendium", () => {
  it.each([
    ["resolves null", "null" as const],
    ["throws", "throw" as const],
  ])(
    "gets a placeholder that says why, and nothing is asked of the server (a refused load %s)",
    async (_load, refuses) => {
      const prop = pinTile({ uuid: ENTRY });
      install(prop, handouts({ ownership: TRUSTED_ONLY, refuses }), false);
      const { resolveCard } = await import("../src/render/ContentResolver");
      const { openReader } = await import("../src/apps/ReaderOverlay");
      const { openLocally } = await import("../src/api");

      const card = await resolveCard(pinOf(prop), { width: 400, height: 560 });
      expect(card).toMatchObject({ missing: true, reason: "packLocked" });

      await openReader(prop);
      expect(document.querySelector(".dp-reader")).toBeNull();

      // An icon opens the sheet rather than the reader, and says the same.
      pinOf(prop).mode = "pin";
      await openLocally(prop);

      expect(world.notifications.map((n) => n.message)).toEqual([
        "DP.notice.packLocked",
        "DP.notice.packLocked",
      ]);
      expect(sources.fromUuidCalls).toEqual([]);
    }
  );
});

describe("the GM, pointing a pin at a compendium", () => {
  const withNames = () => {
    world.game.i18n.format = (key: string, data: Record<string, unknown>) =>
      `${key} ${JSON.stringify(data)}`;
  };
  const warnings = () =>
    world.notifications.filter((n) => n.message.startsWith("DP.notice.packUnreadable"));

  const place = async (_tile: any, source: DpSource) => {
    world.canvas.scene.createEmbeddedDocuments = async (_type: string, data: any[]) =>
      data.map((d, i) => ({ ...d, id: `new${i}`, uuid: `Scene.s1.Tile.new${i}` }));
    const { pinAt } = await import("../src/api");
    await pinAt(world.canvas.scene, source, { x: 0, y: 0 });
  };
  const retarget = async (tile: any, source: DpSource) => {
    const { retarget } = await import("../src/api");
    await retarget(tile, source);
  };
  const adopt = async (tile: any, source: DpSource) => {
    tile.flags = {};
    const { adoptTile } = await import("../src/api");
    await adoptTile(tile, source);
  };

  it.each([
    ["placing, where a player's role cannot read the pack", place, TRUSTED_ONLY, 1],
    ["placing, where every role can", place, undefined, 0],
    ["retargeting, where a player's role cannot", retarget, TRUSTED_ONLY, 1],
    ["adopting a tile, where a player's role cannot", adopt, TRUSTED_ONLY, 1],
  ])(
    "is warned once, naming the pack, only when a player is left out: %s",
    async (_verb, verb, ownership, count) => {
      const tile = pinTile({ uuid: "JournalEntry.j" });
      install(tile, handouts({ ownership }));
      withNames();

      await verb(tile, { ...pinOf(tile).source, uuid: ENTRY });

      expect(warnings().map((n) => n.message)).toEqual(
        Array(count).fill('DP.notice.packUnreadable {"pack":"Handouts"}')
      );
    }
  );

  it.each([
    [
      "to the players who can read it",
      TRUSTED_ONLY,
      [["ben"]],
      ["DP.notice.packUnreadable", "DP.notice.shown"],
    ],
    [
      "to nobody, and says so, when none can",
      { PLAYER: "NONE", ASSISTANT: "OWNER" },
      [],
      ["DP.notice.packUnreadable"],
    ],
  ])("shows a compendium document %s", async (_who, ownership, shownTo, notices) => {
    const tile = pinTile({ uuid: ENTRY });
    install(tile, handouts({ ownership }));
    const { showToAudience } = await import("../src/api");

    await showToAudience(tile);

    expect(sources.shown.map((call) => call.options.users)).toEqual(shownTo);
    expect(world.notifications.map((n) => n.message)).toEqual(notices);
  });

  it.each([
    [
      "revealing it",
      async (tile: any) => {
        const { setAudience } = await import("../src/api");
        await setAudience(tile, { ...pinOf(tile).audience, kind: "everyone" });
      },
    ],
    [
      "deleting it",
      async (tile: any) => {
        const { deletePin } = await import("../src/api");
        await deletePin(tile);
      },
    ],
  ])("asks the server nothing when %s, since a pack grants nothing", async (_verb, act) => {
    const tile = pinTile({ uuid: ENTRY });
    pinOf(tile).audience.kind = "hidden";
    install(tile);

    await act(tile);

    expect(sources.fromUuidCalls).toEqual([]);
  });
});
