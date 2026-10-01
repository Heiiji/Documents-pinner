/**
 * @vitest-environment jsdom
 *
 * The props' runtime signals: the frame rate the perf guard and the `auto` effects level
 * read, and the settings a prop is drawn from. Each is driven through the path core
 * drives — the ticker's callback, `sampleFrame`, a setting's `onChange` — rather than
 * through the pure function underneath, because every defect here was in the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => ({
    html: '<div class="dp-card">letter</div>',
    title: "Letter",
    readable: true,
    contentHash: "h1",
    missing: false,
  })),
}));

vi.mock("../src/render/Rasterizer", () => ({
  loadCardCss: vi.fn(async () => ""),
  rasterise: vi.fn(async () => ({
    texture: { id: "tex", destroyed: false, destroy: vi.fn() },
    width: 256,
    height: 256,
    bytes: 1024,
  })),
  rasterisationAvailable: () => true,
  releaseTexture: vi.fn(),
}));

vi.mock("../src/render/AssetInliner", () => ({
  inlineFonts: vi.fn(async () => ""),
  inlineImages: vi.fn(async (html: string) => html),
}));

function propTile(id: string, effectId = defaultPin().effect.id) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, width: 400, height: 560 });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: "JournalEntry.j",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
        },
        effect: { ...defaultPin().effect, id: effectId },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

/** The clock `performance.now()` reads, advanced by the frames a test plays. */
let now = 1000;

beforeEach(() => {
  vi.resetModules();
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uninstallWorld();
});

describe("the perf guard", () => {
  let world: ReturnType<typeof installWorld>;
  let manager: any;
  let tick: () => void;

  beforeEach(async () => {
    world = installWorld({
      isGM: true,
      tiles: [propTile("t1")],
      settings: { rendering: "canvas", autoDegrade: true, effectsLevel: "full" },
    });
    // PIXI's ticker, capped at core's default 60; the test plays its frames by hand.
    world.canvas.app.ticker = {
      maxFPS: 60,
      add: (fn: () => void) => (tick = fn),
      remove: () => {},
    };
    const { propManager } = await import("../src/canvas/PropManager");
    manager = propManager();
    manager.start();
  });

  afterEach(() => manager.stop());

  /** Frames at a steady rate for a while, as the ticker would call them. */
  function play(fps: number, seconds: number) {
    for (let i = 0; i < fps * seconds; i++) {
      now += 1000 / fps;
      tick();
    }
  }

  it.each([
    [
      "never fires on a tab-away at a steady 60 fps",
      () => {
        play(60, 3);
        now += 5000; // the tab is hidden: no frames at all
        play(60, 5);
      },
      false,
    ],
    ["still fires on a scene that holds 30 fps", () => play(30, 5), true],
  ])("%s", (_label, run, fires) => {
    run();
    expect(manager.stats().degraded).toBe(fires);
    expect(world.notifications.some((n) => n.message === "DP.notice.degraded")).toBe(fires);
  });
});

describe("the auto effects level", () => {
  it("holds its answer while the frame rate sits between the line down and the line back up", async () => {
    installWorld({ settings: { effectsLevel: "auto" } });
    // A capable machine, wherever the suite runs: only the frame rate decides here.
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    const { currentLevel, sampleFrame } = await import("../src/effects/level");
    const play = (fps: number, seconds: number) => {
      for (let i = 0; i < fps * seconds; i++) sampleFrame((now += 1000 / fps));
    };

    play(30, 6);
    expect(currentLevel()).toBe("reduced");
    // 43 fps: over the line down, under the line back up. One line flipped it here.
    play(43, 10);
    expect(currentLevel()).toBe("reduced");
    play(60, 10);
    expect(currentLevel()).toBe("full");
  });
});
