/**
 * `Alt+M` — "switch the selected pin between pin and prop" — was documented in the README
 * and did not exist.
 *
 * `registerKeybindings` is called from `Hooks.once("init")`, where `game.user` is not yet
 * populated, so the `if (isGM())` gate around it was false for EVERY user including the
 * GM. The binding was never registered, so it did nothing and did not even appear in
 * Configure Controls where a GM could have rebound it.
 *
 * The gate was redundant regardless: `restricted: true` is Foundry's own GM gate, and the
 * four bindings beside it already relied on exactly that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const board = { focused: null as any };
vi.mock("../src/apps/Pinboard", () => ({
  openPinboard: vi.fn(),
  pinboardFocusedDoc: () => board.focused,
}));
vi.mock("../src/apps/DocumentPicker", () => ({ openPicker: vi.fn() }));

import * as api from "../src/api";
import { openPicker } from "../src/apps/DocumentPicker";
import { registerKeybindings } from "../src/ui/keybindings";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

/** Registration happens at `init`, so model the state `init` actually sees. */
function registerDuringInit() {
  const world = installWorld({ isGM: true });
  // At `init` Foundry has not populated `game.user` yet — the exact condition the old
  // gate was evaluated under.
  world.game.user = undefined;
  registerKeybindings();
  return world.game.keybindings.registered as { key: string; options: any }[];
}

afterEach(() => uninstallWorld());

describe("registerKeybindings", () => {
  it("registers the mode toggle even though game.user is absent at init", () => {
    const registered = registerDuringInit();
    expect(registered.map((r) => r.key)).toContain("toggleMode");
  });

  it("gates it with Foundry's own GM gate rather than a user check", () => {
    const registered = registerDuringInit();
    const toggle = registered.find((r) => r.key === "toggleMode")!;
    expect(toggle.options.restricted).toBe(true);
  });

  it("keeps Alt+M as the documented default", () => {
    const registered = registerDuringInit();
    const toggle = registered.find((r) => r.key === "toggleMode")!;
    expect(toggle.options.editable).toEqual([{ key: "KeyM", modifiers: ["Alt"] }]);
  });

  it("registers every binding the README documents", () => {
    const registered = registerDuringInit();
    expect(registered.map((r) => r.key).sort()).toEqual([
      "cancel",
      "cycleAudience",
      "fitSelected",
      "openPinboard",
      "peek",
      "pinLastUsed",
      "toggleMode",
    ]);
  });

  it("fits the selected props with Alt+Shift+F, GM-only", () => {
    // Not Alt+F: that is Chrome's menu accelerator on Windows and Linux.
    const fit = registerDuringInit().find((r) => r.key === "fitSelected")!;
    expect(fit.options.editable).toEqual([{ key: "KeyF", modifiers: ["Alt", "Shift"] }]);
    expect(fit.options.restricted).toBe(true);
  });

  it("leaves peek unrestricted — it is the one binding players get", () => {
    const registered = registerDuringInit();
    expect(registered.find((r) => r.key === "peek")!.options.restricted).toBeUndefined();
  });
});

/**
 * Three bindings returned `false` in silence when nothing was selected, so a GM who
 * pressed Alt+M learned nothing about why. Now they act on the Pinboard's focused row,
 * or say what to select.
 */
describe("a pin binding with nothing selected", () => {
  afterEach(() => {
    board.focused = null;
    vi.restoreAllMocks();
  });

  function binding(key: string) {
    const world = installWorld({ isGM: true });
    registerKeybindings();
    const found = world.game.keybindings.registered.find((r: any) => r.key === key)!;
    return { world, onDown: found.options.onDown as () => boolean };
  }

  it("says so rather than doing nothing", () => {
    const { world, onDown } = binding("toggleMode");
    expect(onDown()).toBe(true);
    expect(world.notifications.map((n) => n.type)).toContain("warn");
  });

  it("acts on the Pinboard's focused row when the board is open", () => {
    const doc = { id: "focused" };
    board.focused = doc;
    const spy = vi.spyOn(api, "toggleMode").mockImplementation(async () => {});
    const { world, onDown } = binding("toggleMode");
    onDown();
    expect(spy).toHaveBeenCalledWith(doc);
    expect(world.notifications).toEqual([]);
  });

  it("opens the picker on Shift+P when nothing has been placed yet", () => {
    const { onDown } = binding("pinLastUsed");
    expect(onDown()).toBe(true);
    expect(openPicker).toHaveBeenCalled();
  });
});
