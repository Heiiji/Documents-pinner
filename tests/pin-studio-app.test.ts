/**
 * @vitest-environment jsdom
 *
 * The Studio's type-size and margin sliders, driven through the real application: what
 * ONE change event writes to the anchor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { settled } from "../src/data/PinStore";
import { readPin } from "../src/data/PinData";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

let tile: any;
let installed: ReturnType<typeof installWorld>;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
  tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  installed = installWorld({ isGM: true, tiles: [tile] });
});

afterEach(() => uninstallWorld());

async function studioOn(tab: string) {
  const { definePinStudio } = await import("../src/apps/PinStudio");
  const studio = new (definePinStudio())();
  studio.doc = tile;
  studio.tab = tab;
  await studio.render();
  return studio;
}

function change(studio: any, name: string, value: string) {
  const input = contentOf(studio).querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  if (input.type === "checkbox") input.checked = value === "on";
  else input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the type-size and margin sliders", () => {
  it("freezes the sibling metric before writing one of them", async () => {
    // A pin from before type sizes were stored: both metrics derive from the tile.
    const studio = await studioOn("appearance");
    change(studio, "display.typeSize", "12");
    await settled();

    const display = tile.flags[MODULE_ID][FLAGS.PIN].display;
    expect(display.typeSize).toBe(12);
    // Legacy padding of a 400 short edge is 24px; at the derived 15.38px type, 1.56em.
    expect(display.margin).toBeCloseTo(1.56, 2);
  });

  it("writes only the one metric when both are already stored", async () => {
    tile.flags[MODULE_ID][FLAGS.PIN].display.typeSize = 20;
    tile.flags[MODULE_ID][FLAGS.PIN].display.margin = 2;
    const studio = await studioOn("appearance");
    change(studio, "display.margin", "1");
    await settled();

    const display = tile.flags[MODULE_ID][FLAGS.PIN].display;
    expect(display.typeSize).toBe(20);
    expect(display.margin).toBe(1);
  });
});

/**
 * A 0.1.x pin stored `interaction.clickThrough`, which the normaliser reads as `open:
 * "never"`. Every whole-payload write — the Studio's, the migration's — merged into the stored
 * payload on v14 and never removed it, so the Open control looked as if it saved and
 * snapped back to "never".
 */
describe("the Open control on a pin from 0.1.x", () => {
  it.each([
    ["before the migration has run", false],
    ["once the migration has run", true],
  ])("keeps what the GM chose, %s", async (_when, migrated) => {
    const pin = tile.flags[MODULE_ID][FLAGS.PIN];
    pin.v = 1;
    pin.interaction = { open: "double", tooltip: "", openPage: true, clickThrough: true };
    if (migrated) {
      const scene = (globalThis as any).canvas.scene;
      scene.updateEmbeddedDocuments = async (_type: string, updates: any[]) => {
        for (const { _id, ...change } of updates) if (_id === tile.id) await tile.update(change);
        return updates;
      };
      const { migrateScene } = await import("../src/data/migrations");
      await migrateScene(scene);
    }
    const studio = await studioOn("content");
    change(studio, "interaction.open", "double");
    await settled();

    expect(readPin(tile)?.interaction.open).toBe("double");
  });
});

describe("the strip's width and height", () => {
  it("resizes one axis in grid squares and leaves the other alone", async () => {
    const studio = await studioOn("content");
    change(studio, "_width", "6");
    await settled();
    expect(tile.width).toBe(600);
    expect(tile.height).toBe(560);
  });

  it("carries the other axis when the ratio is locked", async () => {
    const studio = await studioOn("content");
    change(studio, "_aspect", "on");
    change(studio, "_width", "8");
    await settled();
    expect(tile.width).toBe(800);
    expect(tile.height).toBe(1120);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * High #5 of the UX audit: "Some players" chosen from the dropdown with nobody picked
 * wrote a `selected` audience naming nobody. It reached no one, while the Pinboard
 * counted it visible and the HUD's eye stayed open. The HUD always refused; now the
 * dropdown does too.
 */
describe("the audience dropdown's 'Some'", () => {
  it("writes nothing and asks for a player when there is nobody to choose", async () => {
    const studio = await studioOn("audience");
    document.body.appendChild(contentOf(studio));
    change(studio, "audience.kind", "selected");
    await settled();
    await tick();

    expect(tile.flags[MODULE_ID][FLAGS.PIN].audience.kind).toBe("everyone");
    const status = contentOf(studio).querySelector<HTMLElement>(".dp-studio__status")!;
    expect(status.textContent).toContain("chooseWho");
    const select = contentOf(studio).querySelector<HTMLSelectElement>('[name="audience.kind"]')!;
    expect(select.value).toBe("everyone");
  });

  it("takes back the selection a hidden pin remembers", async () => {
    tile.hidden = true;
    tile.flags[MODULE_ID][FLAGS.PIN].audience = {
      ...defaultPin().audience,
      kind: "hidden",
      restore: { kind: "selected", users: ["ali"] },
    };
    const studio = await studioOn("audience");
    change(studio, "audience.kind", "selected");
    await settled();
    await tick();

    const audience = tile.flags[MODULE_ID][FLAGS.PIN].audience;
    expect(audience.kind).toBe("selected");
    expect(audience.users).toEqual(["ali"]);
  });
});

describe("the keyboard's place across a render", () => {
  it("keeps the focus on the control that changed, in the markup that replaced it", async () => {
    const studio = await studioOn("appearance");
    document.body.appendChild(contentOf(studio));
    const before = contentOf(studio).querySelector<HTMLElement>('[name="display.paper"]')!;
    before.focus();
    change(studio, "display.paper", "vellum");
    await settled();
    await studio.render();

    const after = contentOf(studio).querySelector('[name="display.paper"]');
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it("moves along the tabs with the arrows, and the panel names the tab that shows it", async () => {
    const studio = await studioOn("content");
    document.body.appendChild(contentOf(studio));
    const tab = contentOf(studio).querySelector<HTMLElement>(
      '.dp-studio__tabbtn[data-dp-tab="content"]'
    )!;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    await tick();

    expect(studio.tab).toBe("appearance");
    const active = document.activeElement as HTMLElement;
    expect(active.dataset.dpTab).toBe("appearance");
    expect(active.getAttribute("tabindex")).toBe("0");
    const panel = contentOf(studio).querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute("aria-labelledby")).toBe(active.id);
  });
});

describe("which Studios a change re-renders", () => {
  it("only the ones showing a pin that changed", async () => {
    const { openStudio, refreshStudios } = await import("../src/apps/PinStudio");
    const studio = openStudio(tile);
    await tick();
    const before = studio.renderCount;

    refreshStudios(["Scene.s2.Tile.t1"]);
    expect(studio.renderCount).toBe(before);
    refreshStudios(["Scene.s1.Tile.t1"]);
    expect(studio.renderCount).toBe(before + 1);
  });
});

/**
 * The Studio's buttons fire a write and move on. One core refused was an "Uncaught (in
 * promise)" in the console, and the render meant to follow never ran.
 */
describe("a change Foundry refuses", () => {
  it("is said, and the Studio still renders after it", async () => {
    const studio = await studioOn("content");
    const before = studio.renderCount;
    tile.update = async () => {
      throw new Error("refused");
    };

    studio.dispatch("resetSize");
    await settled();
    await tick();

    expect(installed.notifications).toEqual([{ type: "error", message: "DP.notice.writeFailed" }]);
    expect(studio.renderCount).toBe(before + 1);
  });
});

describe("a Studio over a pin deleted elsewhere", () => {
  it("says the pin is gone, rather than offering controls that can only fail", async () => {
    const scene = (globalThis as any).canvas.scene;
    tile.parent = scene;
    const { openStudio, refreshStudios } = await import("../src/apps/PinStudio");
    const studio = openStudio(tile);
    await tick();

    scene.tiles.contents.splice(0);
    refreshStudios([tile.uuid]);
    await tick();

    expect(contentOf(studio).querySelector(".dp-studio__gone")).not.toBeNull();
    expect(contentOf(studio).querySelector("[name]")).toBeNull();
  });
});

/**
 * A duplicated scene keeps every tile's id. The Studio was found by id, so opening it for a
 * pin on the copy brought forward the original's, and every edit went to the other scene.
 */
describe("the Studio of a pin on a duplicated scene", () => {
  it("is its own window, editing its own pin", async () => {
    const twin = fakeTile({ id: "t1", uuid: "Scene.s2.Tile.t1", width: 400, height: 560 });
    twin.flags = structuredClone(tile.flags);
    const { openStudio } = await import("../src/apps/PinStudio");

    const day = openStudio(tile);
    const night = openStudio(twin);

    expect(night).not.toBe(day);
    expect(day.doc).toBe(tile);
    expect(night.doc).toBe(twin);
  });
});

describe("the window", () => {
  it("names the pin in its title, so two Studios can be told apart", async () => {
    tile.flags[MODULE_ID][FLAGS.PIN].display.label = "The Duke's Letter";
    (globalThis as any).game.i18n.format = (key: string, data: any) => `${key}|${data.name}`;
    const studio = await studioOn("content");
    expect(studio.title).toBe("DP.studio.titleFor|The Duke's Letter");
  });
});

describe("the pin's icon", () => {
  it("offers core's note icons and writes the tile's texture", async () => {
    (globalThis as any).CONFIG.JournalEntry = { noteIcons: { Anchor: "icons/svg/anchor.svg" } };
    const studio = await studioOn("appearance");
    const select = contentOf(studio).querySelector<HTMLSelectElement>('[name="_icon"]')!;
    expect([...select.options].map((o) => o.value)).toEqual([
      "icons/svg/book.svg",
      "icons/svg/anchor.svg",
    ]);

    change(studio, "_icon", "icons/svg/anchor.svg");
    await settled();
    await tick();
    expect(tile.texture.src).toBe("icons/svg/anchor.svg");
  });

  it("is not offered on an image pin, which shows its image", async () => {
    tile.flags[MODULE_ID][FLAGS.PIN].source = {
      kind: "image",
      uuid: null,
      src: "maps/scrap.webp",
      pageId: null,
      pdfPage: null,
      followName: false,
    };
    const studio = await studioOn("appearance");
    expect(contentOf(studio).querySelector('[name="_icon"]')).toBeNull();
  });
});
