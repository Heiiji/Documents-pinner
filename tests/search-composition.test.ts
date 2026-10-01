/**
 * @vitest-environment jsdom
 *
 * A word being composed is not a search yet.
 *
 * A dead key's accent and an IME's syllables arrive as `input` events with `isComposing`
 * set. The Pinboard and the picker searched — and so re-rendered, rebuilding the field —
 * on every one of them, which dropped the composition: "é" on a dead-key layout, or any
 * Japanese, Chinese or Korean word, could not be typed into either search box. Chrome
 * sends no plain `input` once the composition ends (core says as much, foundry.mjs
 * 133982), so the search runs on `compositionend`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));
vi.mock("../src/apps/PlacementGhost", () => ({ arm: vi.fn(() => true) }));

function pinned(id: string, label: string) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, sort: 0 });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        display: { ...defaultPin().display, label },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
});

afterEach(() => uninstallWorld());

/** Compose `word` into the field the way a browser does: input events, then the end. */
async function compose(field: () => HTMLInputElement, steps: string[]) {
  field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  for (const step of steps) {
    field().value = step;
    field().dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    await settle();
  }
  field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await settle();
}

describe.each(["board", "picker"] as const)("the %s's search box", (surface) => {
  async function open() {
    if (surface === "board") {
      installWorld({ isGM: true, tiles: [pinned("t1", "Été"), pinned("t2", "Hiver")] });
      const { definePinboard } = await import("../src/apps/Pinboard");
      const app = new (definePinboard())();
      document.body.appendChild(contentOf(app));
      await app.render();
      return {
        app,
        field: () => contentOf(app).querySelector<HTMLInputElement>(".dp-board__search")!,
        searched: () => app.query.search as string,
      };
    }
    const world = installWorld({ isGM: true });
    world.game.journal = {
      contents: ["Été", "Hiver"].map((name) => ({
        uuid: `JournalEntry.${name}`,
        name,
        pages: { contents: [] },
      })),
    };
    const { definePicker } = await import("../src/apps/DocumentPicker");
    const app = new (definePicker())();
    document.body.appendChild(contentOf(app));
    await app.render();
    return {
      app,
      field: () => contentOf(app).querySelector<HTMLInputElement>(".dp-picker__search")!,
      searched: () => app.search as string,
    };
  }

  it("does not render while a word is being composed", async () => {
    const { app, field } = await open();
    field().focus();
    const before = app.renderCount;
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field().value = "´";
    field().dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    await settle();

    expect(app.renderCount).toBe(before);
    // The field the GM is composing in is the same element, still holding the accent.
    expect(field().value).toBe("´");
  });

  it("searches once the composition ends, and only once", async () => {
    const { app, field, searched } = await open();
    field().focus();
    const before = app.renderCount;
    await compose(field, ["´", "é"]);
    expect(searched()).toBe("é");
    expect(app.renderCount).toBe(before + 1);

    // A browser that follows the end with a plain `input` finds the search done.
    field().dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(app.renderCount).toBe(before + 1);
  });

  it("still searches on every plain keystroke", async () => {
    const { app, field, searched } = await open();
    field().focus();
    const before = app.renderCount;
    field().value = "h";
    field().dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    field().value = "hi";
    field().dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(searched()).toBe("hi");
    expect(app.renderCount).toBe(before + 2);
  });
});
