/**
 * The DOM overlay that tracks the canvas.
 *
 * IMPURE. The maths is not here — it is in `canvas/transform.ts`, pure and tested.
 * This file owns the element, the mount point and the write schedule.
 *
 * Three rules, each of which is a frame-rate bug if broken:
 *
 * 1. **The transform is applied as ONE `matrix()` on the root**, not per card. The
 *    stage transform is the same for every element in scene space, so one composited
 *    write moves all of them and the browser never re-lays-out a card that only moved.
 *
 * 2. **Sync is guarded by a dirty check on the six matrix components, not by the
 *    `canvasPan` hook.** That hook fires every tick for the whole duration of an
 *    animated pan; six float comparisons per frame cost nothing and skip the write
 *    entirely whenever the view is still, which is most of the time.
 *
 * 3. **DOM access is write-only inside a frame.** Nothing here reads
 *    `getBoundingClientRect`, and every style change is batched into one rAF, so the
 *    module can never force a synchronous layout in the middle of a canvas frame.
 *
 * The mount point is DERIVED, never hardcoded: `#board`'s parent turned out to carry
 * no id in a real v14 world, so the overlay attaches as its sibling by reference. It
 * sits at `z-index: 90`, below core's HUD at 100, and passes pointer events through
 * except on the cards that opt in.
 */

import { cv } from "../fvtt";
import { IDENTITY, sameMat, stageMatrix, toCssMatrix, type Mat } from "../canvas/transform";

const ROOT_ID = "documents-pinner-overlay";

let root: HTMLElement | null = null;
let lastMatrix: Mat = { ...IDENTITY };
let frame = 0;
/** Style writes queued for the next frame, keyed so a later write wins. */
const pending = new Map<HTMLElement, () => void>();

/**
 * Where the overlay attaches.
 *
 * `#board` is the canvas element; its parent is the positioned container core also
 * puts `#hud` in, which is exactly the coordinate space we want. Falls back to
 * `#interface` and then to `body` so a layout change downstream degrades to a
 * mispositioned overlay rather than none at all.
 */
function mountPoint(): HTMLElement | null {
  const board = document.getElementById("board");
  return (
    board?.parentElement ??
    document.getElementById("interface") ??
    document.getElementById("hud")?.parentElement ??
    document.body ??
    null
  );
}

/** The overlay element, created on first use. */
export function overlay(): HTMLElement | null {
  if (root?.isConnected) return root;

  const parent = mountPoint();
  if (!parent) return null;

  root = document.getElementById(ROOT_ID) as HTMLElement | null;
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("aria-hidden", "false");
  }
  if (root.parentElement !== parent) parent.appendChild(root);

  lastMatrix = { ...IDENTITY };
  return root;
}

export function destroyOverlay(): void {
  root?.remove();
  root = null;
  pending.clear();
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

/**
 * Match the overlay to the current stage transform.
 *
 * Safe to call every tick: it returns immediately unless the transform actually
 * changed. Returns whether a write was made, which the callers use to decide whether
 * anything downstream needs recomputing.
 */
export function syncTransform(force = false): boolean {
  const element = overlay();
  if (!element) return false;

  const matrix = stageMatrix();
  if (!force && sameMat(matrix, lastMatrix)) return false;

  lastMatrix = matrix;
  write(element, () => {
    element.style.transform = toCssMatrix(matrix);
  });
  return true;
}

/**
 * Size the overlay to the canvas.
 *
 * Separate from `syncTransform` because it changes only when the window resizes,
 * whereas the transform changes on every pan.
 */
export function alignToBoard(): void {
  const element = overlay();
  const screen = cv()?.app?.renderer?.screen;
  if (!element || !screen) return;

  write(element, () => {
    element.style.width = `${screen.width}px`;
    element.style.height = `${screen.height}px`;
  });
}

/**
 * Queue a style write for the next frame.
 *
 * One rAF for the whole module, and one entry per element: a card whose transform is
 * set twice before the frame lands writes once, with the later value. Writing
 * immediately would interleave our writes with canvas reads elsewhere in the frame.
 */
export function write(element: HTMLElement, apply: () => void): void {
  pending.set(element, apply);
  if (frame) return;

  frame = requestAnimationFrame(() => {
    frame = 0;
    const work = [...pending.values()];
    pending.clear();
    for (const apply of work) apply();
  });
}

/** Add a card to the overlay. The caller owns the element and its removal. */
export function mount(element: HTMLElement): void {
  overlay()?.appendChild(element);
}

/** The matrix the overlay was last drawn with, for tests and for the ghost. */
export function currentMatrix(): Mat {
  return { ...lastMatrix };
}
