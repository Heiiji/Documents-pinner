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
  hud.object = tile.object;
  document.body.appendChild(contentOf(hud));
  await hud.render();
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
