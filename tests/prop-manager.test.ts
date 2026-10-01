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
import {
  fakeTile,
  installWorld,
  scheduledAnimations,
  uninstallWorld,
} from "./helpers/fake-foundry";

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

/** A rasterisation that lands: the default, put back after any test that changes it. */
const draw = async () => ({
  texture: { id: "tex", destroyed: false, destroy: vi.fn() },
  width: 256,
  height: 256,
  bytes: 1024,
});

vi.mock("../src/render/Rasterizer", () => ({
  loadCardCss: vi.fn(async () => ""),
  rasterise: vi.fn(() => draw()),
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
          pdfPage: null,
          followName: true,
        },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

/**
 * Let the debounced LOD pass and the concurrency-1 generation queue drain. The timers are
 * fake, so this runs every pending timeout — the 250 ms edit debounce, the idle shim the
 * queue pumps on — and the promises between them, without waiting on the clock.
 */
const settle = () => vi.runAllTimersAsync();

let tiles: any[];
let manager: any;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  resolved.hash = "h1";
  tiles = [propTile("t1")];
  installWorld({
    isGM: true,
    tiles,
    // `full` and a resolving CanvasAnimation, so the reveal path is really exercised
    // rather than skipped by an unrelated guard.
    settings: { rendering: "canvas", autoDegrade: false, effectsLevel: "full" },
  });

  const { propManager } = await import("../src/canvas/PropManager");
  manager = propManager();
  manager.refresh();
  await settle();
});

afterEach(async () => {
  manager?.stop();
  vi.useRealTimers();
  uninstallWorld();
  // A mock implementation survives `vi.resetModules()`, so a test that made the
  // rasteriser hang would starve every test after it of a texture.
  const { rasterise } = await import("../src/render/Rasterizer");
  vi.mocked(rasterise).mockImplementation(() => draw());
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

/**
 * Everything drawn INTO the pixels belongs in the key, for the same reason the preset does:
 * a change the key does not carry hits the cache, binds the old texture and returns before
 * ever resolving — the GM picks another page, size or typeface and nothing happens, forever.
 *
 * - **The type size and the pin's own typeface.** Geometry was already there; now that a
 *   resize means "show more of the page" rather than "the same page, larger", both have to
 *   stay a cache miss.
 * - **The chosen page, PDF page or text field.** The provisional key is built from the
 *   PREVIOUS draw's content hash, so these have to be in it. And they sit in the docHash
 *   rather than the uuid, because `TextureCache.keysFor` prefix-matches `${uuid}|`: folding
 *   them into the uuid would break `invalidate` for every prop at once.
 */
describe("the texture cache key and what is drawn into the pixels", () => {
  const pinOf = () => tiles[0].flags["documents-pinner"].pin;

  it.each([
    ["the type size", () => (pinOf().display.typeSize = 12)],
    ["the pin's own typeface", () => (pinOf().display.font = "monospace")],
    ["the journal page", () => (pinOf().source.pageId = "aBcD1234eFgH5678")],
    ["the PDF page", () => (pinOf().source.pdfPage = 4)],
    [
      "the text an actor or an item shows",
      () => (pinOf().source.field = "details.biography.public"),
    ],
  ])("is a cache miss when %s changes", async (_what, change) => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    const before = vi.mocked(resolveCard).mock.calls.length;

    change();
    manager.refresh();
    await settle();

    expect(vi.mocked(resolveCard).mock.calls.length).toBeGreaterThan(before);
  });

  it("is a cache miss when a prop with stored metrics is resized", async () => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    const pin = pinOf();
    pin.display.typeSize = 12;
    pin.display.margin = 1.5;
    manager.refresh();
    await settle();
    const before = vi.mocked(resolveCard).mock.calls.length;

    // The type no longer follows the tile, so only the geometry in the key can catch this.
    tiles[0].width = 800;
    tiles[0].height = 1132;
    manager.refresh();
    await settle();

    expect(vi.mocked(resolveCard).mock.calls.length).toBeGreaterThan(before);
  });

  it("still invalidates by source uuid once a page is chosen", async () => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    pinOf().source.pageId = "aBcD1234eFgH5678";
    manager.refresh();
    await settle();
    const before = vi.mocked(resolveCard).mock.calls.length;

    resolved.hash = "h4";
    manager.invalidate("JournalEntry.j");
    await settle();

    expect(vi.mocked(resolveCard).mock.calls.length).toBeGreaterThan(before);
  });
});

describe("the effects level on the overlay", () => {
  it("is written once per LOD pass, so the DOM tier obeys the same level as the canvas tier", () => {
    const root = document.getElementById("documents-pinner-overlay");
    expect(root?.dataset.dpLevel).toBe("full");
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

/**
 * On every engine where HTML does not rasterise — every engine today — the DOM tier draws
 * every text prop, and `invalidate` only ever reset the canvas cache. A GM who corrected
 * a pinned letter saw the new text in the reader and the old text on the map.
 */
describe("an edit to the source on the DOM path", () => {
  it("re-resolves the card on the map, not only the canvas texture", async () => {
    const { resolveCard } = await import("../src/render/ContentResolver");
    await (globalThis as any).game.settings.set("documents-pinner", "rendering", "dom");
    manager.refresh();
    await settle();
    const before = vi.mocked(resolveCard).mock.calls.length;

    // A pass with nothing changed resolves nothing...
    manager.refresh();
    await settle();
    expect(vi.mocked(resolveCard).mock.calls.length).toBe(before);

    // ...and an edit to the page behind the pin does.
    manager.invalidate("JournalEntry.j.JournalEntryPage.p");
    await settle();
    expect(vi.mocked(resolveCard).mock.calls.length).toBe(before + 1);
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

/**
 * Two paths that overrode the "hold the mesh at zero" rule and put the placeholder icon
 * on screen anyway — a book stretched across a letter, which is the artefact that rule
 * exists to prevent.
 */
describe("the placeholder never gets shown", () => {
  it("re-applies alpha after a VRAM eviction restores it", async () => {
    const mesh = tiles[0].object.mesh;
    expect(mesh.alpha).toBe(1);

    // A budget of nothing evicts on the next trim, which restores core's texture.
    await (globalThis as any).game.settings.set("documents-pinner", "vramBudgetMb", 0);
    manager.refresh();
    await settle();

    expect(mesh.texture.id).toBe("core-texture");
    // `applyAlpha` used to run BEFORE `#trim`, so the restored placeholder sat at full
    // alpha until the next pan, edit or zoom.
    expect(mesh.alpha).toBe(0);
  });

  it("does not fade the placeholder in when a pin is revealed before it is drawn", async () => {
    const { rasterise } = await import("../src/render/Rasterizer");
    const object = tiles[0].object;

    // A rasterisation that never lands, which is the state every reveal fires in: the
    // prop's own texture has by definition not been drawn yet.
    vi.mocked(rasterise).mockImplementation(() => new Promise(() => {}));
    const before = scheduledAnimations().length;

    // Unbind, then hide: the record has to already exist and have been seen as invisible,
    // because the reveal fires on the false -> true transition.
    manager.invalidate("JournalEntry.j");
    object.isVisible = false;
    manager.refresh();
    await settle();

    // ...and now revealed, with nothing bound.
    object.isVisible = true;
    manager.refresh();
    await settle();

    // The reveal must not animate the MESH at all: a real animation runs over its
    // duration and would land on full alpha with only the placeholder bound, so the
    // absence of the animation is what has to be asserted, not the value it left behind.
    // The arrival belongs to `#arrive`, once the texture is actually there.
    const reveals = scheduledAnimations()
      .slice(before)
      .filter((a) => a.name.includes(".alpha."));
    expect(reveals).toEqual([]);
    expect(object.mesh.alpha).toBe(0);
  });
});

/**
 * The reveal used to play at the moment of the transition, when the mesh was by
 * definition unbound — so it returned early, first reveals arrived through the flat
 * draw-in and a re-reveal of a cached prop popped with no animation at all. The preset's
 * curve and duration were dead on the tier they were written for.
 */
describe("the reveal, at the bind", () => {
  const alphas = (from: number) =>
    scheduledAnimations()
      .slice(from)
      .filter((a) => a.name === "documents-pinner.alpha.t1");

  it("plays once a cached prop is re-revealed, with the texture already there", async () => {
    const object = tiles[0].object;
    object.isVisible = false;
    manager.refresh();
    await settle();

    const before = scheduledAnimations().length;
    object.isVisible = true;
    manager.refresh();
    await settle();

    expect(alphas(before)).toHaveLength(1);
    expect(object.mesh.alpha).toBe(1);
  });

  it("plays nothing for a prop rebound after a pan back — it is found where it was", async () => {
    const world = (globalThis as any).canvas;
    // Far enough that the prop leaves the viewport, then back.
    world.stage.worldTransform.tx = -100000;
    manager.refresh();
    await settle();
    expect(tiles[0].object.mesh.texture.id).toBe("core-texture");

    const before = scheduledAnimations().length;
    world.stage.worldTransform.tx = 0;
    manager.refresh();
    await settle();

    expect(tiles[0].object.mesh.texture.id).toBe("tex");
    expect(alphas(before)).toEqual([]);
  });
});

/** Peek and the token fade eased on the DOM tier and snapped on the canvas tier. */
describe("peek on the canvas tier", () => {
  it("eases the mesh between two visible levels rather than snapping", () => {
    const before = scheduledAnimations().length;
    manager.setPeeking(true);
    const eased = scheduledAnimations()
      .slice(before)
      .filter((a) => a.name === "documents-pinner.alpha.t1");
    expect(eased).toHaveLength(1);
    expect(tiles[0].object.mesh.alpha).toBe(0.15);
  });

  it("does not schedule twice for the same peek", () => {
    manager.setPeeking(true);
    const before = scheduledAnimations().length;
    manager.setPeeking(true);
    expect(scheduledAnimations().length).toBe(before);
  });

  it("writes directly while the mesh is held for a texture — a hold is not a transition", () => {
    manager.invalidate("JournalEntry.j");
    const before = scheduledAnimations().length;
    manager.setPeeking(true);
    expect(scheduledAnimations().length).toBe(before);
    expect(tiles[0].object.mesh.alpha).toBe(0);
  });
});

/**
 * A CanvasAnimation whose animations stay in flight until they are ended, as core's do over
 * their duration. The shared fake lands every animation at once, which is exactly what hid
 * a reveal being cut short: by the time anything looked, it had already arrived.
 */
function holdAnimations() {
  const running = new Map<string, { to: number; duration: number }>();
  const started: { name: string; to: number; duration: number }[] = [];
  (globalThis as any).foundry.canvas.animation.CanvasAnimation = {
    easeInOutCosine: () => 0,
    // Core ends a running animation of the same name before it starts the next.
    animate: (attributes: any[], options: any) => {
      const entry = { to: attributes[0].to, duration: options.duration };
      running.set(options.name, entry);
      started.push({ name: options.name, ...entry });
      return new Promise(() => {});
    },
    getAnimation: (name: string) => running.get(name),
    terminateAnimation: (name: string) => running.delete(name),
  };
  return { running, started };
}

/**
 * "Unchanged" was measured against the mesh's CURRENT alpha, which mid-animation is wherever
 * the animation has got to — so the next texture bind or token move replaced a running
 * reveal, under the shared name, with a 120 ms ease to the value it was already heading for.
 */
describe("the canvas tier's alpha, while it is moving", () => {
  const NAME = "documents-pinner.alpha.t1";

  /** Hide the prop and show it again: a reveal of a texture already in the cache. */
  async function revealed() {
    const object = tiles[0].object;
    object.isVisible = false;
    manager.refresh();
    await settle();
    const held = holdAnimations();
    object.isVisible = true;
    manager.refresh();
    await settle();
    return { object, ...held };
  }

  it("lets a reveal run to its end when a later pass asks for the alpha it is heading to", async () => {
    const { object, running, started } = await revealed();
    const reveal = running.get(NAME);
    expect(reveal).toMatchObject({ to: 1 });
    // Partway through.
    object.mesh.alpha = 0.4;
    const before = started.length;

    // A token moved, or another prop's texture landed: nothing about this one changed.
    manager.applyAlpha();

    expect(started.length).toBe(before);
    expect(running.get(NAME)).toBe(reveal);
    expect(object.mesh.alpha).toBe(0.4);
  });

  it("still eases to a new target in the middle of one: a peek takes over", async () => {
    const { object, running } = await revealed();
    object.mesh.alpha = 0.4;
    manager.setPeeking(true);
    expect(running.get(NAME)).toMatchObject({ to: 0.15 });
  });

  it("stops a reveal when the mesh is held for a texture, rather than fading the placeholder in", async () => {
    const { object, running } = await revealed();
    object.mesh.alpha = 0.4;

    manager.invalidate("JournalEntry.j");
    manager.applyAlpha();

    expect(object.mesh.alpha).toBe(0);
    // Left running, its next tick carried the mesh — and the book now bound to it — up.
    expect(running.has(NAME)).toBe(false);
  });

  it("puts the alpha back once nothing is moving it, after core wrote over it", async () => {
    const { object, running, started } = await revealed();
    object.mesh.alpha = 0.4;
    manager.setPeeking(true);
    // The ease to the peek has arrived...
    running.delete(NAME);
    object.mesh.alpha = 0.15;
    // ...and core's state refresh, on a hover, wrote the placeable's own alpha over it.
    object.mesh.alpha = 1;
    const before = started.length;

    manager.applyAlpha();

    expect(started.slice(before)).toEqual([expect.objectContaining({ name: NAME, to: 0.15 })]);
  });
});
