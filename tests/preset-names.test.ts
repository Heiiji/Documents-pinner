/**
 * @vitest-environment jsdom
 *
 * A preset's name, as the GM reads it, on every surface that shows one.
 *
 * Every surface put a preset's label through `t()`, which prefixes `DP.` to anything, and
 * core's `localize` hands back a key it does not know unchanged: a world's own "Blood
 * Moon" read "DP.Blood Moon" in the HUD's gallery, the Studio's, the board's effect menu,
 * the Preset Studio and the ghost's chip. And 0.4.0's Duplicate stored the copy of a
 * shipped preset as `"DP.preset.agedParchment (copy)"`, a key no table defines, which read
 * as exactly that.
 *
 * Asserted in English (`speakEnglish`), on what the GM sees rather than which key was
 * asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin, validatePin } from "../src/data/pin-schema";
import { validatePreset, type DpPreset } from "../src/effects/preset-schema";
import {
  contentOf,
  fakeTile,
  installWorld,
  speakEnglish,
  uninstallWorld,
} from "./helpers/fake-foundry";
import { getCorePreset } from "./helpers/presets";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

/** A world-authored preset, as the library stores one. */
const userPreset = (id: string, label: string): DpPreset =>
  validatePreset({ ...getCorePreset("aged-parchment")!, id, label, author: "user" }).preset!;

const BLOOD_MOON = userPreset("blood-moon", "Blood Moon");
/** What 0.4.0's Duplicate stored for a copy of Aged Parchment. */
const LEGACY_COPY = userPreset("dp-preset-agedparchment-copy", "DP.preset.agedParchment (copy)");

let world: ReturnType<typeof installWorld>;

function install(presets: DpPreset[] = [BLOOD_MOON, LEGACY_COPY], tiles: any[] = []) {
  world = installWorld({ isGM: true, tiles, settings: { userPresets: presets } });
  speakEnglish(world);
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
});

afterEach(() => uninstallWorld());

const texts = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent?.trim() ?? "");

function parse(markup: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
}

/** The two names, and no `DP.` anywhere among the names a surface shows. */
function expectWords(names: string[]) {
  expect(names).toContain("Blood Moon");
  expect(names).toContain("Aged Parchment (copy)");
  expect(names.filter((name) => name.includes("DP."))).toEqual([]);
}

describe("presetName", () => {
  it("translates a shipped preset, and shows a world's own words as they are", async () => {
    install();
    const { presetName } = await import("../src/effects/preset-library");
    expect(presetName(getCorePreset("aged-parchment")!)).toBe("Aged Parchment");
    expect(presetName(BLOOD_MOON)).toBe("Blood Moon");
  });

  it("reads what 0.4.0 stored as a key as the shipped name, copies and all", async () => {
    install();
    const { presetName } = await import("../src/effects/preset-library");
    expect(presetName(LEGACY_COPY)).toBe("Aged Parchment (copy)");
    // A copy of a copy, which 0.4.0 wrote as one more " (copy)".
    const twice = userPreset("twice", "DP.preset.agedParchment (copy) (copy)");
    expect(presetName(twice)).toBe("Aged Parchment (copy) (copy)");
    // An exported shipped preset, imported again: its label is the key alone.
    expect(presetName(userPreset("imported", "DP.preset.glitch"))).toBe("Glitch");
  });

  it("leaves a GM's words alone even when they look like a key nobody defines", async () => {
    install();
    const { presetName } = await import("../src/effects/preset-library");
    expect(presetName(userPreset("odd", "DP.not.a.key (copy)"))).toBe("DP.not.a.key (copy)");
    expect(presetName(userPreset("plain", "Moonlit (copy)"))).toBe("Moonlit (copy)");
  });
});

describe("Duplicate", () => {
  const stored = () => world.game.settings.get("", "userPresets") as DpPreset[];

  it("names the copy of a shipped preset in words, in the GM's language", async () => {
    install([]);
    const { duplicatePreset } = await import("../src/effects/preset-library");
    const copy = await duplicatePreset("aged-parchment");
    expect(copy?.label).toBe("Aged Parchment (copy)");
    expect(stored().map((p) => p.label)).toEqual(["Aged Parchment (copy)"]);
  });

  it("names the copy of a world preset from its name, and of a 0.4.0 copy from its words", async () => {
    install();
    const { duplicatePreset } = await import("../src/effects/preset-library");
    expect((await duplicatePreset("blood-moon"))?.label).toBe("Blood Moon (copy)");
    expect((await duplicatePreset(LEGACY_COPY.id))?.label).toBe("Aged Parchment (copy) (copy)");
  });
});

describe("every surface that names a preset", () => {
  const pinWearing = (effectId: string) =>
    validatePin({
      ...defaultPin(),
      mode: "prop",
      effect: { ...defaultPin().effect, id: effectId },
      audience: { ...defaultPin().audience, kind: "everyone" },
    }).pin;

  it("the HUD's gallery, its labels and its tooltips", async () => {
    install();
    const { hudMarkup } = await import("../src/apps/PinHUD");
    const doc = { locked: false, hidden: false, x: 0, y: 0, width: 100, height: 100 };
    const root = parse(hudMarkup(doc, pinWearing("blood-moon")));
    expectWords(texts(root, ".dp-hud__swatch-label"));
    expectWords(
      [...root.querySelectorAll<HTMLElement>(".dp-hud__swatch")].map(
        (swatch) => swatch.dataset.tooltipText ?? ""
      )
    );
  });

  it("Pin Studio's gallery", async () => {
    install();
    const { studioMarkup } = await import("../src/apps/PinStudio");
    const doc = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
    const root = parse(studioMarkup(doc, pinWearing("blood-moon"), "appearance"));
    expectWords(texts(root, ".dp-studio__swatch-name"));
  });

  it("the Preset Studio's list, its preview and the name field", async () => {
    install();
    const { presetStudioMarkup } = await import("../src/apps/PresetStudio");
    const { allPresets } = await import("../src/effects/preset-library");
    const root = parse(presetStudioMarkup(allPresets(), LEGACY_COPY, "map", false));
    expectWords(texts(root, ".dp-presets__name"));
    expect(texts(root, ".dp-card__title")).toEqual(["Aged Parchment (copy)"]);
    expect(root.querySelector<HTMLInputElement>('[name="_label"]')!.value).toBe(
      "Aged Parchment (copy)"
    );
  });

  it("the Pinboard's effect button and its effect menu", async () => {
    const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", sort: 0 });
    tile.flags = { "documents-pinner": { pin: pinWearing(LEGACY_COPY.id) } };
    install(undefined, [tile]);
    const { definePinboard } = await import("../src/apps/Pinboard");
    const board = new (definePinboard())();
    document.body.appendChild(contentOf(board));
    board.menu = { id: "t1", kind: "effect", top: 0, right: 0 };
    await board.render();

    expect(texts(contentOf(board), ".dp-row__fx")).toEqual(["Aged Parchment (copy)"]);
    expectWords(texts(contentOf(board), ".dp-menu [data-dp-preset]"));
  });

  it("the placement ghost's chip", async () => {
    install();
    world.game.settings.set("", "lastPreset", "blood-moon");
    const { arm, disarm } = await import("../src/apps/PlacementGhost");
    arm({
      kind: "document",
      uuid: "JournalEntry.abc",
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    });
    try {
      const meta = document.querySelector(".dp-ghost__meta")!.textContent ?? "";
      expect(meta.startsWith("Blood Moon · ")).toBe(true);
    } finally {
      disarm();
    }
  });
});

describe("renaming in the Preset Studio", () => {
  async function studio() {
    install();
    const { definePresetStudio } = await import("../src/apps/PresetStudio");
    const app = new (definePresetStudio())();
    app.selectedId = LEGACY_COPY.id;
    await app.render();
    return app;
  }
  const label = () =>
    (world.game.settings.get("", "userPresets") as DpPreset[]).find((p) => p.id === LEGACY_COPY.id)!
      .label;
  const rename = (app: any, value: string) => {
    const field = contentOf(app).querySelector<HTMLInputElement>('[name="_label"]')!;
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("does not store the name the field showed as if the GM had typed it", async () => {
    const app = await studio();
    rename(app, "Aged Parchment (copy)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(label()).toBe("DP.preset.agedParchment (copy)");
  });

  it("stores a new name as words", async () => {
    const app = await studio();
    rename(app, "Ember Letter");
    await vi.waitFor(() => expect(label()).toBe("Ember Letter"));
  });
});
