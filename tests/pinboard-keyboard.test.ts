/**
 * @vitest-environment jsdom
 *
 * DoD #12 and acceptance criterion 16: "the Pinboard is fully operable one-handed from
 * the keyboard". It was unmet on every path, while `DP.board.help` advertised ten
 * shortcuts that could not be reached.
 *
 * The key handler sits on the board root, so it needs focus inside the window — and
 * nothing ever focused a row. `focusedId` starts null so no row is tabbable, `P` opened
 * the board with nothing focused, clicking a row focused the `<li>` and then `#select`
 * re-rendered and `replaceChildren` destroyed it, and the search box swallowed
 * everything except Escape and `/`.
 *
 * `focusIndex()` and `.dp-row:focus-visible` were correct code waiting for a caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

function pinnedTile(id: string, sort: number) {
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

let board: any;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "";

  const tiles = [pinnedTile("t1", 0), pinnedTile("t2", 10), pinnedTile("t3", 20)];
  installWorld({ isGM: true, tiles });

  const { definePinboard } = await import("../src/apps/Pinboard");
  board = new (definePinboard())();
  board.query = { filter: "all", search: "", level: null };
  board.selected = [];
  board.focusedId = null;
  document.body.appendChild(contentOf(board));
  await board.render();
});

afterEach(() => uninstallWorld());

const rows = () => [...contentOf(board).querySelectorAll<HTMLElement>(".dp-row")];
const root = () => contentOf(board).querySelector<HTMLElement>(".dp-board")!;

async function press(key: string, target: HTMLElement = root(), init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  // The handlers render, and the fake application's render is async.
  await Promise.resolve();
  await Promise.resolve();
}

describe("the Pinboard's keyboard surface", () => {
  it("focuses the first row on the initial render, so a keystroke has a target", () => {
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0].tabIndex).toBe(0);
  });

  it("moves the focus one row down and takes the DOM focus with it", async () => {
    await press("ArrowDown");

    expect(board.focusedId).toBe("t2");
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("moves back up again", async () => {
    await press("ArrowDown");
    await press("ArrowUp");

    expect(board.focusedId).toBe("t1");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("keeps focus on the row a click selected, which the re-render used to destroy", async () => {
    rows()[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(board.focusedId).toBe("t3");
    expect(document.activeElement).toBe(rows()[2]);
  });

  it("lets ArrowDown carry the GM out of the search box and into the list", async () => {
    const search = contentOf(board).querySelector<HTMLInputElement>(".dp-board__search")!;
    search.focus();
    expect(document.activeElement).toBe(search);

    await press("ArrowDown", search);

    expect(document.activeElement?.classList.contains("dp-row")).toBe(true);
  });

  it("leaves typing in the search box alone", async () => {
    const search = contentOf(board).querySelector<HTMLInputElement>(".dp-board__search")!;
    search.focus();
    const before = board.focusedId;

    await press("l", search);
    expect(board.focusedId).toBe(before);
  });

  it("does not fire a row shortcut while a BUTTON has focus", async () => {
    const api = await import("../src/api");
    const spy = vi.spyOn(api, "locate").mockImplementation(async () => {});

    const button = rows()[0].querySelector<HTMLElement>('[data-action="locate"]')!;
    button.focus();
    await press("l", button);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps the caret in the search box while the GM types", async () => {
    const search = contentOf(board).querySelector<HTMLInputElement>(".dp-board__search")!;
    search.focus();
    search.value = "Pin t2";
    search.setSelectionRange(6, 6);
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const after = contentOf(board).querySelector<HTMLInputElement>(".dp-board__search")!;
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(6);
  });
});
