/**
 * @vitest-environment jsdom
 *
 * E2 — the `?` cheat sheet. Nine surfaces and some twenty-five shortcuts, of which the
 * ghost's E V R F and the board's L O M F cannot be rebound, and the one surface that
 * taught itself was a legend a GM can switch off.
 *
 * The tables in `ui/cheatsheet.ts` are data beside the handlers, not read by them, so the
 * first test here is what keeps them honest: it presses every key a table lists and every
 * key a keyboard has, on every surface, and fails when the two disagree either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));
// The board's verbs: a key only has to reach one here; what each does is tested elsewhere.
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  toggleVisibility: vi.fn(async () => {}),
  toggleMode: vi.fn(async () => {}),
  locate: vi.fn(async () => {}),
  openLocally: vi.fn(async () => {}),
  flash: vi.fn(),
  spotlight: vi.fn(async () => {}),
  showToAudience: vi.fn(async () => {}),
  revealNext: vi.fn(async () => ({ doc: null, left: 0 })),
}));

type Mods = { shift?: boolean; alt?: boolean; ctrl?: boolean };
type SurfaceName = "ghost" | "board" | "hud";

interface Surface {
  /** Press a key where the surface listens (or on `target`); whether the surface took it. */
  press(key: string, mods?: Mods, target?: EventTarget): boolean;
  /** A field whose keystrokes are text, not shortcuts. */
  field(): HTMLElement;
  /** True while the surface's own Escape has not acted. */
  untouched(): boolean;
  /** Click the surface's `?` button, when it has one. */
  click?(): void;
}

const source = {
  kind: "document" as const,
  uuid: "JournalEntry.abc",
  src: null,
  pageId: null,
  pdfPage: null,
  followName: true,
};

function pinned(id: string, sort: number) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, sort });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

function keydown(target: EventTarget, key: string, mods: Mods = {}): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

let cleanup: (() => void)[] = [];

const mount: Record<SurfaceName, () => Promise<Surface>> = {
  async ghost() {
    installWorld({ isGM: true });
    const ghost = await import("../src/apps/PlacementGhost");
    ghost.arm(source);
    cleanup.push(() => ghost.disarm());
    const chat = document.body.appendChild(document.createElement("textarea"));
    return {
      press: (key, mods, target = document.body) => keydown(target, key, mods),
      field: () => chat,
      untouched: () => ghost.isArmed(),
    };
  },

  async board() {
    installWorld({ isGM: true, tiles: [pinned("t1", 0), pinned("t2", 10)] });
    const { definePinboard } = await import("../src/apps/Pinboard");
    const board = new (definePinboard())();
    document.body.appendChild(contentOf(board));
    await board.render();
    board.selected = ["t1"];
    const row = () => contentOf(board).querySelector<HTMLElement>('.dp-row[tabindex="0"]')!;
    const button = () => contentOf(board).querySelector<HTMLElement>('[data-action="cheatSheet"]')!;
    return {
      press: (key, mods, target = row()) => keydown(target, key, mods),
      field: () => contentOf(board).querySelector<HTMLElement>(".dp-board__search")!,
      untouched: () => board.selected.length === 1,
      click: () => board.dispatch("cheatSheet", button()),
    };
  },

  async hud() {
    document.body.innerHTML = '<div id="hud"></div>';
    const tile = pinned("t1", 0);
    installWorld({ isGM: true, tiles: [tile] });
    const { definePinHUD } = await import("../src/apps/PinHUD");
    const hud = new (definePinHUD())();
    document.body.appendChild(contentOf(hud));
    await hud.bind(tile.object);
    const release = vi.fn();
    tile.object.release = release;
    const first = () => contentOf(hud).querySelector<HTMLElement>(".dp-hud__btn")!;
    const button = () => contentOf(hud).querySelector<HTMLElement>('[data-action="cheatSheet"]')!;
    return {
      // Escape with no palette open lets go of the pin without preventing anything.
      press: (key, mods, target = first()) => {
        const before = release.mock.calls.length;
        return keydown(target, key, mods) || release.mock.calls.length > before;
      },
      field: () => contentOf(hud).querySelector<HTMLElement>('[data-action="setIntensity"]')!,
      untouched: () => release.mock.calls.length === 0,
      click: () => hud.dispatch("cheatSheet", button()),
    };
  },
};

const sheet = () => document.querySelector<HTMLElement>(".dp-cheat");

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const off of cleanup) off();
  cleanup = [];
  (await import("../src/apps/CheatSheet")).closeCheatSheet();
  uninstallWorld();
});

const SURFACES: SurfaceName[] = ["ghost", "board", "hud"];

describe("the tables and the handlers", () => {
  const KEYS = [
    ..."abcdefghijklmnopqrstuvwxyz0123456789/?.,-=",
    " ",
    "Enter",
    "Escape",
    "Tab",
    "Backspace",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "F2",
  ];
  const MODS: Mods[] = [{}, { shift: true }, { alt: true }, { ctrl: true }];
  const typed = (key: string, mods: Mods) =>
    mods.shift && key.length === 1 ? key.toUpperCase() : key;

  it.each(SURFACES)("the %s sheet lists exactly the keys its handler takes", async (name) => {
    const surface = await mount[name]();
    const { CHEAT_SHEETS } = await import("../src/ui/cheatsheet");
    const { closeCheatSheet } = await import("../src/apps/CheatSheet");
    // The ghost's handler asks `stepKey`, which is pure; the others are pressed for real.
    const { stepKey, initialState } = await import("../src/apps/PlacementGhost");
    const takes = (key: string, mods: Mods) => {
      const taken =
        name === "ghost"
          ? stepKey(initialState(source, "prop"), key, { shift: mods.shift }) !== null
          : surface.press(key, mods);
      closeCheatSheet();
      return taken;
    };
    const chords = CHEAT_SHEETS[name].rows.flatMap((row) => ("chords" in row ? row.chords : []));

    const unanswered = chords
      .filter((c) => c.key !== undefined && !takes(typed(c.key, c), c))
      .map((c) => JSON.stringify(c));
    expect(unanswered).toEqual([]);

    // A modifier the handler ignores is not a second key: `L` locates with Alt held too.
    const listed = (key: string, mods: Mods) =>
      chords.some(
        (c) =>
          c.key?.toLowerCase() === key.toLowerCase() &&
          (!c.shift || mods.shift) &&
          (!c.alt || mods.alt) &&
          (!c.ctrl || mods.ctrl)
      );
    const unlisted = KEYS.flatMap((key) =>
      MODS.filter((mods) => takes(typed(key, mods), mods) && !listed(key, mods)).map(
        (mods) => `${JSON.stringify(mods)} ${key}`
      )
    );
    expect(unlisted).toEqual([]);
  });

  it("lists every Configure Controls action on a sheet, and none that is not registered", async () => {
    const world = installWorld({ isGM: true });
    (await import("../src/ui/keybindings")).registerKeybindings();
    const { CHEAT_SHEETS } = await import("../src/ui/cheatsheet");
    const registered = world.game.keybindings.registered.map((r: any) => r.key as string);
    const listed = Object.values(CHEAT_SHEETS).flatMap((sheet) =>
      sheet.rows.flatMap((row) => ("action" in row ? [row.action] : []))
    );
    expect(listed.filter((action) => !registered.includes(action))).toEqual([]);
    // `cancel` is the ghost's own Escape, which its sheet lists as a key.
    expect(registered.filter((action: string) => !listed.includes(action))).toEqual(["cancel"]);
  });
});

describe("opening and closing", () => {
  it.each(SURFACES)(
    "the %s answers ?, and Escape takes the sheet down before it acts",
    async (name) => {
      const surface = await mount[name]();

      expect(surface.press("?", { shift: true })).toBe(true);
      const open = sheet()!;
      expect(open.dataset.dpSurface).toBe(name);
      expect(open.getAttribute("role")).toBe("dialog");
      expect(document.getElementById(open.getAttribute("aria-labelledby")!)).not.toBeNull();
      expect(open.contains(document.activeElement)).toBe(true);

      // Escape where the surface listens: the sheet goes, and the surface does nothing.
      surface.press("Escape");
      expect(sheet()).toBeNull();
      expect(surface.untouched()).toBe(true);

      // Escape in the sheet itself, `?` again, and a click outside all close it too.
      surface.press("?", { shift: true });
      keydown(document.activeElement!, "Escape");
      expect(sheet()).toBeNull();
      surface.press("?", { shift: true });
      surface.press("?", { shift: true });
      expect(sheet()).toBeNull();
      surface.press("?", { shift: true });
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(sheet()).toBeNull();
      expect(surface.untouched()).toBe(true);

      // The `?` button, where there is one, toggles it.
      if (surface.click) {
        surface.click();
        expect(sheet()?.dataset.dpSurface).toBe(name);
        surface.click();
        expect(sheet()).toBeNull();
      }
    }
  );

  it.each(SURFACES)("the %s leaves a ? typed into a field to the field", async (name) => {
    const surface = await mount[name]();
    const field = surface.field();
    field.focus();
    expect(surface.press("?", { shift: true }, field)).toBe(false);
    expect(sheet()).toBeNull();
    // The same key, out of the field, is the surface's.
    expect(surface.press("?", { shift: true })).toBe(true);
    expect(sheet()).not.toBeNull();
  });
});

describe("Configure Controls on the sheet", () => {
  it("names each binding as the GM set it, and never guesses one it cannot read", async () => {
    const world = installWorld({ isGM: true });
    (await import("../src/ui/keybindings")).registerKeybindings();
    const { toggleCheatSheet, closeCheatSheet, bindingName } =
      await import("../src/apps/CheatSheet");
    const row = (action: string) =>
      [...document.querySelectorAll<HTMLElement>(".dp-cheat__row")].find(
        (r) => r.querySelector("dd")?.textContent === `DP.keys.${action}`
      )!;
    const keys = (action: string) =>
      [...row(action).querySelectorAll("kbd")].map((k) => k.textContent);

    const rebound = { key: "KeyB", modifiers: ["Shift"] };
    await world.game.keybindings.set("documents-pinner", "openPinboard", [rebound]);
    toggleCheatSheet("board");
    expect(keys("openPinboard")).toEqual([bindingName(rebound)]);
    // Shipped unbound: said so, not printed as a key.
    expect(keys("revealNext")).toEqual([]);
    expect(row("revealNext").textContent).toContain("DP.cheat.unbound");
    closeCheatSheet();

    world.game.keybindings.get = () => {
      throw new Error("This is not a registered keybind action");
    };
    toggleCheatSheet("board");
    expect(keys("openPinboard")).toEqual([]);
    expect(row("openPinboard").textContent).toContain("DP.cheat.unknown");
  });
});
