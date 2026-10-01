/**
 * @vitest-environment jsdom
 *
 * A window popped out of the main one keeps its focus, its caret and its cheat sheet.
 *
 * Every framed ApplicationV2 can be detached into a window of its own (foundry.mjs 31375),
 * and core's own focus test reads that window's document (133682). The module read the
 * main `document`: there the active element is not in the application at all, so every
 * render of a detached board, picker or studio dropped the focus and the caret, and the
 * board's `?` put its sheet up in the main window, behind the GM's back. `instanceof
 * HTMLInputElement` failed the same way — an input of another window is an instance of
 * THAT window's class.
 *
 * The second window is an iframe's: it has a document of its own, its own element classes
 * and its own focus, as a popup does — and moving an application's element into it is
 * what core's detach does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { validatePreset } from "../src/effects/preset-schema";
import { restoreFocus, snapshotFocus } from "../src/apps/focus-restore";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";
import { getCorePreset } from "./helpers/presets";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));
vi.mock("../src/apps/PlacementGhost", () => ({ arm: vi.fn(() => true) }));

/** A second window, with a document of its own. */
function popup(): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  return frame.contentDocument!;
}

/** Move an application into another window, as core's detach moves its element. */
function detach(app: any, into: Document) {
  into.body.appendChild(app.content);
  app.element = app.content;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

function pinned(id: string, sort: number) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, sort });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        display: { ...defaultPin().display, label: `Pin ${id}` },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

let other: Document;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  other = popup();
});

afterEach(async () => {
  (await import("../src/apps/CheatSheet")).closeCheatSheet();
  uninstallWorld();
});

describe("focus-restore in another window", () => {
  it("finds the focused field, its draft and its caret again", () => {
    const root = other.createElement("div");
    root.innerHTML = '<input type="text" name="display.label" value="Ledger">';
    other.body.appendChild(root);
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.focus();
    input.value = "Ledgers";
    input.setSelectionRange(3, 3);

    const snapshot = snapshotFocus(root);
    root.innerHTML = '<input type="text" name="display.label" value="Ledger">';
    restoreFocus(root, snapshot);

    const after = root.querySelector<HTMLInputElement>("input")!;
    expect(other.activeElement).toBe(after);
    expect(after.value).toBe("Ledgers");
    expect(after.selectionStart).toBe(3);
  });
});

describe("a detached Pinboard", () => {
  async function board() {
    installWorld({ isGM: true, tiles: [pinned("t1", 0), pinned("t2", 10), pinned("t3", 20)] });
    const { definePinboard } = await import("../src/apps/Pinboard");
    const app = new (definePinboard())();
    detach(app, other);
    await app.render();
    return app;
  }
  const rows = (app: any) => [...contentOf(app).querySelectorAll<HTMLElement>(".dp-row")];

  it("keeps the caret in its search box while the GM types", async () => {
    const app = await board();
    const search = contentOf(app).querySelector<HTMLInputElement>(".dp-board__search")!;
    search.focus();
    search.value = "Pin t";
    search.setSelectionRange(3, 3);
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const after = contentOf(app).querySelector<HTMLInputElement>(".dp-board__search")!;
    expect(other.activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);
  });

  it("keeps the focus on the row the arrows reach", async () => {
    const app = await board();
    rows(app)[0].focus();
    rows(app)[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await settle();

    expect(app.focusedId).toBe("t2");
    expect(other.activeElement).toBe(rows(app)[1]);
  });

  it("puts its cheat sheet up in its own window, and takes it down there", async () => {
    const app = await board();
    const row = rows(app)[0];
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));

    expect(other.querySelector(".dp-cheat")).not.toBeNull();
    expect(document.querySelector(".dp-cheat")).toBeNull();

    // A press anywhere else in that window closes it — the listener is where the sheet is.
    other.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(other.querySelector(".dp-cheat")).toBeNull();
  });

  it("gives the focus back to the row its sheet was opened from", async () => {
    const app = await board();
    const row = rows(app)[0];
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    other
      .querySelector<HTMLElement>(".dp-cheat")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(other.querySelector(".dp-cheat")).toBeNull();
    expect(other.activeElement).toBe(row);
  });

  it("opens the sheet from its `?` button in its own window", async () => {
    const app = await board();
    const button = contentOf(app).querySelector<HTMLElement>('[data-action="cheatSheet"]')!;
    app.dispatch("cheatSheet", button);
    expect(other.querySelector(".dp-cheat")).not.toBeNull();
    expect(document.querySelector(".dp-cheat")).toBeNull();
  });
});

describe("a detached picker", () => {
  it("keeps the caret in its search box while the GM types", async () => {
    const world = installWorld({ isGM: true });
    world.game.journal = {
      contents: ["Alpha", "Gamma", "Gambit"].map((name) => ({
        uuid: `JournalEntry.${name}`,
        name,
        pages: { contents: [] },
      })),
    };
    const { definePicker } = await import("../src/apps/DocumentPicker");
    const picker = new (definePicker())();
    detach(picker, other);
    await picker.render();

    const search = contentOf(picker).querySelector<HTMLInputElement>(".dp-picker__search")!;
    search.focus();
    search.value = "gamb";
    search.setSelectionRange(2, 2);
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const after = contentOf(picker).querySelector<HTMLInputElement>(".dp-picker__search")!;
    expect(other.activeElement).toBe(after);
    expect(after.selectionStart).toBe(2);
  });
});

describe("a detached Preset Studio", () => {
  it("keeps the focus on the slider a GM is moving", async () => {
    const mine = validatePreset({
      ...getCorePreset("aged-parchment")!,
      id: "mine",
      label: "Mine",
      author: "user",
    }).preset!;
    const world = installWorld({ isGM: true, settings: { userPresets: [mine] } });
    const { definePresetStudio } = await import("../src/apps/PresetStudio");
    const studio = new (definePresetStudio())();
    studio.selectedId = "mine";
    detach(studio, other);
    await studio.render();

    const slider = contentOf(studio).querySelector<HTMLInputElement>('[name="tint.amount"]')!;
    slider.focus();
    slider.value = "0.5";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect((world.game.settings.get("", "userPresets") as any[])[0].params.tint.amount).toBe(0.5)
    );
    await settle();

    expect((other.activeElement as HTMLInputElement | null)?.name).toBe("tint.amount");
  });
});

describe("a detached Pin Studio", () => {
  it("renames its own title bar", async () => {
    const tile = pinned("t1", 0);
    tile.flags[MODULE_ID][FLAGS.PIN].display.label = "The Duke's Letter";
    const world = installWorld({ isGM: true, tiles: [tile] });
    world.game.i18n.format = (key: string, data: any) => `${key}|${data.name}`;
    const { definePinStudio } = await import("../src/apps/PinStudio");
    const studio = new (definePinStudio())();
    studio.doc = tile;
    studio.tab = "content";
    const title = other.createElement("h1");
    other.body.appendChild(title);
    studio.window = { title };
    detach(studio, other);
    await studio.render();

    expect(title.textContent).toBe("DP.studio.titleFor|The Duke's Letter");
  });
});
