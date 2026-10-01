/**
 * @vitest-environment jsdom
 *
 * A key a window handles does not reach core's keyboard as well.
 *
 * Core listens for `keydown` on the WINDOW, as it bubbles, and never asks whether the
 * event was `defaultPrevented` (foundry.mjs 133518, 133972); it holds its bindings back
 * only while `hasFocus` says a field has the keyboard, and a Pinboard row is an `<li>`
 * while a button counts only inside a `<form>` (133681). So Space on a row revealed the
 * pin and toggled core's pause for the whole table, an Escape that cleared the search
 * closed every window, and an arrow moved the row and panned the map.
 *
 * The spy below sits where core's listener does: on the window, bubbling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));
// The board's verbs: what each does is tested elsewhere; here only where the key goes.
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  toggleVisibility: vi.fn(async () => {}),
  toggleMode: vi.fn(async () => {}),
  locate: vi.fn(async () => {}),
  openLocally: vi.fn(async () => {}),
  flash: vi.fn(),
  spotlight: vi.fn(async () => {}),
  showToAudience: vi.fn(async () => {}),
  reorder: vi.fn(async () => {}),
  revealNext: vi.fn(async () => ({ doc: null, left: 0 })),
}));
vi.mock("../src/apps/PlacementGhost", () => ({ arm: vi.fn(() => true) }));

function pinned(id: string, sort: number) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, sort });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        display: { ...defaultPin().display, label: `Pin ${id}` },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

/** What core's window listener heard, in order. */
let heard: string[] = [];
const core = (event: KeyboardEvent) => heard.push(event.key);

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  heard = [];
  window.addEventListener("keydown", core);
});

afterEach(async () => {
  window.removeEventListener("keydown", core);
  (await import("../src/apps/CheatSheet")).closeCheatSheet();
  uninstallWorld();
});

type Mods = { shift?: boolean; alt?: boolean };

/** Press a key where the focus is; whether the press was prevented. */
function press(target: EventTarget, key: string, mods: Mods = {}): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function openBoard() {
  installWorld({ isGM: true, tiles: [pinned("t1", 0), pinned("t2", 10), pinned("t3", 20)] });
  const { definePinboard } = await import("../src/apps/Pinboard");
  const board = new (definePinboard())();
  document.body.appendChild(contentOf(board));
  await board.render();
  const row = () => contentOf(board).querySelector<HTMLElement>('.dp-row[tabindex="0"]')!;
  row().focus();
  return { board, row, root: () => contentOf(board) };
}

describe("the Pinboard's keys stop at the board", () => {
  it.each<[string, string, Mods]>([
    ["Space reveals", " ", {}],
    ["Shift+Space spotlights", " ", { shift: true }],
    ["Enter opens the Studio", "Enter", {}],
    ["L finds", "l", {}],
    ["O opens", "o", {}],
    ["F flashes", "f", {}],
    ["M changes the shape", "m", {}],
    ["Shift+S shows", "S", { shift: true }],
    ["N reveals next", "n", {}],
    ["ArrowDown moves", "ArrowDown", {}],
    ["ArrowUp moves", "ArrowUp", {}],
    ["Shift+ArrowDown extends", "ArrowDown", { shift: true }],
    ["Alt+ArrowDown reorders", "ArrowDown", { alt: true }],
    ["/ searches", "/", {}],
    ["? opens the sheet", "?", { shift: true }],
  ])("%s on a focused row, and core never hears it", async (_label, key, mods) => {
    const { row } = await openBoard();
    expect(press(row(), key, mods)).toBe(true);
    await settle();
    expect(heard).toEqual([]);
  });

  it("still lets core hear a key the board does not handle", async () => {
    const { row } = await openBoard();
    expect(press(row(), "q")).toBe(false);
    // A bare S is not Shift+S: nothing on the board, and not the board's to keep.
    expect(press(row(), "s")).toBe(false);
    expect(heard).toEqual(["q", "s"]);
  });

  it("keeps an Escape that cleared the selection", async () => {
    const { board, row } = await openBoard();
    board.selected = ["t1"];
    await board.render();
    press(row(), "Escape");
    await settle();
    expect(board.selected).toEqual([]);
    expect(heard).toEqual([]);
  });

  it("keeps an Escape that cleared the search", async () => {
    const { board, root } = await openBoard();
    const search = root().querySelector<HTMLInputElement>(".dp-board__search")!;
    search.focus();
    search.value = "Pin";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    press(root().querySelector<HTMLInputElement>(".dp-board__search")!, "Escape");
    await settle();
    expect(board.query.search).toBe("");
    expect(heard).toEqual([]);
  });

  it("hands core an Escape with nothing to clear, which closes the window as core does", async () => {
    const { row } = await openBoard();
    expect(press(row(), "Escape")).toBe(false);
    expect(heard).toEqual(["Escape"]);
  });

  it("keeps the keys of an open row menu", async () => {
    const { board } = await openBoard();
    board.menu = { id: "t1", kind: "actions", top: 0, right: 0 };
    await board.render();
    const item = contentOf(board).querySelector<HTMLElement>(".dp-menu button")!;
    press(item, "ArrowDown");
    press(document.activeElement!, "Escape");
    await settle();
    expect(board.menu).toBeNull();
    expect(heard).toEqual([]);
  });

  it("keeps the Escape that closes the sheet", async () => {
    const { row } = await openBoard();
    press(row(), "?", { shift: true });
    expect(document.querySelector(".dp-cheat")).not.toBeNull();
    press(row(), "Escape");
    expect(document.querySelector(".dp-cheat")).toBeNull();
    expect(heard).toEqual([]);
  });
});

/**
 * A focused button presses on Space or Enter — that is the key's default action, and it
 * must still happen, so it is stopped and never prevented. Core counts a button as a
 * field only inside a `<form>`, and these three windows are `<section>`s.
 */
describe("Space and Enter on a focused button stop at the window", () => {
  it.each([" ", "Enter"])("on the board: %j presses the button and nothing else", async (key) => {
    const { root } = await openBoard();
    for (const selector of [
      '.dp-row [data-action="locate"]',
      '[data-action="hideAll"]',
      '[data-action="cheatSheet"]',
      ".dp-chip",
    ]) {
      const button = root().querySelector<HTMLElement>(selector)!;
      button.focus();
      expect(press(button, key), selector).toBe(false);
    }
    expect(heard).toEqual([]);
  });

  it("on the board, a button still lets other keys through", async () => {
    const { root } = await openBoard();
    const button = root().querySelector<HTMLElement>('[data-action="hideAll"]')!;
    button.focus();
    press(button, "q");
    expect(heard).toEqual(["q"]);
  });

  it("in the picker: a kind chip and Browse", async () => {
    const world = installWorld({ isGM: true });
    world.game.journal = { contents: [] };
    const { definePicker } = await import("../src/apps/DocumentPicker");
    const picker = new (definePicker())();
    document.body.appendChild(contentOf(picker));
    await picker.render();
    for (const selector of ['[data-action="kind"]', '[data-action="browse"]']) {
      const button = contentOf(picker).querySelector<HTMLElement>(selector)!;
      button.focus();
      press(button, " ");
      press(button, "Enter");
    }
    expect(heard).toEqual([]);
  });

  it("in the Preset Studio: a button and a layer's summary", async () => {
    installWorld({ isGM: true });
    const { definePresetStudio } = await import("../src/apps/PresetStudio");
    const studio = new (definePresetStudio())();
    document.body.appendChild(contentOf(studio));
    await studio.render();
    for (const selector of ['[data-action="duplicate"]', "summary"]) {
      const control = contentOf(studio).querySelector<HTMLElement>(selector)!;
      control.focus();
      press(control, " ");
      press(control, "Enter");
    }
    expect(heard).toEqual([]);
  });
});
