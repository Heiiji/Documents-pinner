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
import { getCorePreset } from "../src/effects/presets/core-presets";
import { escapeAttr } from "../src/html";
import type { DpPinFlags } from "../src/types/dp";
import {
  contentOf,
  fakeTile,
  installWorld,
  offerFonts,
  uninstallWorld,
} from "./helpers/fake-foundry";

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

  it("is the preset's when the pin has none of its own", async () => {
    const card = await resolve(pin({ effect: "crt-scanlines" }));
    expect(faceOf(card.html)).toBe(MONOSPACE);
  });

  it("is the pin's own when it has one, whatever the preset says", async () => {
    const card = await resolve(pin({ effect: "crt-scanlines", font: "Special Elite" }));
    expect(faceOf(card.html)).toBe(`"Special Elite", ${HOUSE_STACK}`);
  });

  it("is the house face when neither chose one", async () => {
    const card = await resolve(pin());
    expect(faceOf(card.html)).toBeNull();
  });

  it("survives effects switched off and the silhouette rung", async () => {
    const off = await resolve(pin({ effect: "crt-scanlines" }));
    world.game.settings.set("", "effectsLevel", "off");
    const offCard = await resolve(pin({ effect: "crt-scanlines" }));
    expect(offCard.html).toContain('data-dp-level="off"');
    expect(faceOf(offCard.html)).toBe(faceOf(off.html));

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

  it("loads the house face for a card with none of its own", async () => {
    const load = vi.fn(async () => []);
    (document as any).fonts = { load, ready: Promise.resolve() };
    const { measureCardHeight } = await import("../src/render/measure");
    await measureCardHeight('<div class="dp-card" style="font-size:12px"></div>', 300);
    expect(load).toHaveBeenCalledWith(`12px ${HOUSE_STACK}`);
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

  it("measures anyway when the face fails to load", async () => {
    (document as any).fonts = {
      load: () => Promise.reject(new DOMException("bad", "SyntaxError")),
      ready: Promise.resolve(),
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 300,
    } as DOMRect);
    const { measureCardHeight } = await import("../src/render/measure");
    expect(await measureCardHeight('<div class="dp-card"></div>', 300)).toBe(300);
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

  it("inlines the faces a GM added in Font Config, which CONFIG does not list", async () => {
    uninstallWorld();
    world = installWorld({
      isGM: true,
      settings: {
        // Core's own `fonts` setting, where Font Config keeps what a GM adds.
        fonts: { "Special Elite": { editor: true, fonts: [{ urls: ["fonts/elite.woff2"] }] } },
      },
    });
    (globalThis as any).CONFIG.fontDefinitions = {
      Signika: { editor: true, fonts: [{ urls: ["fonts/signika.woff2"] }] },
    };
    const fetched = stubFetch();
    const { clearInliner, inlineFonts, registeredFontFamilies } =
      await import("../src/render/AssetInliner");
    clearInliner();

    const css = await inlineFonts();
    expect(css).toContain('@font-face{font-family:"Special Elite"');
    expect(css).toContain('@font-face{font-family:"Signika"');
    expect(fetched).toEqual(expect.arrayContaining(["fonts/elite.woff2", "fonts/signika.woff2"]));
    // And the picker offers exactly what can be drawn.
    expect(registeredFontFamilies().sort()).toEqual(["Signika", "Special Elite"]);
  });

  it("takes CONFIG's definition of a face both define", async () => {
    uninstallWorld();
    world = installWorld({
      isGM: true,
      settings: { fonts: { Amiri: { editor: true, fonts: [{ urls: ["fonts/stale.woff2"] }] } } },
    });
    (globalThis as any).CONFIG.fontDefinitions = {
      Amiri: { editor: true, fonts: [{ urls: ["fonts/amiri.woff2"] }] },
    };
    const fetched = stubFetch();
    const { clearInliner, inlineFonts } = await import("../src/render/AssetInliner");
    clearInliner();
    await inlineFonts();
    expect(fetched).toEqual(["fonts/amiri.woff2"]);
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

  it("offers the effect's, the generics and this world's faces, each in its own face", async () => {
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
  });

  it("writes the choice to the pin, and 'the effect's' back to null", async () => {
    const app = await studio();
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

  it("shows the preset's face in its preview, as a pin wearing it would", async () => {
    const app = await studioOn("crt-scanlines");
    const preview = contentOf(app).querySelector<HTMLElement>(".dp-presets__preview .dp-card")!;
    expect(preview.style.getPropertyValue("--dp-font").trim()).toBe(MONOSPACE);
  });

  it("locks a shipped preset's face and offers the world's own on a user preset", async () => {
    const shipped = await studioOn("crt-scanlines");
    expect(control(shipped).disabled).toBe(true);
    expect(control(shipped).value).toBe("monospace");

    const own = await studioOn("mine", [mine()]);
    expect(control(own).disabled).toBe(false);
    expect([...control(own).options].map((o) => o.value)).toContain("Amiri");
  });

  it("writes the face, and the empty choice as null", async () => {
    const app = await studioOn("mine", [mine()]);
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
  it.each(['Arial"; } .dp-card { color: red', "a,b"])(
    "refuses the face %s, says so, and stores the preset without it",
    async (family) => {
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
    }
  );
});
