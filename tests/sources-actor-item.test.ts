/**
 * @vitest-environment jsdom
 *
 * A pin on an Actor or an Item: a wanted poster, a found object.
 *
 * Before the source adapters, an Actor or an Item uuid was read as a journal page: its
 * `type` — a system subtype, `npc`, `weapon` — fell to the page switch's default branch,
 * the card was blank, a reveal granted OBSERVER on an NPC's whole sheet, and the chips
 * asked for a level its sheet does not need. The fake computes permission and models a
 * system's data model with HTML fields, as core does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpSource } from "../src/types/dp";
import {
  applyUpdate,
  DATA_FIELDS,
  DEFAULT_TOKEN,
  dataModel,
  fakeActor,
  fakeItem,
  fakeJournal,
  fakeTile,
  holdModifier,
  installSources,
  installWorld,
  uninstallWorld,
  type InstalledSources,
} from "./helpers/fake-foundry";

vi.mock("../src/apps/PlacementGhost", () => ({
  arm: vi.fn(() => true),
  armAt: vi.fn(() => true),
  disarm: vi.fn(),
}));

import { armAt } from "../src/apps/PlacementGhost";

const { EmbeddedDataField, HTMLField, SchemaField, StringField } = DATA_FIELDS;

const SECRET = '<section class="secret"><p>He is the mayor.</p></section>';

/** A dnd5e-like NPC: a private biography walked BEFORE the public one. */
const dndNpc = () =>
  dataModel({
    details: new SchemaField({
      biography: new SchemaField({ value: new HTMLField(), public: new HTMLField() }),
    }),
    attributes: new SchemaField({ hp: new SchemaField({ value: new StringField() }) }),
  });
/** A pf2e-like NPC: public and private notes. */
const pfNpc = () =>
  dataModel({
    details: new SchemaField({ privateNotes: new HTMLField(), publicNotes: new HTMLField() }),
  });
/** A pf2e-like item: the players' description beside the GM's, which no section marks. */
const pfItem = () =>
  dataModel({
    description: new EmbeddedDataField(dataModel({ gm: new HTMLField(), value: new HTMLField() })),
  });

const jack = (over: Record<string, any> = {}) =>
  fakeActor({
    id: "jack",
    name: "Black Jack",
    type: "npc",
    img: "portraits/jack.webp",
    system: {
      details: {
        biography: { value: "<p>Owes the guild.</p>", public: `<p>Wanted: 50 gold.</p>${SECRET}` },
      },
      attributes: { hp: { value: 12 } },
    },
    ...over,
  });

const amulet = (over: Record<string, any> = {}) =>
  fakeItem({
    id: "amulet",
    name: "Strange Amulet",
    type: "trinket",
    img: "items/amulet.webp",
    system: { description: { gm: "<p>Cursed.</p>", value: "<p>Warm to the touch.</p>" } },
    ...over,
  });

function pinTile(source: Partial<DpSource>, over: Record<string, any> = {}) {
  const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: "Actor.jack",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
          field: null,
          ...source,
        },
        audience: {
          ...defaultPin().audience,
          kind: "everyone",
          ownershipSync: { enabled: false, level: 2 },
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

function install(
  options: {
    tiles?: any[];
    journals?: any[];
    actors?: any[];
    items?: any[];
    userId?: string;
    model?: Record<string, Record<string, unknown>>;
    settings?: Record<string, unknown>;
  } = {}
) {
  world = installWorld({
    isGM: !options.userId,
    userId: options.userId,
    tiles: options.tiles ?? [],
    settings: options.settings,
  });
  sources = installSources(world, {
    journals: options.journals ?? [],
    actors: options.actors ?? [],
    items: options.items ?? [],
    model: options.model,
  });
  const config = (globalThis as any).CONFIG;
  if (!options.model) {
    config.Actor.dataModels.npc = dndNpc();
    config.Item.dataModels.trinket = pfItem();
  }
}

const SIZE = { width: 400, height: 560 };

/** The card a pin draws for this client, taken apart. */
async function cardOf(tile: any) {
  const { resolveCard } = await import("../src/render/ContentResolver");
  const card = await resolveCard(pinOf(tile), SIZE);
  const root = new DOMParser().parseFromString(card.html, "text/html");
  return {
    card,
    layout: root.querySelector(".dp-card")?.getAttribute("data-dp-layout") ?? null,
    portrait: root.querySelector(".dp-card__portrait img")?.getAttribute("src") ?? null,
    title: root.querySelector(".dp-card__title")?.textContent ?? null,
    body: root.querySelector(".dp-card__body")?.innerHTML ?? "",
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.mocked(armAt).mockClear();
  document.body.innerHTML = '<div id="board"></div>';
});
afterEach(() => uninstallWorld());

describe("the card of an actor or an item", () => {
  it.each([
    [
      "an actor shows its portrait",
      () => jack(),
      "Actor.jack",
      { portrait: "portraits/jack.webp", title: "Black Jack", text: "Wanted: 50 gold." },
    ],
    [
      "an actor with a default portrait shows its token",
      () => jack({ img: DEFAULT_TOKEN, token: "tokens/jack.webp" }),
      "Actor.jack",
      { portrait: "tokens/jack.webp", title: "Black Jack", text: "Wanted: 50 gold." },
    ],
    [
      "an actor whose token is a default too shows no picture",
      () => jack({ img: DEFAULT_TOKEN, token: DEFAULT_TOKEN }),
      "Actor.jack",
      { portrait: null, title: "Black Jack", text: "Wanted: 50 gold." },
    ],
    [
      "an item shows its image",
      () => amulet(),
      "Item.amulet",
      { portrait: "items/amulet.webp", title: "Strange Amulet", text: "Warm to the touch." },
    ],
  ])("is a portrait card: %s above its name and its text", async (_what, doc, uuid, expected) => {
    const tile = pinTile({ uuid });
    const made = doc();
    install({
      tiles: [tile],
      actors: [made].filter((d) => d.documentName === "Actor"),
      items: [made].filter((d) => d.documentName === "Item"),
    });

    const { layout, portrait, title, body } = await cardOf(tile);

    expect({ layout, portrait, title }).toEqual({
      layout: "portrait",
      portrait: expected.portrait,
      title: expected.title,
    });
    expect(body).toContain(expected.text);
  });
});

describe("the text an actor's or an item's card shows", () => {
  const actorWith = (system: Record<string, unknown>) => () =>
    jack({ system, img: "portraits/jack.webp" });

  it.each([
    [
      "dnd5e's public biography, not the private one before it",
      null,
      () => jack(),
      {},
      "Wanted: 50 gold.",
      "Owes the guild.",
    ],
    [
      "pf2e's public notes, never the private ones",
      null,
      actorWith({
        details: {
          privateNotes: "<p>Plans a heist.</p>",
          publicNotes: "<p>Seen at the docks.</p>",
        },
      }),
      { npc: pfNpc },
      "Seen at the docks.",
      "Plans a heist.",
    ],
    [
      "pf2e's item description, never the GM's",
      null,
      () => amulet(),
      {},
      "Warm to the touch.",
      "Cursed.",
    ],
    [
      "a template.json system's biography",
      null,
      actorWith({
        details: {
          biography: { value: "<p>Born in a ditch.</p>" },
          gmnotes: "<p>Dies in act 3.</p>",
        },
      }),
      { model: { Actor: { npc: { details: { biography: { value: "" }, gmnotes: "" } } } } },
      "Born in a ditch.",
      "Dies in act 3.",
    ],
    [
      "the GM's choice, when the type declares it",
      "details.biography.value",
      () => jack(),
      {},
      "Owes the guild.",
      "Wanted: 50 gold.",
    ],
    [
      "the automatic text for a path the type does not declare",
      "attributes.hp.value",
      () => jack(),
      {},
      "Wanted: 50 gold.",
      "12",
    ],
    [
      "the automatic text for a walk into the prototype",
      "constructor.prototype",
      () => jack(),
      {},
      "Wanted: 50 gold.",
      "function",
    ],
  ])("is %s", async (_what, field, doc, setup: any, shown, never) => {
    const made = doc();
    const tile = pinTile({ uuid: made.uuid, field });
    install({
      tiles: [tile],
      actors: made.documentName === "Actor" ? [made] : [],
      items: made.documentName === "Item" ? [made] : [],
      model: setup.model,
    });
    if (setup.npc) (globalThis as any).CONFIG.Actor.dataModels.npc = setup.npc();

    const { body } = await cardOf(tile);

    expect(body).toContain(shown);
    expect(body).not.toContain(never);
  });
});

describe("a secret in an actor's biography", () => {
  it.each([
    ["is stripped for a player who does not own the actor", "ali", false],
    ["reaches the player who owns it", "ben", true],
    ["reaches the GM", undefined, true],
  ])("%s, on the card and in the reader", async (_who, userId, seen) => {
    const tile = pinTile({ uuid: "Actor.jack" });
    install({ tiles: [tile], actors: [jack({ ownership: { ben: 3 } })], userId });
    const { openReader } = await import("../src/apps/ReaderOverlay");

    const { body } = await cardOf(tile);
    await openReader(tile);
    const reader = document.querySelector(".dp-reader")?.innerHTML ?? "";

    expect(body).toContain("Wanted: 50 gold.");
    expect(reader).toContain("Wanted: 50 gold.");
    expect(body.includes("He is the mayor.")).toBe(seen);
    expect(reader.includes("He is the mayor.")).toBe(seen);
  });
});

describe("revealing an actor or an item", () => {
  /** `pinAt`, onto a scene that makes real anchors. */
  async function place(uuid: string) {
    world.canvas.scene.createEmbeddedDocuments = async (_type: string, data: any[]) =>
      data.map((fields, i) => {
        const tile = fakeTile({ id: `new${i}`, uuid: `Scene.s1.Tile.new${i}` });
        applyUpdate(tile, fields);
        return tile;
      });
    const { pinAt } = await import("../src/api");
    return pinAt(world.canvas.scene, { ...pinOf(pinTile({})).source, uuid }, { x: 0, y: 0 });
  }

  it.each([
    ["an actor: Limited at most, and only once the GM switches access on", "Actor.jack", false, 1],
    ["an item: the level the pin asks for", "Item.amulet", true, 2],
    ["an item an actor owns: nothing, on it or on the actor", "Actor.jack.Item.knife", true, null],
  ])("grants %s, and releasing gives it all back", async (_what, uuid, synced, level) => {
    const actor = jack();
    const knife = fakeItem({ id: "knife", name: "Knife", parent: actor });
    install({ actors: [actor], items: [amulet()] });
    const doc = {
      "Actor.jack": actor,
      "Item.amulet": world.game.items.get("amulet"),
      "Actor.jack.Item.knife": knife,
    }[uuid];
    const { setAudience, deletePin } = await import("../src/api");

    const anchor = await place(uuid);
    expect(pinOf(anchor).audience.ownershipSync.enabled).toBe(synced);
    await setAudience(anchor, {
      ...pinOf(anchor).audience,
      kind: "everyone",
      ownershipSync: { enabled: true, level: 2 },
    });
    expect(doc.ownership).toEqual(level === null ? {} : { default: level });
    expect(actor.ownership).toEqual(uuid === "Actor.jack" ? { default: 1 } : {});

    await deletePin(anchor);
    expect(doc.ownership).toEqual({});
    expect(actor.ownership).toEqual({});
  });
});

describe("retargeting a pin onto an actor", () => {
  const rook = () =>
    fakeActor({
      id: "rook",
      name: "Rook",
      type: "npc",
      system: {
        details: {
          biography: {
            value: "<p>ROOK GM NOTES: he is the spy.</p>",
            public: "<p>Wanted on sight.</p>",
          },
        },
      },
    });

  it.each([
    [
      "from an actor whose text was chosen, the choice stays behind",
      "Actor.jack",
      { field: "details.biography.value", sync: false },
      { field: null, synced: false, notices: [], listed: {} },
    ],
    [
      "from a journal shared with access, access goes off and the GM is told",
      "JournalEntry.letter",
      { field: null, sync: true },
      { field: null, synced: false, notices: ["DP.notice.retargetSyncOff"], listed: {} },
    ],
    [
      "from an actor the GM opened access on, access stays on",
      "Actor.jack",
      { field: null, sync: true },
      { field: null, synced: true, notices: [], listed: { default: 1 } },
    ],
  ])("%s", async (_what, from, before, expected) => {
    const tile = pinTile({ uuid: from, field: before.field });
    pinOf(tile).audience.ownershipSync.enabled = before.sync;
    const target = rook();
    install({
      tiles: [tile],
      journals: [fakeJournal({ id: "letter", name: "Letter" })],
      actors: [jack(), target],
    });
    const { retarget } = await import("../src/api");

    // The source the picker, a menu and `/pin` hand over: it names no field.
    await retarget(tile, {
      kind: "document",
      uuid: "Actor.rook",
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    });
    const { body } = await cardOf(tile);

    expect({
      field: pinOf(tile).source.field,
      synced: pinOf(tile).audience.ownershipSync.enabled,
      notices: world.notifications.map((n) => n.message),
      listed: target.ownership,
    }).toEqual(expected);
    expect(body).toContain("Wanted on sight.");
    expect(body).not.toContain("he is the spy");
  });
});

describe("an actor's icon, for a player", () => {
  it.each([
    ["at Limited: no key on their chip, and its sheet opens", "ali", "visible", 1, []],
    [
      "below Limited: a key on their chip, and a 'not yet'",
      "ben",
      "seesButCannotOpen",
      0,
      ["DP.notice.cannotOpenYet"],
    ],
  ])("%s", async (_what, userId, chip, renders, notices) => {
    const tile = pinTile({ uuid: "Actor.jack" }, { mode: "pin" });
    const actor = jack({ ownership: { ali: 1 } });
    install({ tiles: [tile], actors: [actor], userId });
    const { chipUsersFor } = await import("../src/apps/PinHUD");
    const { chipState } = await import("../src/apps/chips");
    const { openLocally } = await import("../src/api");

    expect(chipState(chipUsersFor(tile).find((u) => u.id === userId)!)).toBe(chip);
    await openLocally(tile);

    expect(actor.sheet.rendered).toHaveLength(renders);
    expect(world.notifications.map((n) => n.message)).toEqual(notices);
  });
});

describe("Show to players on an actor", () => {
  it("says it shows journals only, and claims nothing", async () => {
    const tile = pinTile({ uuid: "Actor.jack" });
    install({ tiles: [tile], actors: [jack()] });
    const { showToAudience } = await import("../src/api");

    await showToAudience(tile);

    expect(sources.shown).toEqual([]);
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.showJournalsOnly"]);
  });
});

describe("dropping an actor or an item on the map", () => {
  const MODIFIER = { alt: "Alt", ctrl: "Control", shift: "Shift", none: null } as const;

  it.each([
    [
      "an item from the sidebar",
      "alt",
      { type: "Item", uuid: "Item.amulet" },
      false,
      "Item.amulet",
      [],
    ],
    [
      "an item from a compendium",
      "alt",
      { type: "Item", uuid: "Compendium.world.loot.Item.amulet" },
      false,
      "Compendium.world.loot.Item.amulet",
      [],
    ],
    [
      "an actor with Alt, core's hidden token",
      "alt",
      { type: "Actor", uuid: "Actor.jack" },
      undefined,
      null,
      [],
    ],
    [
      "an actor with no modifier, core's token",
      "none",
      { type: "Actor", uuid: "Actor.jack" },
      undefined,
      null,
      [],
    ],
    ["an actor with Ctrl", "ctrl", { type: "Actor", uuid: "Actor.jack" }, false, "Actor.jack", []],
    [
      "an item an actor owns",
      "alt",
      { type: "Item", uuid: "Actor.jack.Item.knife" },
      false,
      null,
      ["DP.notice.embeddedRefused"],
    ],
    [
      "a token's actor",
      "shift",
      { type: "Actor", uuid: "Scene.s1.Token.t1.Actor.jack" },
      false,
      null,
      ["DP.notice.embeddedRefused"],
    ],
  ])("takes %s as the modifier says", async (_what, modifier, data, returned, armed, notices) => {
    install({ settings: { dropModifier: modifier } });
    const key = MODIFIER[modifier as keyof typeof MODIFIER];
    if (key) holdModifier(key);
    const { onDropCanvasData } = await import("../src/ui/entry-points");

    expect(onDropCanvasData(world.canvas, { ...data, x: 10, y: 20 })).toBe(returned);
    expect(vi.mocked(armAt).mock.calls.map((call) => call[0].uuid)).toEqual(armed ? [armed] : []);
    expect(world.notifications.map((n) => n.message)).toEqual(notices);
  });
});

describe("Pin Studio on an actor or an item", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("offers the actor's texts by their labels, with no page to choose, and stores the choice", async () => {
    const tile = pinTile({ uuid: "Actor.jack" });
    install({ tiles: [tile], actors: [jack()] });
    world.game.i18n.format = (key: string, data: Record<string, unknown>) =>
      `${key} ${JSON.stringify(data)}`;
    const { definePinStudio } = await import("../src/apps/PinStudio");
    const studio = new (definePinStudio())();
    studio.doc = tile;
    studio.tab = "content";
    await studio.render();
    const root = studio.content as HTMLElement;
    const select = root.querySelector<HTMLSelectElement>('[name="source.field"]')!;

    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["", 'DP.studio.textAutomatic {"label":"Details › Biography › Public"}'],
      ["details.biography.value", "Details › Biography › Value"],
      ["details.biography.public", "Details › Biography › Public"],
    ]);
    expect(root.querySelector('[name="source.pageId"], [name="source.pdfPage"]')).toBeNull();

    const stored: unknown[] = [];
    for (const value of ["details.biography.value", ""]) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      stored.push(pinOf(tile).source.field);
    }
    expect(stored).toEqual(["details.biography.value", null]);
  });

  it.each([
    ["an actor's reveal grants Limited alone, and says why", "Actor.jack", "actor", ["1"]],
    ["an item's reveal grants the level asked", "Item.amulet", "item", ["2", "1"]],
  ])("%s, on the Audience tab", async (_what, uuid, scope, levels) => {
    const tile = pinTile({ uuid });
    pinOf(tile).audience.ownershipSync.enabled = true;
    install({ tiles: [tile], actors: [jack()], items: [amulet()] });
    const { studioMarkup } = await import("../src/apps/PinStudio");

    const tab = document.createElement("div");
    tab.innerHTML = studioMarkup(tile, pinOf(tile), "audience");

    expect(tab.querySelector("[data-dp-grants]")?.getAttribute("data-dp-grants")).toBe(scope);
    const options = tab.querySelectorAll<HTMLOptionElement>(
      '[name="audience.ownershipSync.level"] option'
    );
    expect([...options].map((option) => option.value)).toEqual(levels);
  });
});
