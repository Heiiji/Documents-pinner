/**
 * The placement ghost's state, and the steppers that move it: the wheel, the keys, the
 * size it lands at and the grid it snaps to.
 *
 * PURE but for one read: `E` steps through the preset library (`allPresets()`), so the
 * GM's own presets are in the cycle. Everything else is a function of its arguments, and
 * is tested without a canvas. Mirrors `pinboard-model.ts`: the live ghost — its element,
 * its listeners, the settings it starts from — is `PlacementGhost.ts`, which re-exports
 * every name here, where the tests read them.
 */

import { TYPE_SIZE_MIN, naturalSize } from "../data/pin-schema";
import { allPresets } from "../effects/preset-library";
import type { DpMode, DpSource } from "../types/dp";

/** Everything the ghost holds while armed. Pure data, so the steppers can be tested. */
export interface GhostState {
  source: DpSource;
  mode: DpMode;
  /** Wrapped into 0..359, which is what the document stores. */
  rotation: number;
  /**
   * The same angle, unwrapped, which is what the element is drawn at: a CSS transition
   * from 345° to 0° turns the long way round, so the shown angle only ever accumulates.
   */
  rotationShown: number;
  /** Multiplier on the mode's natural size — the BOX. */
  scale: number;
  /** Type size in scene px — the density. The box and the type are two gestures. */
  typeSize: number;
  /** A height fitted to the content with `F`; forgotten when the box or type changes. */
  heightOverride: number | null;
  /** `F` was pressed and the measurement has not landed yet. */
  fitPending: boolean;
  effectIndex: number;
  audience: "everyone" | "hidden";
  /** Stays armed after a click, for placing a run of markers in one gesture. */
  sticky: boolean;
  /**
   * The Shift being held has already been used as a modifier — a fine rotation, a step
   * back through the effects. Such a hold is not a request to keep stamping, so the click
   * that ends it places once. Cleared when Shift is released.
   */
  shiftChorded: boolean;
  /** Suspend grid snapping while held. */
  freePlace: boolean;
  x: number;
  y: number;
}

export const SCALE_MIN = 0.25;
export const SCALE_MAX = 6;
/** Larger than this on a ghost is a poster, and the Studio slider stops there too. */
export const TYPE_SIZE_GHOST_MAX = 72;
export const TYPE_SIZE_STEP = 0.5;

/**
 * Wheel handling.
 *
 * Four gestures on one wheel, because during placement the hand is already on the
 * pointer and reaching for a slider means losing the position. Rotation snaps to 15° so
 * a letter lands square without fiddling; `Shift` unlocks 1° for the times it should
 * look dropped rather than placed. `Alt` scales the BOX — how big on the map — and
 * `Shift+Alt` the TYPE — how dense; the preview makes the difference visible.
 */
export function stepWheel(
  state: GhostState,
  delta: number,
  mods: { shift?: boolean; alt?: boolean }
): GhostState {
  const direction = delta > 0 ? 1 : -1;
  // A Shift used here is a modifier on the wheel, not a request to keep placing.
  if (mods.shift) state = { ...state, sticky: false, shiftChorded: true };

  if (mods.alt && mods.shift) {
    const typeSize = state.typeSize - direction * TYPE_SIZE_STEP;
    return {
      ...state,
      typeSize: Math.min(TYPE_SIZE_GHOST_MAX, Math.max(TYPE_SIZE_MIN, typeSize)),
      heightOverride: null,
    };
  }
  if (mods.alt) {
    const scale = state.scale * (direction > 0 ? 1 / 1.1 : 1.1);
    return {
      ...state,
      scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)),
      heightOverride: null,
    };
  }
  const step = mods.shift ? 1 : 15;
  const rotation = (((state.rotation + direction * step) % 360) + 360) % 360;
  return { ...state, rotation, rotationShown: state.rotationShown + direction * step };
}

/**
 * Key handling, as a pure state transition.
 *
 * Returns `null` for a key the ghost does not claim, so the caller knows whether to
 * consume the event — swallowing keys the ghost has no opinion about would break every
 * other shortcut in Foundry while a pin is armed.
 */
export function stepKey(
  state: GhostState,
  key: string,
  mods: { shift?: boolean } = {}
): GhostState | "cancel" | "help" | null {
  switch (key) {
    case "Escape":
      return "cancel";
    case "?":
      return "help";
    case " ":
      return { ...state, mode: state.mode === "prop" ? "pin" : "prop", heightOverride: null };
    case "f":
    case "F":
      // Claimed here; the measurement is asynchronous and lands through `render`.
      return state.mode === "prop" ? { ...state, fitPending: true } : state;
    case "e":
    case "E": {
      const step = mods.shift ? -1 : 1;
      const next = (state.effectIndex + step + allPresets().length) % allPresets().length;
      const chord = mods.shift ? { sticky: false, shiftChorded: true } : {};
      return { ...state, ...chord, effectIndex: next };
    }
    case "v":
    case "V":
      return { ...state, audience: state.audience === "everyone" ? "hidden" : "everyone" };
    case "r":
    case "R": {
      // Back to square by the shortest turn: the nearest full rotation of the shown angle.
      const turns = Math.round(state.rotationShown / 360);
      return { ...state, rotation: 0, rotationShown: turns === 0 ? 0 : turns * 360 };
    }
    default:
      return null;
  }
}

export function sizeOf(state: GhostState, gridSize: number): { width: number; height: number } {
  const base = naturalSize(state.mode, gridSize);
  const fitted = state.mode === "prop" ? state.heightOverride : null;
  return {
    width: Math.round(base.width * state.scale),
    height: fitted ?? Math.round(base.height * state.scale),
  };
}

/**
 * Snap a scene-space point to a square grid unless free placement is held.
 *
 * A size of 0 never snaps, rather than collapsing everything to the origin. Which grid
 * the scene has is `snapToScene`'s question: v14 never reports a size of 0.
 */
export function snap(point: { x: number; y: number }, gridSize: number, free: boolean) {
  if (free || !gridSize) return point;
  const half = gridSize / 2;
  return {
    x: Math.round(point.x / half) * half,
    y: Math.round(point.y / half) * half,
  };
}
