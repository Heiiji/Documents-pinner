/**
 * @vitest-environment jsdom
 *
 * The picker's rows were `role="option"` with no way to reach them from the keyboard:
 * a GM who typed "duke" and wanted the second match had to reach for the mouse. It is
 * a combobox now, driven entirely from the search box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentOf, installWorld, speakEnglish, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/apps/PlacementGhost", () => ({ arm: vi.fn(() => true) }));

import { arm } from "../src/apps/PlacementGhost";

let picker: any;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "";
  const world = installWorld({ isGM: true });
  world.game.journal = {
    contents: ["Alpha", "Beta", "Gamma"].map((name) => ({
      uuid: `JournalEntry.${name}`,
      name,
      pages: { contents: [] },
    })),
  };
  const { definePicker } = await import("../src/apps/DocumentPicker");
  picker = new (definePicker())();
  await picker.render();
});

afterEach(() => uninstallWorld());

const root = () => contentOf(picker);
const search = () => root().querySelector<HTMLInputElement>(".dp-picker__search")!;
const key = (k: string) =>
  search().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("the picker as a combobox", () => {
  it("marks the first match as active by default", () => {
    expect(search().getAttribute("aria-activedescendant")).toBe("dp-picker-opt-0");
    expect(root().querySelector('.dp-picker__item[aria-selected="true"]')!.id).toBe(
      "dp-picker-opt-0"
    );
  });

  it("moves the active row with the arrows, clamped at both ends", async () => {
    key("ArrowDown");
    await picker.render();
    expect(search().getAttribute("aria-activedescendant")).toBe("dp-picker-opt-1");
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown");
    await picker.render();
    expect(search().getAttribute("aria-activedescendant")).toBe("dp-picker-opt-2");
    key("Home");
    await picker.render();
    expect(search().getAttribute("aria-activedescendant")).toBe("dp-picker-opt-0");
  });

  it("takes the active row on Enter, not always the first", async () => {
    key("ArrowDown");
    await picker.render();
    key("Enter");
    expect(vi.mocked(arm)).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: "JournalEntry.Beta" })
    );
  });

  it("goes back to the first match when the search changes", async () => {
    key("ArrowDown");
    await picker.render();
    search().value = "ga";
    search().dispatchEvent(new Event("input", { bubbles: true }));
    await picker.render();
    expect(search().getAttribute("aria-activedescendant")).toBe("dp-picker-opt-0");
    expect(root().querySelectorAll(".dp-picker__item")).toHaveLength(1);
  });
});

/**
 * The intent the picker was opened with.
 *
 * `adopt` is nulled the moment it fires because the picker is one reused instance and an
 * intent left behind runs on the NEXT open. `onChoose` carries the same hazard and gets
 * the same treatment — which is why it is a callback rather than a second placeable field
 * beside `adopt`, where the two could disagree about what this open is for.
 */
describe("what the picker does with the chosen source", () => {
  // Earlier suites in this file arm the ghost, and the module mock's history outlives
  // `resetModules`.
  beforeEach(() => vi.mocked(arm).mockClear());

  it("hands the source to onChoose instead of arming the ghost", () => {
    const taken: any[] = [];
    picker.onChoose = (source: any) => taken.push(source);

    picker.take({
      kind: "document",
      uuid: "JournalEntry.Beta",
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    });

    expect(taken).toHaveLength(1);
    expect(taken[0].uuid).toBe("JournalEntry.Beta");
    expect(arm).not.toHaveBeenCalled();
  });

  it("prefers onChoose over adopt, and clears it so the next open arms again", () => {
    const taken: any[] = [];
    picker.onChoose = (source: any) => taken.push(source);
    picker.adopt = { documentName: "Tile" };
    const source = {
      kind: "document",
      uuid: "JournalEntry.Beta",
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    };

    picker.take(source);
    expect(taken).toHaveLength(1);
    expect(picker.onChoose).toBeNull();

    picker.adopt = null;
    picker.take(source);
    expect(taken).toHaveLength(1);
    expect(arm).toHaveBeenCalledTimes(1);
  });
});

/**
 * Moving the active row is two attributes on two rows and one on the search box. Each
 * press used to render the whole window — every row rebuilt and the world searched again
 * — to move one marker.
 */
describe("the arrows, without a render", () => {
  const selected = () =>
    [...root().querySelectorAll<HTMLElement>('.dp-picker__item[aria-selected="true"]')].map(
      (item) => item.id
    );

  it.each([
    ["ArrowDown", "dp-picker-opt-1"],
    ["End", "dp-picker-opt-2"],
    ["PageDown", "dp-picker-opt-2"],
  ])("%s moves the marker in place", (k, id) => {
    const render = vi.spyOn(picker, "render");
    key(k);
    expect(render).not.toHaveBeenCalled();
    expect(selected()).toEqual([id]);
    expect(search().getAttribute("aria-activedescendant")).toBe(id);
  });

  it("comes back up with ArrowUp, Home and PageUp, and stops at the top", () => {
    const render = vi.spyOn(picker, "render");
    key("End");
    key("ArrowUp");
    expect(selected()).toEqual(["dp-picker-opt-1"]);
    key("PageUp");
    expect(selected()).toEqual(["dp-picker-opt-0"]);
    key("End");
    key("Home");
    key("ArrowUp");
    expect(selected()).toEqual(["dp-picker-opt-0"]);
    expect(render).not.toHaveBeenCalled();
  });

  it("keeps the row a later render draws as active", async () => {
    key("ArrowDown");
    await picker.render();
    expect(selected()).toEqual(["dp-picker-opt-1"]);
  });

  it("brings the new active row into view", () => {
    const seen: string[] = [];
    for (const item of root().querySelectorAll<HTMLElement>(".dp-picker__item")) {
      item.scrollIntoView = () => seen.push(item.id);
    }
    key("ArrowDown");
    expect(seen).toEqual(["dp-picker-opt-1"]);
  });
});

/**
 * The focus is in the search box, where core's keyboard does nothing (its `hasFocus`), so
 * Escape on an empty search did nothing at all: the picker stayed open.
 */
describe("Escape", () => {
  it("clears a search first, and leaves the picker open", async () => {
    const close = vi.spyOn(picker, "close");
    search().value = "ga";
    search().dispatchEvent(new Event("input", { bubbles: true }));
    await picker.render();
    key("Escape");
    expect(picker.search).toBe("");
    expect(close).not.toHaveBeenCalled();
  });

  it("closes the picker when there is no search to clear", () => {
    const close = vi.spyOn(picker, "close");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    search().dispatchEvent(event);
    expect(close).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

/** The world's rows: found once per search, and at most a hundred of them. */
describe("the world's rows", () => {
  async function pickerOver(names: string[]) {
    uninstallWorld();
    vi.resetModules();
    const world = installWorld({ isGM: true });
    speakEnglish(world);
    let walks = 0;
    const contents = names.map((name) => ({
      uuid: `JournalEntry.${name}`,
      name,
      pages: { contents: [] },
    }));
    world.game.journal = {
      get contents() {
        walks++;
        return contents;
      },
    };
    const module = await import("../src/apps/DocumentPicker");
    const app = module.openPicker();
    await app.render();
    return { app, module, walks: () => walks };
  }

  it("are found when the picker opens and when the search or the chip changes", async () => {
    const { app, module, walks } = await pickerOver(["Alpha", "Beta"]);
    const opened = walks();
    expect(opened).toBeGreaterThan(0);

    // A render that changed neither — a row busy importing, an index arriving.
    await app.render();
    expect(walks()).toBe(opened);

    const field = contentOf(app).querySelector<HTMLInputElement>(".dp-picker__search")!;
    field.value = "al";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await app.render();
    expect(walks()).toBe(opened + 1);

    app.dispatch("kind", contentOf(app).querySelector('[data-dp-kind="JournalEntry"]'));
    await app.render();
    expect(walks()).toBe(opened + 2);

    // Opened again: a journal made since is listed.
    module.openPicker();
    await app.render();
    expect(walks()).toBe(opened + 3);
  });

  it("stop at WORLD_ROWS_MAX and count the rest where the world's rows end", async () => {
    const { WORLD_ROWS_MAX } = await import("../src/sources/search");
    const names = Array.from({ length: WORLD_ROWS_MAX + 20 }, (_, i) => `Note ${i}`);
    const { app } = await pickerOver(names);

    const list = contentOf(app).querySelector(".dp-picker__list")!;
    expect(list.querySelectorAll(".dp-picker__item")).toHaveLength(WORLD_ROWS_MAX);
    const more = list.querySelector(".dp-picker__more")!;
    expect(more.textContent).toBe("20 more in this world — keep typing to narrow them down.");
    expect(more.previousElementSibling?.id).toBe(`dp-picker-opt-${WORLD_ROWS_MAX - 1}`);
  });

  it("say nothing more when every match is shown", async () => {
    const { app } = await pickerOver(["Alpha", "Beta"]);
    expect(contentOf(app).querySelector(".dp-picker__more")).toBeNull();
  });
});
