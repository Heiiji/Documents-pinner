/**
 * @vitest-environment jsdom
 *
 * The "…" button was labelled "More actions" and opened the Studio, which is what Enter
 * already did. It is a menu now; the bulk bar is always there; a row can be moved from
 * the keyboard; and a drag shows where it will land.
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
let world: ReturnType<typeof installWorld>;
let tiles: any[];

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "";
  tiles = [pinnedTile("t1", 0), pinnedTile("t2", 10), pinnedTile("t3", 20)];
  world = installWorld({ isGM: true, tiles });
  world.canvas.scene.updates = [];
  world.canvas.scene.updateEmbeddedDocuments = async (_type: string, updates: any[]) => {
    world.canvas.scene.updates.push(updates);
    return updates;
  };
  const { definePinboard } = await import("../src/apps/Pinboard");
  board = new (definePinboard())();
  await board.render();
});

afterEach(() => uninstallWorld());

const root = () => contentOf(board);
const menuButton = (id: string) =>
  root().querySelector<HTMLElement>(`.dp-row[data-dp-id="${id}"] [data-action="rowMenu"]`)!;

/** Dispatch and let the re-render it triggers land. */
async function act(action: string, target?: HTMLElement) {
  await board.dispatch(action, target);
  await board.render();
}

const key = (init: KeyboardEventInit) =>
  root()
    .querySelector(".dp-board")!
    .dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));

describe("the row menu", () => {
  it("opens beside the button with every verb the row has", async () => {
    await act("rowMenu", menuButton("t2"));
    const menu = root().querySelector<HTMLElement>(".dp-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.dataset.dpId).toBe("t2");
    const acts = [...menu.querySelectorAll<HTMLElement>("[data-dp-act]")].map(
      (b) => b.dataset.dpAct
    );
    expect(acts).toEqual(["visibility", "show", "shape", "fit", "locate", "studio", "delete"]);
  });

  it("closes on Escape and on a second press of its button", async () => {
    await act("rowMenu", menuButton("t2"));
    expect(root().querySelector(".dp-menu")).not.toBeNull();
    key({ key: "Escape" });
    await board.render();
    expect(root().querySelector(".dp-menu")).toBeNull();

    await act("rowMenu", menuButton("t2"));
    await act("rowMenu", menuButton("t2"));
    expect(root().querySelector(".dp-menu")).toBeNull();
  });

  it("switches the shape from the menu and closes", async () => {
    await act("rowMenu", menuButton("t2"));
    const shape = root().querySelector<HTMLElement>('[data-dp-act="shape"]')!;
    expect(shape).not.toBeNull();
    await act("menuAct", shape);
    expect(tiles[1].flags["documents-pinner"].pin.mode).toBe("pin");
    expect(root().querySelector(".dp-menu")).toBeNull();
  });
});

describe("the bulk bar", () => {
  it("is always there, with nothing selected as a disabled state", () => {
    const bar = root().querySelector<HTMLElement>(".dp-board__bulk")!;
    expect(bar).not.toBeNull();
    for (const button of bar.querySelectorAll("button")) expect(button.disabled).toBe(true);
  });
});

describe("reordering", () => {
  const written = () =>
    (world.canvas.scene as any).updates?.flatMap((call: any[]) =>
      call.map((u) => [u._id, u.sort])
    ) ?? [];

  it("moves the focused row one step with Alt and an arrow", async () => {
    board.focusedId = "t1";
    key({ key: "ArrowDown", altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written()).toEqual(
      expect.arrayContaining([
        ["t2", 0],
        ["t1", 10],
      ])
    );
  });

  it("marks the row under the pointer with the side the drag will land on", () => {
    const list = root().querySelector<HTMLElement>(".dp-board")!;
    const grip = root().querySelector<HTMLElement>('.dp-row[data-dp-id="t1"] [data-dp-grip]')!;
    const target = root().querySelector<HTMLElement>('.dp-row[data-dp-id="t3"]')!;
    target.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120 }) as DOMRect;

    // jsdom has no DragEvent; the handlers read only what a MouseEvent carries.
    grip.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("dragover", { bubbles: true, clientY: 115 }));
    expect(target.dataset.dpDrop).toBe("after");
    target.dispatchEvent(new MouseEvent("dragover", { bubbles: true, clientY: 102 }));
    expect(target.dataset.dpDrop).toBe("before");

    list.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
    expect(target.dataset.dpDrop).toBeUndefined();
  });
});

describe("an empty scene", () => {
  it("says what to do and offers to place a pin, rather than just that there is nothing", async () => {
    const { boardMarkup } = await import("../src/apps/Pinboard");
    const markup = boardMarkup([], { filter: "all", search: "", level: null }, [], null, "Keep");
    expect(markup).toContain("DP.board.emptyHint");
    expect(markup).toMatch(/dp-board__empty[\s\S]*data-action="place"/);
  });
});
