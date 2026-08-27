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
import { afterEach, describe, expect, it } from "vitest";
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
      "openPinboard",
      "peek",
      "pinLastUsed",
      "toggleMode",
    ]);
  });

  it("leaves peek unrestricted — it is the one binding players get", () => {
    const registered = registerDuringInit();
    expect(registered.find((r) => r.key === "peek")!.options.restricted).toBeUndefined();
  });
});
