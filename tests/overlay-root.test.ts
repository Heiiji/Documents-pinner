/**
 * @vitest-environment jsdom
 *
 * The root cause of "the document doesn't draw at all", found by running the module in a
 * real Foundry world rather than by reading it.
 *
 * `write()` queued ONE callback per element, so whenever two callers wrote different
 * properties of the same element in the same frame, the first was silently dropped. That
 * happens on two paths that both matter:
 *
 * - `canvasReady` calls `alignToBoard()` then `syncTransform()` back to back, so the
 *   overlay's SIZE write was replaced by its TRANSFORM write. The overlay stayed 0x0
 *   with `overflow: hidden`, which hides the entire DOM tier — every prop, the placement
 *   ghost and the focus reader.
 * - a LOD pass calls `DomPropTier.place()` then `setDomPropAlpha()`, so each card's
 *   geometry write was replaced by its opacity write. Observed live: a card carrying
 *   `style="opacity: 0.25"` and nothing else, laid out at 0x0.
 *
 * And the overlay was sized to the renderer's SCREEN while everything inside it is
 * positioned in SCENE coordinates — two different spaces, one box — so even once sized,
 * `overflow: hidden` clipped away every prop past the screen's width on the map.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

let overlayRoot: typeof import("../src/apps/OverlayRoot");

beforeEach(async () => {
  document.body.innerHTML = '<div id="board"></div>';
  installWorld({});
  overlayRoot = await import("../src/apps/OverlayRoot");
  overlayRoot.destroyOverlay();
});

afterEach(() => {
  overlayRoot.destroyOverlay();
  uninstallWorld();
});

describe("write", () => {
  it("runs every queued write for an element, not just the last one", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);

    overlayRoot.write(element, () => {
      element.style.width = "100px";
    });
    overlayRoot.write(element, () => {
      element.style.opacity = "0.5";
    });
    await frame();

    expect(element.style.width).toBe("100px");
    expect(element.style.opacity).toBe("0.5");
  });

  it("still lets a later write to the SAME property win", async () => {
    const element = document.createElement("div");
    overlayRoot.write(element, () => {
      element.style.left = "10px";
    });
    overlayRoot.write(element, () => {
      element.style.left = "20px";
    });
    await frame();

    expect(element.style.left).toBe("20px");
  });

  it("batches into one frame rather than one per call", async () => {
    const element = document.createElement("div");
    let runs = 0;
    for (let i = 0; i < 5; i++) overlayRoot.write(element, () => runs++);

    expect(runs).toBe(0);
    await frame();
    expect(runs).toBe(5);
  });
});

describe("the overlay on canvasReady", () => {
  it("ends up with BOTH a size and a transform", async () => {
    // The exact sequence `main.ts` runs, and the one that lost the size.
    overlayRoot.alignToBoard();
    overlayRoot.syncTransform(true);
    await frame();

    const element = document.getElementById("documents-pinner-overlay")!;
    expect(element.style.width).not.toBe("");
    expect(element.style.height).not.toBe("");
    expect(element.style.transform).not.toBe("");
  });

  it("is sized to the SCENE, because its children are in scene coordinates", async () => {
    const world = installWorld({});
    world.canvas.dimensions = { width: 3840, height: 1920 };
    world.canvas.app.renderer.screen = { width: 1400, height: 900 };

    overlayRoot.destroyOverlay();
    overlayRoot.alignToBoard();
    await frame();

    const element = document.getElementById("documents-pinner-overlay")!;
    // A prop at scene x=1900 is outside a 1400-wide box no matter what the transform is,
    // and `overflow: hidden` then clips it away entirely.
    expect(element.style.width).toBe("3840px");
    expect(element.style.height).toBe("1920px");
  });

  it("does nothing rather than sizing to zero when the scene has no dimensions", async () => {
    const world = installWorld({});
    world.canvas.dimensions = undefined;

    overlayRoot.destroyOverlay();
    overlayRoot.alignToBoard();
    await frame();

    const element = document.getElementById("documents-pinner-overlay");
    expect(element?.style.width ?? "").toBe("");
  });
});

/**
 * `requestAnimationFrame` does not fire while the document is hidden, and a Foundry client
 * in a background tab is completely ordinary — a GM prepping in another window, a second
 * monitor, a laptop lid. Without a floor under the rAF, the first frame's worth of writes
 * is queued and never applied: the overlay is never sized and no prop is ever positioned,
 * so the whole DOM tier stays invisible.
 *
 * Measured in a live world with `document.hidden === true`: rAF silent, every queued write
 * lost, `.dp-prop` carrying no inline style at all.
 */
describe("when the tab is hidden and rAF never fires", () => {
  it("still applies queued writes, on a timeout floor", async () => {
    const raf = globalThis.requestAnimationFrame;
    // A rAF that never calls back, which is exactly what a hidden document provides.
    globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;

    try {
      const element = document.createElement("div");
      overlayRoot.write(element, () => {
        element.style.width = "123px";
      });

      expect(element.style.width).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(element.style.width).toBe("123px");
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });

  it("applies each write only once when both schedulers are armed", async () => {
    const element = document.createElement("div");
    let runs = 0;
    overlayRoot.write(element, () => runs++);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(runs).toBe(1);
  });
});
