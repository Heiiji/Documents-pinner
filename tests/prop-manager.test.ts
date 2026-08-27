/**
 * @vitest-environment jsdom
 *
 * `PropManager` had no test import at all, which is where the async-lifetime defects
 * lived: five awaits between deciding to draw and writing the result, with nothing
 * checking that the record, the tile or the scene still existed, and an `invalidate` that
 * destroyed textures the meshes were still pointing at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const resolved = { hash: "h1" };

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => ({
    html: '<div class="dp-card">letter</div>',
    title: "Letter",
    readable: true,
    contentHash: resolved.hash,
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
  releaseTexture: vi.fn((texture: any) => {
    if (texture) texture.destroyed = true;
  }),
}));

vi.mock("../src/render/AssetInliner", () => ({
  inlineFonts: vi.fn(async () => ""),
  inlineImages: vi.fn(async (html: string) => html),
}));

function propTile(id: string) {
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
          followName: true,
        },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

/** Let the debounced LOD pass and the concurrency-1 generation queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

let tiles: any[];
let manager: any;

beforeEach(async () => {
  vi.resetModules();
  resolved.hash = "h1";
  tiles = [propTile("t1")];
  installWorld({ isGM: true, tiles, settings: { rendering: "canvas", autoDegrade: false } });

  const { propManager } = await import("../src/canvas/PropManager");
  manager = propManager();
  manager.refresh();
  await settle();
});

afterEach(() => {
  manager?.stop();
  uninstallWorld();
});

describe("the texture cache key", () => {
  it("carries a content signal, so an edit actually invalidates", async () => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    const first = vi.mocked(resolveCard).mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // Nothing changed: the next pass hits the cache and resolves nothing.
    manager.refresh();
    await settle();
    expect(vi.mocked(resolveCard).mock.calls.length).toBe(first);

    // The page behind the prop was edited.
    resolved.hash = "h2";
    manager.invalidate("JournalEntry.j");
    await settle();
    expect(vi.mocked(resolveCard).mock.calls.length).toBeGreaterThan(first);
  });

  it("invalidates a prop pinned to a whole entry when one of its PAGES changes", async () => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    const before = vi.mocked(resolveCard).mock.calls.length;

    resolved.hash = "h3";
    // The page uuid is longer than the entry uuid, so prefix-matching the cache keys
    // alone finds nothing — which is why the prop stayed stale for the session.
    manager.invalidate("JournalEntry.j.JournalEntryPage.p");
    await settle();

    expect(vi.mocked(resolveCard).mock.calls.length).toBeGreaterThan(before);
  });
});

describe("invalidate", () => {
  it("restores core's own texture BEFORE destroying ours", () => {
    const mesh = tiles[0].object.mesh;
    // The prop has drawn, so the mesh is carrying our texture rather than core's.
    const bound = mesh.texture;
    expect(bound.id).toBe("tex");

    manager.invalidate("JournalEntry.j");

    // It used to destroy through the cache and THEN null every record's `boundKey`, so
    // `#unbind` early-returned and the mesh kept pointing at a destroyed texture.
    expect(mesh.texture.id).toBe("core-texture");
    expect(bound.destroyed).toBe(true);
  });
});

describe("stop", () => {
  it("does not write a pending rasterisation into the next scene's cache", async () => {
    const { rasterise } = await import("../src/render/Rasterizer");
    const before = manager.stats().textures;
    expect(before).toBeGreaterThan(0);

    resolved.hash = "h4";
    manager.invalidate("JournalEntry.j");
    // Tear down while the generate for that invalidation is still in flight.
    manager.stop();
    await settle();

    expect(manager.stats().textures).toBe(0);
    expect(rasterise).toHaveBeenCalled();
  });
});

describe("onTileDrawn", () => {
  it("re-captures the texture core replaced and drops the stale binding", async () => {
    const tile = tiles[0].object;
    const fresh = { id: "core-redraw" };
    tile.mesh = { texture: fresh, alpha: 1, visible: true };

    manager.onTileDrawn(tile);
    // The record now believes core's texture is the new one, so a later restore puts
    // that back rather than a texture core had already discarded.
    manager.stop();
    expect(tile.mesh.texture).toBe(fresh);
  });
});

/**
 * Every anchor now carries a real placeholder texture, because core builds no mesh
 * without one — so the mesh always has something to draw and the two tiers have to say
 * when that something should be seen.
 */
describe("the mesh under a prop", () => {
  it("is drawn once the prop's own texture is bound", () => {
    expect(tiles[0].object.mesh.alpha).toBe(1);
  });

  it("is held at zero while a readable-sized prop is still being drawn", async () => {
    // Invalidating drops the binding; the placeholder is an icon, and stretching it
    // across a prop the GM is waiting for reads as a bug rather than as loading.
    manager.invalidate("JournalEntry.j");
    manager.applyAlpha();
    expect(tiles[0].object.mesh.alpha).toBe(0);

    await settle();
    expect(tiles[0].object.mesh.alpha).toBe(1);
  });
});

describe("switching the rendering setting mid-session", () => {
  it("clears the DOM cards when the canvas path takes over again", async () => {
    const { domPropCount } = await import("../src/canvas/DomPropTier");
    const game = (globalThis as any).game;

    // Start on the DOM path.
    await game.settings.set("documents-pinner", "rendering", "dom");
    manager.refresh();
    await settle();
    expect(domPropCount()).toBe(1);

    // ...and back. Without the clear, every card stayed mounted over the meshes now
    // drawing the same props.
    await game.settings.set("documents-pinner", "rendering", "canvas");
    manager.refresh();
    await settle();
    expect(domPropCount()).toBe(0);
  });
});
