/**
 * @vitest-environment jsdom
 *
 * The Pinboard half of the UX audit's Medium and Low findings: the one outward-facing
 * verb on a bare letter, an effect that cycled one save at a time, a board that kept the
 * last scene's rows, a list whose rows could not hold the controls they held, and a
 * shortcut line in Mac glyphs for everyone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

function pinnedTile(id: string, sort: number, audience: Record<string, unknown> = {}) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, sort });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: "JournalEntry.j",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
        },
        display: { ...defaultPin().display, label: `Pin ${id}` },
        audience: { ...defaultPin().audience, kind: "everyone", ...audience },
      },
    },
  };
  return tile;
}

let board: any;
let world: ReturnType<typeof installWorld>;
let tiles: any[];
let show: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "";
  tiles = [pinnedTile("t1", 0), pinnedTile("t2", 10)];
  world = installWorld({ isGM: true, tiles });
  world.canvas.scene.id = "s1";
  show = vi.fn(async () => {});
  (globalThis as any).foundry.documents = { collections: { Journal: { show } } };
  (globalThis as any).fromUuid = async () => ({ name: "Letter", documentName: "JournalEntry" });
  const { definePinboard } = await import("../src/apps/Pinboard");
  board = new (definePinboard())();
  await board.render();
  document.body.appendChild(contentOf(board));
});

afterEach(() => {
  delete (globalThis as any).fromUuid;
  uninstallWorld();
});

const root = () => contentOf(board);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = (init: KeyboardEventInit) =>
  root()
    .querySelector(".dp-board")!
    .dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));

describe("the list's semantics", () => {
  it("is a multi-select grid of rows of cells, which may hold controls", () => {
    const list = root().querySelector(".dp-board__list")!;
    expect(list.getAttribute("role")).toBe("grid");
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    const row = root().querySelector<HTMLElement>(".dp-row")!;
    expect(row.getAttribute("role")).toBe("row");
    for (const child of row.children) expect(child.getAttribute("role")).toBe("gridcell");
    // No option anywhere: an option may not contain a button.
    expect(root().querySelector('[role="option"]')).toBeNull();
  });

  it("shows what a journal row points at, not the placeholder every journal pin shares", async () => {
    (globalThis as any).fromUuidSync = () => ({ documentName: "JournalEntry", name: "Letter" });
    await board.render();
    delete (globalThis as any).fromUuidSync;
    const row = root().querySelector<HTMLElement>(".dp-row")!;
    expect(row.querySelector("img.dp-row__thumb")).toBeNull();
    expect(row.querySelector(".dp-row__thumb--icon .fa-book")).not.toBeNull();
  });

  it("marks a row whose document is gone, rather than drawing the same book", () => {
    const row = root().querySelector<HTMLElement>(".dp-row")!;
    expect(row.querySelector(".dp-row__thumb--icon .fa-circle-question")).not.toBeNull();
  });

  it("uses Foundry's tooltip, not the browser's", () => {
    expect(root().querySelector(".dp-row [title]")).toBeNull();
    expect(root().querySelector('[data-action="locate"][data-tooltip-text]')).not.toBeNull();
  });
});

describe("showing a document to the table", () => {
  it("needs Shift: a bare letter is what a GM types expecting to jump to a row", async () => {
    key({ key: "s" });
    await tick();
    expect(show).not.toHaveBeenCalled();

    key({ key: "S", shiftKey: true });
    await tick();
    await tick();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][1]).toMatchObject({ force: true, users: ["ali", "ben"] });
    expect(world.notifications.map((n) => n.message)).toContain("DP.notice.shown");
  });

  it("says so when nobody in the audience can see the pin, instead of nothing", async () => {
    tiles[0].hidden = true;
    tiles[0].flags["documents-pinner"].pin.audience.kind = "hidden";
    key({ key: "S", shiftKey: true });
    await tick();
    await tick();
    expect(show).not.toHaveBeenCalled();
    expect(world.notifications.map((n) => n.message)).toContain("DP.notice.showNobody");
  });
});

describe("the effect menu", () => {
  const fx = (id: string) =>
    root().querySelector<HTMLElement>(`.dp-row[data-dp-id="${id}"] [data-action="effectMenu"]`)!;

  it("lists the whole library with the current effect checked, and one choice is one write", async () => {
    await board.dispatch("effectMenu", fx("t2"));
    await board.render();
    const menu = root().querySelector<HTMLElement>(".dp-menu--effects")!;
    expect(menu).not.toBeNull();
    const checked = menu.querySelectorAll('[role="menuitemradio"][aria-checked="true"]');
    expect(checked).toHaveLength(1);
    expect(fx("t2").getAttribute("aria-expanded")).toBe("true");

    const glitch = menu.querySelector<HTMLElement>('[data-dp-preset="glitch"]')!;
    await board.dispatch("menuAct", glitch);
    await board.render();
    expect(tiles[1].flags["documents-pinner"].pin.effect.id).toBe("glitch");
    expect(root().querySelector(".dp-menu")).toBeNull();
  });

  it("opens upward from a row near the foot of the board, and scrolls within the room it has", async () => {
    const { placeMenu } = await import("../src/apps/Pinboard");
    const boardRect = { top: 0, bottom: 500, right: 700 };
    const low = placeMenu("t1", "effect", boardRect, { top: 460, bottom: 480, right: 650 });
    expect(low.bottom).toBe(40);
    expect(low.top).toBeUndefined();
    expect(low.maxHeight).toBe(452);

    const high = placeMenu("t1", "effect", boardRect, { top: 20, bottom: 40, right: 650 });
    expect(high.top).toBe(40);
    expect(high.bottom).toBeUndefined();
  });
});

describe("visibility counts", () => {
  it("counts a selection that names nobody as hidden, as its chips already said", async () => {
    tiles[1].flags["documents-pinner"].pin.audience.kind = "selected";
    tiles[1].flags["documents-pinner"].pin.audience.users = [];
    await board.render();
    const row = root().querySelector<HTMLElement>('.dp-row[data-dp-id="t2"]')!;
    expect(row.dataset.dpVisible).toBe("false");
    expect(root().querySelector(".dp-board__totals")!.textContent).toContain("DP.board.totals");
  });
});

describe("a scene change", () => {
  it("drops the old scene's selection and focus rather than acting on nothing", async () => {
    board.selected = ["t1", "t2"];
    board.focusedId = "t2";
    world.canvas.scene = {
      ...world.canvas.scene,
      id: "s2",
      name: "Another",
      tiles: { contents: [], get: () => null },
    };
    await board.render();
    expect(board.selected).toEqual([]);
    expect(root().querySelector(".dp-board__scene")!.textContent).toBe("Another");
    for (const button of root().querySelectorAll<HTMLButtonElement>(".dp-board__bulk button")) {
      expect(button.disabled).toBe(true);
    }
  });
});

describe("the shortcut line", () => {
  it("names the modifiers as the keyboard does, and ⌘ on a Mac", async () => {
    (globalThis as any).game.i18n.format = (_key: string, data: any) =>
      `${data.alt}|${data.shift}|${data.ctrl}`;
    const { boardHelp } = await import("../src/apps/Pinboard");
    const { modifierGlyphs } = await import("../src/ui/modifiers");
    expect(boardHelp(modifierGlyphs("mac"))).toBe("⌥|⇧|⌘");
    expect(boardHelp(modifierGlyphs("other"))).toBe("Alt+|Shift+|Ctrl+");
  });
});
