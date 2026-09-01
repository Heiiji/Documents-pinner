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
