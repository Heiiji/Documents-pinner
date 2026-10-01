/**
 * @vitest-environment jsdom
 *
 * A text prop is a card drawn OVER the canvas, so core's darkness never reached it: a
 * bright sheet of paper floated over a black crypt. The scene's global darkness now rides
 * on the overlay as one custom property, and these tests hold the three things that make
 * that cheap and correct — the mapping, the write discipline, and that darkness is in no
 * content key, so a dusk transition never re-resolves a single card.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAudience } from "../src/data/audience";
import { cardHtml } from "../src/render/CardTemplate";
import { defaultPin } from "../src/data/pin-schema";
import { dressing } from "../src/effects/EffectRegistry";
import { getCorePreset } from "../src/effects/presets/core-presets";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => ({
    html: '<div class="dp-card">letter</div>',
    title: "Letter",
    readable: true,
    contentHash: "h",
    missing: false,
  })),
}));

const effects = { level: "full" };
vi.mock("../src/effects/level", () => ({ currentLevel: () => effects.level }));

vi.mock("../src/apps/OverlayRoot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/apps/OverlayRoot")>();
  return { ...actual, write: vi.fn(actual.write) };
});

import {
  clearDomTier,
  sceneBrightness,
  syncDomTier,
  syncSceneDim,
} from "../src/canvas/DomPropTier";
import { resolveCard } from "../src/render/ContentResolver";
import { destroyOverlay, write } from "../src/apps/OverlayRoot";

const ROOT_ID = "documents-pinner-overlay";

let world: ReturnType<typeof installWorld>;

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await Promise.resolve();
}

function root(): HTMLElement | null {
  return document.getElementById(ROOT_ID);
}

/** Writes queued onto an overlay ROOT — this scene's or an earlier one's — where the dim lives. */
function rootWrites(): number {
  return vi.mocked(write).mock.calls.filter(([element]) => element.id === ROOT_ID).length;
}

function darkness(level: number | undefined) {
  world.canvas.environment.darknessLevel = level;
}

const entry = () => ({
  id: "t1",
  doc: { id: "t1", x: 100, y: 240, width: 400, height: 560, rotation: 0 },
  pin: {
    ...defaultPin(),
    mode: "prop" as const,
    source: {
      kind: "document" as const,
      uuid: "JournalEntry.a",
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    },
    audience: makeAudience({ kind: "everyone" }),
  },
  tier: "L2b" as const,
  focused: false,
  alpha: 1,
  pdf: false,
  revealing: false,
  reveal: { animation: "fade", durationMs: 300 },
  controlled: false,
});

beforeEach(() => {
  document.body.innerHTML = '<div id="board"></div>';
  world = installWorld({ isGM: true });
  effects.level = "full";
  // A fresh scene, as `canvasTearDown` leaves it: no overlay, and no memo of the last value.
  destroyOverlay();
  clearDomTier();
  vi.mocked(write).mockClear();
  vi.mocked(resolveCard).mockClear();
});

afterEach(() => {
  clearDomTier();
  destroyOverlay();
  uninstallWorld();
});

describe("sceneBrightness", () => {
  it.each([
    [0.5, 0.7],
    [1, 0.35],
    // Out of range is clamped, not extrapolated.
    [-1, 1],
    [3, 0.35],
    // Anything that is not a level is daylight: the environment has not initialised.
    [undefined, 1],
    [Number.NaN, 1],
    ["0.8", 1],
  ])("maps darkness %s to brightness %s", (level, brightness) => {
    expect(sceneBrightness(level)).toBe(brightness);
  });

  it("quantises to twentieths, never below the darkest a card may be, never brighter as it darkens", () => {
    // Twentieths, so a slow transition is a bounded number of writes.
    const seen = new Set<number>();
    let last = 1;
    for (let i = 0; i <= 1000; i++) {
      const value = sceneBrightness(i / 1000);
      expect(Math.round(value * 20) / 20).toBe(value);
      expect(value).toBeGreaterThanOrEqual(0.35);
      expect(value).toBeLessThanOrEqual(last);
      seen.add(value);
      last = value;
    }
    expect(seen.size).toBeLessThanOrEqual(21);
  });
});

describe("syncSceneDim", () => {
  it("falls back to the scene's own environment before the canvas group has one", async () => {
    darkness(undefined);
    world.canvas.scene.environment = { darknessLevel: 0.5 };
    syncSceneDim();
    await settle();

    expect(root()?.style.getPropertyValue("--dp-scene-dim")).toBe("0.7");
  });

  it("writes the level onto the overlay root once per quantised change, and when forced", async () => {
    darkness(0.5);
    syncSceneDim();
    await settle();
    expect(rootWrites()).toBe(1);

    // The same level, and a level inside the same twentieth: no write at all.
    syncSceneDim();
    darkness(0.49);
    syncSceneDim();
    await settle();
    expect(rootWrites()).toBe(1);

    darkness(0.9);
    syncSceneDim();
    await settle();
    expect(rootWrites()).toBe(2);
    expect(root()?.style.getPropertyValue("--dp-scene-dim")).toBe("0.4");

    // `canvasReady` forces it, whatever it last wrote.
    syncSceneDim(true);
    await settle();
    expect(rootWrites()).toBe(3);
  });

  it("writes the next scene's first value even when it matches the last scene's", async () => {
    darkness(1);
    syncSceneDim();
    await settle();
    expect(rootWrites()).toBe(1);

    // `canvasTearDown`: the tier is cleared and the overlay destroyed.
    clearDomTier();
    destroyOverlay();
    syncSceneDim();
    await settle();

    expect(rootWrites()).toBe(2);
    expect(root()?.style.getPropertyValue("--dp-scene-dim")).toBe("0.35");
  });

  it("never throws into the hook that called it", () => {
    Object.defineProperty(world.canvas, "environment", {
      get() {
        throw new Error("not initialised");
      },
    });
    expect(() => syncSceneDim()).not.toThrow();
  });
});

describe("darkness and the cards", () => {
  it("re-resolves no card when the level changes", async () => {
    syncDomTier([entry()]);
    await settle();
    const resolved = vi.mocked(resolveCard).mock.calls.length;
    expect(resolved).toBe(1);

    for (const level of [0.2, 0.6, 1]) {
      darkness(level);
      syncSceneDim();
      // The next LOD pass, with nothing else changed.
      syncDomTier([entry()]);
      await settle();
    }

    expect(vi.mocked(resolveCard).mock.calls.length).toBe(resolved);
    expect(root()?.style.getPropertyValue("--dp-scene-dim")).toBe("0.35");
  });

  it("still dims at the `off` and `reduced` levels, where every effect variable is dropped", async () => {
    for (const level of ["off", "reduced"] as const) {
      // The dressing at these levels carries no dim of its own to fight the root's…
      const dressed = dressing({
        preset: getCorePreset("aged-parchment")!,
        intensity: 1,
        seed: 1,
        tier: "L2b",
        level,
        baked: false,
      });
      expect(Object.keys(dressed.vars).filter((key) => key.includes("dim"))).toEqual([]);

      // …and the root carries the level whatever the effects are doing.
      effects.level = level;
      clearDomTier();
      darkness(1);
      syncDomTier([entry()]);
      syncSceneDim();
      await settle();
      expect(root()?.querySelector(".dp-prop")).not.toBeNull();
      expect(root()?.style.getPropertyValue("--dp-scene-dim")).toBe("0.35");
    }
  });
});

/**
 * Projected light is emitted, not lit: a readout in a dark room is as bright as in a lit
 * one. So the `projection` stock keeps its brightness while every other stock darkens.
 *
 * jsdom does not cascade custom properties, so the cascade is taken by hand over the real
 * stylesheets, for the card the real template emits: a value declared on the card itself
 * beats any it would inherit, and a card with none inherits its prop's.
 */
describe("the projection stock in the dark", () => {
  const css = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".css")) out.push(readFileSync(full, "utf8"));
      }
    };
    walk(join(import.meta.dirname, "..", "styles"));
    return out.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  })();
  const setters = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((rule) => /--dp-card-dim\s*:/.test(rule.body))
    .map((rule) => ({
      selector: rule.selector,
      value: /--dp-card-dim\s*:([^;]*)/.exec(rule.body)![1].trim(),
    }));

  /** The `--dp-card-dim` a mounted card of this stock ends up with. */
  function cardDim(paper: string): string | null {
    const prop = document.createElement("div");
    prop.className = "dp-prop";
    prop.innerHTML = cardHtml({
      title: "Readout",
      bodyHtml: "<p>SIGNAL</p>",
      showTitle: true,
      paper,
      fontPx: 14,
      padPx: 20,
      effectId: "projected-readout",
    });
    const card = prop.querySelector<HTMLElement>(".dp-card")!;
    const own = setters.filter((rule) => card.matches(rule.selector));
    expect(own.length).toBeLessThanOrEqual(1);
    if (own.length) return own[0].value;
    return setters.find((rule) => prop.matches(rule.selector))?.value ?? null;
  }

  it("keeps a projected readout at full brightness in a dark scene, and darkens every paper", () => {
    expect(cardDim("projection")).toBe("1");
    for (const paper of ["parchment", "vellum", "paper", "linen", "slate", "bloodied"]) {
      expect(cardDim(paper), paper).toBe("var(--dp-scene-dim, 1)");
    }
  });
});
