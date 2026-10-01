/**
 * @vitest-environment jsdom
 *
 * A pin on a whole journal, which shows one of its pages.
 *
 * It showed `pages.contents[0]`, the first page CREATED, whatever the journal's own order and
 * whatever the page's own permission said: a location journal whose "GM notes" were written
 * before its reordered "Handout" put the notes on the map for every player.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import {
  fakeJournal,
  fakeTile,
  installSources,
  installWorld,
  OWNERSHIP_LEVELS,
  uninstallWorld,
} from "./helpers/fake-foundry";

const { NONE, LIMITED } = OWNERSHIP_LEVELS;

/** A journal whose pages were created in this order, each with its sort and own default. */
function journal(pages: { id: string; sort: number; own?: number }[]) {
  const entry = fakeJournal({
    id: "keep",
    name: "The Keep",
    pages: pages.map(({ id }) => ({ id, name: id })),
  });
  for (const { id, sort, own } of pages) {
    Object.assign(entry.pages.get(id), {
      sort,
      text: { content: `<p>${id} text</p>` },
      ownership: own === undefined ? { default: OWNERSHIP_LEVELS.INHERIT } : { default: own },
    });
  }
  return entry;
}

beforeEach(() => vi.resetModules());
afterEach(() => uninstallWorld());

describe("a pin on a whole journal", () => {
  it.each([
    [
      "the first page in the journal's order, not the first written",
      "ali",
      [
        { id: "notes", sort: 200 },
        { id: "handout", sort: 100 },
      ],
      "handout text",
    ],
    [
      "past a page its own permission keeps from the players — on the GM's screen too",
      undefined,
      [
        { id: "notes", sort: 100, own: NONE },
        { id: "handout", sort: 200 },
      ],
      "handout text",
    ],
    [
      "nothing, when every page keeps itself from the players",
      "ali",
      [
        { id: "notes", sort: 100, own: NONE },
        { id: "aside", sort: 200, own: LIMITED },
      ],
      "",
    ],
  ])("shows %s", async (_what, userId, pages, shown) => {
    const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
    tile.flags = {
      [MODULE_ID]: {
        [FLAGS.PIN]: {
          ...defaultPin(),
          source: { ...defaultPin().source, uuid: "JournalEntry.keep" },
        },
      },
    };
    const world = installWorld({ isGM: !userId, userId, tiles: [tile] });
    installSources(world, { journals: [journal(pages)] });
    const { resolveCard } = await import("../src/render/ContentResolver");

    const card = await resolveCard(tile.flags[MODULE_ID][FLAGS.PIN], { width: 400, height: 560 });
    const body = new DOMParser()
      .parseFromString(card.html, "text/html")
      .querySelector(".dp-card__body");

    expect(body?.textContent?.trim()).toBe(shown);
  });

  it("lists its pages in the Studio in the journal's order", async () => {
    const world = installWorld({ isGM: true });
    installSources(world, {
      journals: [
        journal([
          { id: "notes", sort: 200 },
          { id: "handout", sort: 100 },
        ]),
      ],
    });
    const { pageChoices } = await import("../src/api");

    const pin = { ...defaultPin(), source: { ...defaultPin().source, uuid: "JournalEntry.keep" } };

    expect(pageChoices(pin).map((page) => page.id)).toEqual(["handout", "notes"]);
  });
});
