/**
 * @vitest-environment jsdom
 *
 * The picker's rows were `role="option"` with no way to reach them from the keyboard:
 * a GM who typed "duke" and wanted the second match had to reach for the mouse. It is
 * a combobox now, driven entirely from the search box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentOf, installWorld, uninstallWorld } from "./helpers/fake-foundry";

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
