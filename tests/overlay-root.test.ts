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

/**
 * Where the overlay sits in the stacking order, which turned out to be a hard blocker.
 *
 * v14's body is flat and its numbers are its own: `#board` is `z-index: 0`, `#hud` is 1,
 * and the interface's `#ui-left` / `#ui-right` are 30 inside a `z-index: auto` parent — so
 * those compete in the ROOT stacking context. The overlay was at 90, chosen against an
 * assumption about core's HUD that is not true here, and it painted over the sidebar, the
 * chat log, the scene controls and the hotbar.
 *
 * The right place is the canvas's own level, immediately after the canvas.
 */
describe("where the overlay sits", () => {
  function foundryBody() {
    document.body.innerHTML = "";
    for (const id of ["interface", "hud", "board", "pause"]) {
      const el = id === "board" ? document.createElement("canvas") : document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
  }

  it("mounts immediately after the canvas, not at the end of the body", () => {
    foundryBody();
    overlayRoot.destroyOverlay();
    const element = overlayRoot.overlay()!;

    expect(element.previousElementSibling?.id).toBe("board");
  });

  it("re-seats itself once the canvas exists, having started without one", () => {
    document.body.innerHTML = "";
    overlayRoot.destroyOverlay();
    const early = overlayRoot.overlay()!;
    expect(early.parentElement).toBe(document.body);
    expect(early.previousElementSibling).toBeNull();

    // Foundry builds its canvas AROUND the overlay, which is already in the body — so the
    // element survives and has to move itself, or it paints in the wrong order for the
    // rest of the session.
    for (const id of ["interface", "hud", "board"]) {
      const el = id === "board" ? document.createElement("canvas") : document.createElement("div");
      el.id = id;
      document.body.insertBefore(el, early);
    }

    const later = overlayRoot.overlay()!;
    expect(later).toBe(early);
    expect(later.previousElementSibling?.id).toBe("board");
  });

  it("keeps the same element rather than making a second overlay", () => {
    foundryBody();
    overlayRoot.destroyOverlay();
    overlayRoot.overlay();
    overlayRoot.overlay();
    overlayRoot.overlay();

    expect(document.querySelectorAll("#documents-pinner-overlay")).toHaveLength(1);
  });
});

/**
 * Every appearance in the module animated and no disappearance did. `leave()` is the one
 * exit mechanism: a class through the write queue, removal on the element's own
 * `transitionend` or on a timeout floor, so nothing is ever left behind.
 */
describe("leave", () => {
  it("adds the class at once and removes the element on transitionend", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const done = overlayRoot.leave(element, "gone");
    expect(element.classList.contains("gone")).toBe(true);
    expect(element.isConnected).toBe(true);

    element.dispatchEvent(new Event("transitionend"));
    await done;
    expect(element.isConnected).toBe(false);
  });

  it("ignores a child's transitionend and waits for its own", async () => {
    const element = document.createElement("div");
    const child = document.createElement("span");
    element.appendChild(child);
    document.body.appendChild(element);
    void overlayRoot.leave(element, "gone");

    child.dispatchEvent(new Event("transitionend", { bubbles: true }));
    expect(element.isConnected).toBe(true);
  });

  it("removes the element on the timeout floor when no transition ever ends", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const done = overlayRoot.leave(element, "gone");
    await done;
    expect(element.isConnected).toBe(false);
  });

  it("removes a detached element at once", async () => {
    const element = document.createElement("div");
    await overlayRoot.leave(element, "gone");
    expect(element.classList.contains("gone")).toBe(false);
  });
});
