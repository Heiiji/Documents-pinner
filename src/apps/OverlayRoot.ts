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
 * sits at the canvas's own stacking level, immediately after `#board` — see
 * `mountPoint` for why anything higher paints over the interface — and passes pointer
 * events through except on the cards that opt in.
 */

import { cv } from "../fvtt";
import { IDENTITY, sameMat, stageMatrix, toCssMatrix, type Mat } from "../canvas/transform";

const ROOT_ID = "documents-pinner-overlay";

let root: HTMLElement | null = null;
let lastMatrix: Mat = { ...IDENTITY };
let frame = 0;
/** A timeout floor under the rAF, because rAF never fires in a hidden tab. */
let timer = 0;
/**
 * Style writes queued for the next frame, in order, per element.
 *
 * A LIST and not a single callback. Keying one callback per element silently dropped
 * every write but the last, and two different callers write to the same element in the
 * same frame all the time: `alignToBoard` sizes the overlay and `syncTransform` transforms
 * it, back to back on `canvasReady`; `DomPropTier.place` sets a card's geometry and
 * `setDomPropAlpha` sets its opacity, back to back in one LOD pass.
 *
 * The result was an overlay that was never sized — 0x0 with `overflow: hidden`, which
 * hides the ENTIRE DOM tier — and prop cards with no position or size at all. Running the
 * callbacks in order keeps the intended "a later write to the same property wins" while
 * losing nothing.
 */
const pending = new Map<HTMLElement, (() => void)[]>();

/**
 * Where the overlay attaches, and — just as important — in what ORDER.
 *
 * v14's body is flat, and the numbers are its own:
 *
 *     #interface   position: relative, z-index: auto   (its #ui-left / #ui-right are z 30)
 *     #hud         z-index: 1
 *     #board       position: absolute, z-index: 0      <- the canvas
 *
 * `#ui-left` and `#ui-right` sit at z 30 inside a z-auto parent, so they compete in the
 * ROOT stacking context. An overlay at z 90 therefore painted over the entire interface —
 * the sidebar, the chat log, the scene controls, the hotbar — which is unusable, and was
 * reported as a hard blocker.
 *
 * The right place is the same stacking level as the canvas, immediately after it: above
 * `#board` by DOM order, below `#hud` and far below the interface by their own z-index.
 * That uses Foundry's numbers instead of guessing at them.
 */
function mountPoint(): HTMLElement | null {
  const board = document.getElementById("board");
  return board?.parentElement ?? document.body ?? null;
}

/** Put the overlay immediately after the canvas, wherever the canvas currently is. */
function seat(element: HTMLElement, parent: HTMLElement): void {
  const board = document.getElementById("board");
  if (board?.parentElement === parent) {
    if (element.previousElementSibling !== board) board.after(element);
    return;
  }
  if (element.parentElement !== parent) parent.appendChild(element);
}

/** The overlay element, created on first use. */
export function overlay(): HTMLElement | null {
  const parent = mountPoint();
  if (!parent) return null;

  const existing = root?.isConnected ? root : null;
  if (!existing) {
    root =
      (document.getElementById(ROOT_ID) as HTMLElement | null) ?? document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("aria-hidden", "false");
    lastMatrix = { ...IDENTITY };
  }

  // Re-seated on EVERY call, not just on creation. `overlay()` can run before Foundry has
  // built its canvas, and an overlay left wherever it first landed is an overlay painting
  // in the wrong stacking order for the rest of the session.
  seat(root!, parent);
  return root;
}

export function destroyOverlay(): void {
  root?.remove();
  root = null;
  pending.clear();
  if (frame) cancelAnimationFrame(frame);
  if (timer) window.clearTimeout(timer);
  frame = 0;
  timer = 0;
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
 * Size the overlay to the SCENE, not to the screen.
 *
 * The overlay carries the stage matrix, so everything inside it is positioned in scene
 * coordinates — a prop at `x: 1900` is at 1900 in the overlay's own box. Sizing that box
 * to the renderer's screen (1400x900, say) while `overflow: hidden` is set therefore
 * clipped away every prop past the screen's width in SCENE space, which on any real map
 * is almost all of them. Two different coordinate systems, one box.
 *
 * `canvas.dimensions` is the padded scene rect, which is the space `TileDocument#x/y`
 * live in, and it changes only when the scene does — so this stays a `canvasReady` job
 * rather than a per-pan one.
 */
export function alignToBoard(): void {
  const element = overlay();
  const dimensions = cv()?.dimensions;
  if (!element || !dimensions?.width || !dimensions?.height) return;

  write(element, () => {
    element.style.width = `${dimensions.width}px`;
    element.style.height = `${dimensions.height}px`;
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
  const queued = pending.get(element);
  if (queued) queued.push(apply);
  else pending.set(element, [apply]);

  if (frame || timer) return;

  frame = requestAnimationFrame(flush);
  // `requestAnimationFrame` does not fire at all while the document is hidden, and a
  // Foundry client sitting in a background tab is completely ordinary — a GM prepping in
  // another window, a second monitor, a laptop lid. Without this floor the first frame's
  // worth of writes is queued and never applied: the overlay is never sized, no prop is
  // ever positioned, and the whole DOM tier stays invisible until something happens to
  // schedule another write AFTER the tab is visible again. Measured with
  // `document.hidden === true`: rAF silent, every queued write lost.
  timer = window.setTimeout(flush, 250);
}

/** Apply everything queued, exactly once, whichever of the two schedulers got here first. */
function flush(): void {
  if (frame) cancelAnimationFrame(frame);
  if (timer) window.clearTimeout(timer);
  frame = 0;
  timer = 0;

  const work = [...pending.values()];
  pending.clear();
  for (const applies of work) for (const apply of applies) apply();
}

/** Add a card to the overlay. The caller owns the element and its removal. */
export function mount(element: HTMLElement): void {
  overlay()?.appendChild(element);
}

/** The matrix the overlay was last drawn with, for tests and for the ghost. */
export function currentMatrix(): Mat {
  return { ...lastMatrix };
}
