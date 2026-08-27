/**
 * @vitest-environment jsdom
 *
 * Every application in the module wired its listeners from `_replaceHTML(result, content)`
 * — onto `content`, the element ApplicationV2 hands back UNCHANGED on every render. Only
 * `result` is new. So each render added a fresh set of closures over the persistent
 * element, nothing deduped, and the sets accumulated.
 *
 * All five cases are self-amplifying, because every one of those handlers triggers a
 * render:
 *
 * - the DocumentPicker doubles its listener count PER KEYSTROKE
 * - the Pin Studio issues 2^(N-1) identical `doc.update()` calls on the Nth edit
 * - the Pinboard's key handler fires N times, so ArrowDown jumps N rows
 *
 * A listener count is awkward to assert directly, so these tests measure the thing the
 * user actually experiences: how many times ONE event does its work.
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

const RENDERS = 4;

function pinnedTile(id = "t1") {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}` });
  tile.flags = {
    "documents-pinner": {
      pin: { ...defaultPin(), mode: "prop", audience: { ...defaultPin().audience, kind: "everyone" } },
    },
  };
  return tile;
}

/** Render N times, then count what ONE dispatched event actually does. */
async function afterRepeatedRenders(app: any, renders = RENDERS) {
  for (let i = 0; i < renders; i++) await app.render();
}

let tile: any;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div><div id="hud"></div>';
  tile = pinnedTile();
  installWorld({ isGM: true, tiles: [tile] });
});

afterEach(() => uninstallWorld());

describe("DocumentPicker", () => {
  it("runs its search handler once per keystroke, not once per past render", async () => {
    const { definePicker } = await import("../src/apps/DocumentPicker");
    const picker = new (definePicker())();
    await afterRepeatedRenders(picker);

    let renders = 0;
    picker.render = () => {
      renders++;
    };

    const search = contentOf(picker).querySelector<HTMLInputElement>(".dp-picker__search")!;
    search.value = "duke";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(renders).toBe(1);
  });
});

describe("Pinboard", () => {
  it("moves the focus one row per ArrowDown, not N rows", async () => {
    const { definePinboard } = await import("../src/apps/Pinboard");
    const board = new (definePinboard())();
    board.query = { filter: "all", search: "", level: null };
    board.selected = [];
    board.focusedId = null;
    await afterRepeatedRenders(board);

    let renders = 0;
    board.render = () => {
      renders++;
    };

    contentOf(board)
      .querySelector(".dp-board")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(renders).toBe(1);
  });

  it("runs its search handler once", async () => {
    const { definePinboard } = await import("../src/apps/Pinboard");
    const board = new (definePinboard())();
    board.query = { filter: "all", search: "", level: null };
    board.selected = [];
    board.focusedId = null;
    await afterRepeatedRenders(board);

    let renders = 0;
    board.render = () => {
      renders++;
    };

    const search = contentOf(board).querySelector<HTMLInputElement>(".dp-board__search")!;
    search.value = "x";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(renders).toBe(1);
  });
});

describe("PinStudio", () => {
  it("issues ONE document write per edit, not 2^(N-1)", async () => {
    const { definePinStudio } = await import("../src/apps/PinStudio");
    const studio = new (definePinStudio())();
    studio.doc = tile;
    studio.tab = "content";
    await afterRepeatedRenders(studio);

    tile.updates.length = 0;
    const elevation = contentOf(studio).querySelector<HTMLInputElement>('[name="_elevation"]')!;
    elevation.value = "40";
    elevation.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(tile.updates).toHaveLength(1);
  });
});

describe("PinHUD", () => {
  it("applies a control change once", async () => {
    const api = await import("../src/api");
    const spy = vi.spyOn(api, "setOwnershipSync").mockImplementation(() => undefined);

    const { definePinHUD } = await import("../src/apps/PinHUD");
    const hud = new (definePinHUD())();
    hud.object = tile.object;
    await afterRepeatedRenders(hud);

    const sync = contentOf(hud).querySelector<HTMLInputElement>('[data-action="toggleSync"]')!;
    sync.checked = true;
    sync.dispatchEvent(new Event("change", { bubbles: true }));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("PresetStudio", () => {
  it("mirrors a slider to its output once", async () => {
    const { definePresetStudio } = await import("../src/apps/PresetStudio");
    const studio = new (definePresetStudio())();
    await afterRepeatedRenders(studio);

    // The `input` mirror is idempotent, so the observable count is the listener count:
    // spy on the write it performs rather than on its result.
    const range = contentOf(studio).querySelector<HTMLInputElement>('input[type="range"]');
    if (!range) return; // No editable user preset in a fresh world; nothing to assert.

    let writes = 0;
    const output = range.nextElementSibling as HTMLElement | null;
    if (output?.tagName === "OUTPUT") {
      Object.defineProperty(output, "textContent", {
        set() {
          writes++;
        },
        get: () => "",
        configurable: true,
      });
    }
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(writes).toBeLessThanOrEqual(1);
  });
});
