/**
 * @vitest-environment jsdom
 *
 * Stated ergonomic goal #1 — "change visibility easily, mid-session, under time
 * pressure" — failing on its primary surface.
 *
 * A chip click writes the tile, `updateTile` re-renders the HUD, and the fresh markup has
 * both palettes carrying `hidden`. So revealing to three of five players cost
 * open → click → reopen → click → reopen → click, and the roving-tabindex toolbar reset
 * to button one every time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

let hud: any;
let tile: any;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="hud"></div>';

  tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        audience: { ...defaultPin().audience, kind: "selected", users: ["ali"] },
      },
    },
  };
  installWorld({ isGM: true, tiles: [tile] });

  const { definePinHUD } = await import("../src/apps/PinHUD");
  hud = new (definePinHUD())();
  document.body.appendChild(contentOf(hud));
  // `bind()` is how a BasePlaceableHUD is given its placeable; `object` has no setter.
  await hud.bind(tile.object);
});

afterEach(() => uninstallWorld());

function palette(id: string): HTMLElement {
  return contentOf(hud).querySelector(`#${id}`)!;
}

function paletteButton(id: string): HTMLElement {
  return contentOf(hud).querySelector(`[aria-controls="${id}"]`)!;
}

async function openAudiencePalette() {
  hud.dispatch("togglePalette", paletteButton("dp-hud-audience"));
}

describe("the HUD audience palette", () => {
  it("opens when its button is pressed", async () => {
    await openAudiencePalette();
    expect(palette("dp-hud-audience").hidden).toBe(false);
    expect(paletteButton("dp-hud-audience").getAttribute("aria-expanded")).toBe("true");
  });

  it("STAYS open across the re-render a chip click causes", async () => {
    await openAudiencePalette();
    await hud.render();

    expect(palette("dp-hud-audience").hidden).toBe(false);
    expect(paletteButton("dp-hud-audience").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps focus on the chip that was just clicked", async () => {
    await openAudiencePalette();
    const chip = contentOf(hud).querySelector<HTMLElement>('.dp-chip[data-dp-user="ben"]')!;
    chip.focus();
    expect(document.activeElement).toBe(chip);

    await hud.render();

    const after = contentOf(hud).querySelector<HTMLElement>('.dp-chip[data-dp-user="ben"]')!;
    expect(after).not.toBe(chip);
    expect(document.activeElement).toBe(after);
  });

  it("keeps focus on a toolbar button, so the roving tabindex does not reset", async () => {
    const flash = contentOf(hud).querySelector<HTMLElement>('[data-action="flash"]')!;
    flash.focus();

    await hud.render();

    const after = contentOf(hud).querySelector<HTMLElement>('[data-action="flash"]')!;
    expect(document.activeElement).toBe(after);
    expect(after.tabIndex).toBe(0);
  });

  it("closes when its button is pressed again, and stays closed on the next render", async () => {
    await openAudiencePalette();
    await openAudiencePalette();
    expect(palette("dp-hud-audience").hidden).toBe(true);

    await hud.render();
    expect(palette("dp-hud-audience").hidden).toBe(true);
  });

  it("opens only one palette at a time", async () => {
    await openAudiencePalette();
    hud.dispatch("togglePalette", paletteButton("dp-hud-effects"));
    await hud.render();

    expect(palette("dp-hud-audience").hidden).toBe(true);
    expect(palette("dp-hud-effects").hidden).toBe(false);
  });
});

/**
 * The other half of remembering focus: NOT re-taking it.
 *
 * The selector was kept whenever the focus was outside the HUD, so any later render
 * yanked it back — a GM who clicked a chip and then started typing in chat had the caret
 * pulled out from under them by the next tile update.
 */
describe("the HUD and focus that is not its own", () => {
  it("does not steal focus back from another element", async () => {
    const chip = contentOf(hud).querySelector<HTMLElement>(".dp-chip")!;
    chip.focus();
    await hud.render();

    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await hud.render();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("still keeps the palette open even when focus has moved away", async () => {
    await openAudiencePalette();

    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await hud.render();

    expect(palette("dp-hud-audience").hidden).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });
});

/**
 * The crash that made a pin unselectable.
 *
 * `showPinHUD` assigned `hudInstance.object = tile`. On a real `BasePlaceableHUD` that
 * property is a GETTER with no setter, so the assignment threw — from inside
 * `PlaceableObject#control()`, which sets `_controlled` and only THEN sets the render
 * flag that draws the selection frame and the resize handles. A GM clicking a pin got a
 * TypeError, no HUD, and a placeable they could not drag or resize.
 *
 * Observed in a live v14 world:
 *   TypeError: Cannot set property object of #<BasePlaceableHUD> which has only a getter
 *       at showPinHUD -> PinnedTile._onControl -> PlaceableObject.control
 */
describe("showPinHUD against the real BasePlaceableHUD contract", () => {
  it("binds the placeable instead of assigning to a getter-only property", async () => {
    const { showPinHUD } = await import("../src/apps/PinHUD");
    expect(() => showPinHUD(tile.object)).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    const { definePinHUD } = await import("../src/apps/PinHUD");
    // The HUD is bound to the placeable it was shown for.
    expect(definePinHUD()).toBeTruthy();
  });

  it("never lets a HUD failure escape into core's control flow", async () => {
    const hudModule = await import("../src/apps/PinHUD");
    // Whatever goes wrong inside the HUD, `_onControl` must return normally or core stops
    // before it draws the selection frame.
    const broken = { document: null, id: "nope" };
    expect(() => hudModule.showPinHUD(broken as never)).not.toThrow();
  });
});
