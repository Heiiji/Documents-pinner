/**
 * @vitest-environment jsdom
 *
 * A pinned PDF on the canvas tier: pdf.js paints the page, the manager bakes the preset onto
 * it and uploads it (DESIGN A12, A16).
 *
 * `renderPdfPage` caches its canvas per file, page and size, and `PIXI.Texture.from` caches
 * its texture per canvas (DESIGN §6.2). So whatever reaches the upload must be a canvas of
 * this prop's own: handed the page cache's, two props of one page shared one texture under
 * two cache keys, and evicting either destroyed the texture the other was drawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

/** The page cache's own canvas, one per size, as `PdfPage` keeps it. */
const pages = new Map<number, any>();
function pageAt(longEdge: number) {
  if (!pages.has(longEdge)) {
    const canvas = { id: `page@${longEdge}`, width: longEdge, height: Math.round(longEdge * 1.41) };
    pages.set(longEdge, { canvas, width: canvas.width, height: canvas.height });
  }
  return pages.get(longEdge);
}

vi.mock("../src/render/PdfPage", () => ({
  renderPdfPage: vi.fn(async (_src: string, _page: number, longEdge: number) => pageAt(longEdge)),
}));

vi.mock("../src/render/BakeEffects", () => ({
  copyCanvas: vi.fn((source: any) => ({
    copyOf: source,
    width: source.width,
    height: source.height,
  })),
  bakeEffects: vi.fn(async () => {}),
  clearBakeCache: vi.fn(),
}));

vi.mock("../src/render/Rasterizer", () => ({
  loadCardCss: vi.fn(async () => ""),
  rasterise: vi.fn(async () => null),
  // HTML cannot reach a texture here, as on every engine today; a PDF still can.
  rasterisationAvailable: () => false,
  releaseTexture: vi.fn(),
  textureFromCanvas: vi.fn((source: any, width: number, height: number) => ({
    texture: { source, destroyed: false, destroy: vi.fn() },
    width,
    height,
    bytes: width * height * 4,
  })),
}));

vi.mock("../src/render/ContentResolver", () => ({ resolveCard: vi.fn() }));

vi.mock("../src/sources/describe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sources/describe")>()),
  isPdfPin: () => true,
  pdfSourceForPin: () => "files/manual.pdf",
  pdfPageOf: () => 1,
}));

function pdfTile(id: string, effectId: string) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, width: 400, height: 560 });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: "JournalEntry.manual.JournalEntryPage.pdf",
          src: null,
          pageId: null,
          pdfPage: 1,
          followName: true,
        },
        effect: { ...defaultPin().effect, id: effectId, intensity: 1 },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

const settle = () => vi.runAllTimersAsync();

let manager: any;

async function start(tiles: any[]) {
  installWorld({
    isGM: true,
    tiles,
    settings: { rendering: "canvas", autoDegrade: false, effectsLevel: "full" },
  });
  const { propManager } = await import("../src/canvas/PropManager");
  manager = propManager();
  manager.refresh();
  await settle();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  pages.clear();
});

afterEach(() => {
  manager?.stop();
  vi.useRealTimers();
  uninstallWorld();
});

describe("a PDF page on the canvas tier", () => {
  it("is uploaded from a copy even with no effect to paint on it — a preset since deleted", async () => {
    // Two props of one page under two keys: each names a preset that no longer exists, so
    // neither has anything to bake, and both are drawn from the same cached page.
    const tiles = [pdfTile("t1", "a-preset-since-deleted"), pdfTile("t2", "another-one-gone")];
    await start(tiles);
    const { textureFromCanvas } = await import("../src/render/Rasterizer");

    const uploaded = vi.mocked(textureFromCanvas).mock.calls.map(([source]) => source);
    expect(uploaded).toHaveLength(2);
    for (const source of uploaded) {
      expect([...pages.values()].map((page) => page.canvas)).not.toContain(source);
      expect(source.copyOf).toBe(pageAt(1024).canvas);
    }
    // Two props of one page: two canvases, so `Texture.from` makes two textures.
    expect(uploaded[0]).not.toBe(uploaded[1]);
    expect(tiles[0].object.mesh.texture).not.toBe(tiles[1].object.mesh.texture);
  });

  it("is baked again at full strength when the coarse rung's 512 px page would fit", async () => {
    const tiles = [pdfTile("t1", "aged-parchment")];
    await start(tiles);
    const { bakeEffects } = await import("../src/render/BakeEffects");
    const strength = () => vi.mocked(bakeEffects).mock.lastCall?.[1]["--dp-i"];
    const stage = (globalThis as any).canvas.stage.worldTransform;

    // 280 px across: the coarse rung, baked at half strength.
    stage.a = stage.d = 0.7;
    manager.refresh();
    await settle();
    expect(strength()).toBe("0.5");

    // 340 px across: the full rung, at the same 512 px. Served the coarse texture, it kept
    // the half-strength stains until the next zoom that changed the size.
    stage.a = stage.d = 0.85;
    manager.refresh();
    await settle();
    expect(strength()).toBe("1");
  });
});
