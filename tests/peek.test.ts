/**
 * @vitest-environment jsdom
 *
 * Hold-to-peek is the one binding players get, and it is held: Alt down fades every prop,
 * Alt up brings them back. Alt-Tab to another application releases the key THERE, so the
 * key-up never reaches the page — and core's own keyboard, which resets its held keys
 * when the tab is hidden, emits no key-up either. The props stayed faded on return.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/apps/Pinboard", () => ({
  openPinboard: vi.fn(),
  pinboardFocusedDoc: () => null,
  revealNextOnBoard: () => false,
}));
vi.mock("../src/apps/DocumentPicker", () => ({ openPicker: vi.fn() }));

import { PEEK_CLASS, registerKeybindings } from "../src/ui/keybindings";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

let world: ReturnType<typeof installWorld>;
let peek: { onDown: () => boolean; onUp: () => boolean };

beforeEach(() => {
  document.body.innerHTML =
    '<div id="ui"><div id="board"></div><div id="documents-pinner-overlay"></div></div>';
  world = installWorld({ isGM: false });
  registerKeybindings();
  peek = world.game.keybindings.registered.find((r: any) => r.key === "peek").options;
});

afterEach(() => uninstallWorld());

const peeking = () =>
  document.getElementById("documents-pinner-overlay")!.classList.contains(PEEK_CLASS);
const lastPeekHook = () =>
  world.hooks.filter((h) => h.name === "documents-pinner.peek").at(-1)?.args[0];

describe("the peek", () => {
  /**
   * The overlay holds the DOM cards and the reader, which is all `.dp-peeking` styles.
   * The class used to land on `#board`'s parent too, an element of core's.
   */
  it("marks the overlay, and nothing of core's", () => {
    peek.onDown();
    expect(peeking()).toBe(true);
    expect(document.getElementById("ui")!.classList.contains(PEEK_CLASS)).toBe(false);
    expect(document.body.classList.contains(PEEK_CLASS)).toBe(false);

    peek.onUp();
    expect(peeking()).toBe(false);
  });

  it.each([
    ["the window loses focus", () => window.dispatchEvent(new Event("blur"))],
    ["the tab is hidden", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("lets go when %s mid-press, where the key-up never arrives", (_label, leave) => {
    peek.onDown();
    expect(peeking()).toBe(true);

    leave();
    expect(peeking()).toBe(false);
    expect(lastPeekHook()).toBe(false);
  });
});
