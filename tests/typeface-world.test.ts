/**
 * @vitest-environment jsdom
 *
 * The typeface through the real paths: the resolver that decides a card's face, the
 * probe that measures it for fit-to-content, the inliner that must carry every face the
 * picker offers into the rasteriser's isolated SVG, and the two Studios that choose it.
 *
 * jsdom lays nothing out, so "a monospace card measures taller" cannot be asserted here
 * (`measure.test.ts`). What can be, and is the actual contract: the card handed to the
 * probe carries the resolved face, the face is LOADED before the probe reads, and a face
 * that never arrives cannot hold the probe — or the queue behind it — hostage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { validatePreset } from "../src/effects/preset-schema";
import { escapeAttr } from "../src/html";
import type { DpPinFlags } from "../src/types/dp";
import {
  contentOf,
  fakeTile,
  installWorld,
  offerFonts,
  uninstallWorld,
} from "./helpers/fake-foundry";
import { getCorePreset } from "./helpers/presets";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

const PAGE = {
  documentName: "JournalEntryPage",
  type: "text",
  name: "Telegram",
  isOwner: true,
  text: { content: "<p>ARRIVE MIDNIGHT STOP</p>" },
  testUserPermission: () => true,
};

/**
 * The stacks the card must carry, written out rather than taken from `typeface.ts`, so
 * that against the code before it these fail on what they assert.
 */
const HOUSE_STACK = `"Signika", "Palatino Linotype", Palatino, Georgia, serif`;
const MONOSPACE = `ui-monospace, "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace`;
const CURSIVE = `"Segoe Script", "Bradley Hand", cursive`;

let world: ReturnType<typeof installWorld>;

function pin(over: { effect?: string; font?: string | null } = {}): DpPinFlags {
  const base = defaultPin();
  return {
    ...base,
    mode: "prop",
    source: { ...base.source, uuid: "JournalEntry.j.JournalEntryPage.p" },
    display: { ...base.display, typeSize: 14, margin: 1.5, font: over.font ?? null },
    effect: { ...base.effect, id: over.effect ?? "none" },
    audience: { ...base.audience, kind: "everyone" },
  };
}

/** The `--dp-font` a card's own style attribute carries, decoded, or null. */
function faceOf(html: string): string | null {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const card = holder.querySelector<HTMLElement>(".dp-card");
  return card?.style.getPropertyValue("--dp-font").trim() || null;
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
  world = installWorld({ isGM: true, settings: { effectsLevel: "full" } });
  (globalThis as any).fromUuid = async () => PAGE;
});

afterEach(() => {
  delete (globalThis as any).fromUuid;
  delete (document as any).fonts;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uninstallWorld();
});

describe("the face a card is resolved in", () => {
  const resolve = async (p: DpPinFlags, tier: "L1" | "L2b" = "L2b") => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    return resolveCard(p, { width: 400, height: 560 }, { tier });
  };

  it("is the pin's own, else the preset's, else the house face", async () => {
    const own = await resolve(pin({ effect: "crt-scanlines", font: "Special Elite" }));
    expect(faceOf(own.html)).toBe(`"Special Elite", ${HOUSE_STACK}`);
    const preset = await resolve(pin({ effect: "crt-scanlines" }));
    expect(faceOf(preset.html)).toBe(MONOSPACE);
    const house = await resolve(pin());
    expect(faceOf(house.html)).toBeNull();
  });

  // It is no effect variable (K6): the dressing drops every one of those at these rungs.
  it("survives effects switched off or reduced, and the silhouette rung", async () => {
    for (const level of ["off", "reduced"]) {
      world.game.settings.set("", "effectsLevel", level);
      const card = await resolve(pin({ effect: "crt-scanlines" }));
      expect(card.html).toContain(`data-dp-level="${level}"`);
      expect(faceOf(card.html), level).toBe(MONOSPACE);
    }

    world.game.settings.set("", "effectsLevel", "full");
    const l1 = await resolve(pin({ effect: "crt-scanlines" }), "L1");
    expect(l1.html).toContain('data-dp-tier="L1"');
    expect(faceOf(l1.html)).toBe(MONOSPACE);
  });
});

describe("measuring in the chosen face", () => {
  it("hands the probe the card's face and loads it before the read", async () => {
    const order: string[] = [];
    (document as any).fonts = {
      load: vi.fn(async (font: string) => {
        order.push(`load ${font}`);
        return [];
      }),
      ready: Promise.resolve(),
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      order.push(`read ${this.style.getPropertyValue("--dp-font").trim()}`);
      return { height: 640 } as DOMRect;
    });

    const { resolveCard } = await import("../src/render/ContentResolver");
    const card = await resolveCard(pin({ font: "Special Elite" }), { width: 400, height: 560 });

    const face = `"Special Elite", ${HOUSE_STACK}`;
    expect(order).toEqual([`load 14px ${face}`, `read ${face}`]);
    expect(card.naturalHeight).toBe(640);
  });

  it("measures anyway once a face that never arrives has had its time", async () => {
    vi.useFakeTimers();
    (document as any).fonts = { load: () => new Promise(() => {}), ready: new Promise(() => {}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 512,
    } as DOMRect);
    const { FONT_LOAD_TIMEOUT_MS, measureCardHeight } = await import("../src/render/measure");

    let result: number | null | undefined;
    void measureCardHeight(
      `<div class="dp-card" style="${escapeAttr(`--dp-font:${CURSIVE}`)}"></div>`,
      300
    ).then((height) => (result = height));

    await vi.advanceTimersByTimeAsync(FONT_LOAD_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(512);
    expect(FONT_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });

  it("loads the house face for a card with none of its own, and measures anyway when it fails", async () => {
    const load = vi.fn(() => Promise.reject(new DOMException("bad", "SyntaxError")));
    (document as any).fonts = { load, ready: Promise.resolve() };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 300,
    } as DOMRect);
    const { measureCardHeight } = await import("../src/render/measure");
    expect(await measureCardHeight('<div class="dp-card" style="font-size:12px"></div>', 300)).toBe(
      300
    );
    expect(load).toHaveBeenCalledWith(`12px ${HOUSE_STACK}`);
  });
});

describe("the faces the rasteriser carries", () => {
  function stubFetch() {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return { ok: true, blob: async () => new Blob([url], { type: "font/woff2" }) };
      })
    );
    return fetched;
  }

  it("inlines the faces a GM added in Font Config, which CONFIG does not list, CONFIG winning", async () => {
    uninstallWorld();
    world = installWorld({
      isGM: true,
      settings: {
        // Core's own `fonts` setting, where Font Config keeps what a GM adds.
        fonts: {
          "Special Elite": { editor: true, fonts: [{ urls: ["fonts/elite.woff2"] }] },
          Amiri: { editor: true, fonts: [{ urls: ["fonts/stale.woff2"] }] },
        },
      },
    });
    (globalThis as any).CONFIG.fontDefinitions = {
      Signika: { editor: true, fonts: [{ urls: ["fonts/signika.woff2"] }] },
      Amiri: { editor: true, fonts: [{ urls: ["fonts/amiri.woff2"] }] },
    };
    const fetched = stubFetch();
    // A fresh module, and with it an empty font cache: `beforeEach` resets the registry.
    const { inlineFonts, registeredFontFamilies } = await import("../src/render/AssetInliner");

    const css = await inlineFonts();
    expect(css).toContain('@font-face{font-family:"Special Elite"');
    expect(css).toContain('@font-face{font-family:"Signika"');
    // A face both define is CONFIG's.
    expect([...fetched].sort()).toEqual([
      "fonts/amiri.woff2",
      "fonts/elite.woff2",
      "fonts/signika.woff2",
    ]);
    // And the picker offers exactly what can be drawn.
    expect(registeredFontFamilies().sort()).toEqual(["Amiri", "Signika", "Special Elite"]);
  });

  it("offers Font Config's loaded faces too, and falls back to CONFIG when the setting throws", async () => {
    (globalThis as any).CONFIG.fontDefinitions = { Signika: { editor: true, fonts: [] } };
    offerFonts(["Bruno Ace"]);
    world.game.settings.get = () => {
      throw new Error("fonts is not a registered game setting");
    };
    const { registeredFontFamilies } = await import("../src/render/AssetInliner");
    expect(registeredFontFamilies().sort()).toEqual(["Bruno Ace", "Signika"]);
  });
});

describe("the Pin Studio's typeface", () => {
  let tile: any;

  async function studio() {
    tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
    tile.flags = { [MODULE_ID]: { [FLAGS.PIN]: pin({ effect: "crt-scanlines" }) } };
    uninstallWorld();
    world = installWorld({ isGM: true, tiles: [tile] });
    (globalThis as any).CONFIG.fontDefinitions = { Amiri: { editor: true, fonts: [] } };
    offerFonts(['Evil"; }', "Bruno Ace"]);
    const { definePinStudio } = await import("../src/apps/PinStudio");
    const app = new (definePinStudio())();
    app.doc = tile;
    app.tab = "appearance";
    await app.render();
    return app;
  }

  const select = (app: any) =>
    contentOf(app).querySelector<HTMLSelectElement>('select[name="display.font"]')!;

  /** The write queue the Studio actually used: modules are fresh per test. */
  const settled = async () => (await import("../src/data/PinStore")).settled();

  it("offers the effect's, the generics and this world's faces, and writes the choice to the pin", async () => {
    const app = await studio();
    const options = [...select(app).options];
    expect(options.map((o) => o.value)).toEqual([
      "",
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "Amiri",
      "Bruno Ace",
    ]);
    expect(options[0].textContent).toBe("DP.studio.fontFromEffect");
    expect(options[0].selected).toBe(true);
    expect(options[5].style.fontFamily).toContain("Amiri");
    expect(select(app).disabled).toBe(false);

    select(app).value = "Amiri";
    select(app).dispatchEvent(new Event("change", { bubbles: true }));
    await settled();
    expect(tile.flags[MODULE_ID][FLAGS.PIN].display.font).toBe("Amiri");

    await app.render();
    expect(select(app).value).toBe("Amiri");
    select(app).value = "";
    select(app).dispatchEvent(new Event("change", { bubbles: true }));
    await settled();
    expect(tile.flags[MODULE_ID][FLAGS.PIN].display.font).toBeNull();
  });
});

describe("the Preset Studio's typeface", () => {
  const mine = () =>
    validatePreset({
      ...getCorePreset("aged-parchment")!,
      id: "mine",
      label: "Mine",
      author: "user",
    }).preset!;

  async function studioOn(id: string, presets: unknown[] = []) {
    uninstallWorld();
    world = installWorld({ isGM: true, settings: { userPresets: presets } });
    offerFonts(["Amiri"]);
    const { definePresetStudio } = await import("../src/apps/PresetStudio");
    const app = new (definePresetStudio())();
    app.selectedId = id;
    await app.render();
    return app;
  }

  const control = (app: any) =>
    contentOf(app).querySelector<HTMLSelectElement>('select[name="type.family"]')!;

  it("shows a shipped preset's face in its preview, as a pin wearing it would, and locks it", async () => {
    const app = await studioOn("crt-scanlines");
    const preview = contentOf(app).querySelector<HTMLElement>(".dp-presets__preview .dp-card")!;
    expect(preview.style.getPropertyValue("--dp-font").trim()).toBe(MONOSPACE);
    expect(control(app).disabled).toBe(true);
    expect(control(app).value).toBe("monospace");
  });

  it("offers the world's faces on a user preset, and writes the face, and the empty choice as null", async () => {
    const app = await studioOn("mine", [mine()]);
    expect(control(app).disabled).toBe(false);
    expect([...control(app).options].map((o) => o.value)).toContain("Amiri");
    const stored = () =>
      (world.game.settings.get("", "userPresets") as any[]).find((p) => p.id === "mine");

    control(app).value = "Amiri";
    control(app).dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored().params.type.family).toBe("Amiri"));

    await app.render();
    control(app).value = "";
    control(app).dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored().params.type.family).toBeNull());
  });
});

describe("importing a stranger's preset", () => {
  // One hostile name proves the path; every other is `typeface.test.ts`'s table.
  it("refuses a face that would end its quote, says so, and stores the preset without it", async () => {
    const family = 'Arial"; } .dp-card { color: red';
    uninstallWorld();
    world = installWorld({ isGM: true, settings: { userPresets: [] } });
    const { importPreset } = await import("../src/effects/preset-library");
    const imported = await importPreset(
      JSON.stringify({ id: "gift", label: "Gift", params: { type: { family } } })
    );

    expect(imported!.params.type.family).toBeNull();
    expect(world.notifications).toContainEqual({
      type: "warn",
      message: "DP.preset.warn.badFont",
    });
    const stored = (world.game.settings.get("", "userPresets") as any[])[0];
    expect(JSON.stringify(stored)).not.toContain(family);
  });
});
