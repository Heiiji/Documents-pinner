/**
 * The level-of-detail ladder.
 *
 * PURE: no Foundry globals, no PIXI. Given how big a prop currently looks and what the
 * user is doing with it, decide how much work it deserves. Every threshold is a
 * constant in `const.ts` so the ladder can be reasoned about in one place.
 *
 * The ladder exists because the cost of a prop is dominated by its TEXTURE, and a prop
 * the size of a postage stamp on screen costs exactly as much as one filling the
 * viewport unless something says otherwise. Fifty props at full resolution is more
 * VRAM than most tables have; fifty props at their apparent size is nothing.
 *
 * Two properties matter more than the exact numbers:
 *
 * - **Tiers are discrete and snap to powers of two.** A continuous mapping from zoom to
 *   resolution would reallocate a texture every few pixels of a wheel scroll.
 * - **Degrading is uniform.** When the perf guard fires it drops every prop one rung
 *   rather than picking victims, because a scene where half the props are sharp and
 *   half are mush looks broken, whereas one where everything is slightly softer looks
 *   deliberate.
 */

import { LOD, RES_TIERS } from "../const";

export type LodTier = "L0" | "L1" | "L2a" | "L2b" | "L3";

/** Rungs in order, so demotion and promotion are one array step. */
export const TIER_ORDER: LodTier[] = ["L0", "L1", "L2a", "L2b", "L3"];

export interface LodInput {
  /** On-screen width in CSS pixels. */
  apparentWidth: number;
  /** Whether the prop's bounds intersect the viewport at all. */
  onScreen: boolean;
  /** Whether this user is in the audience and the anchor is not hidden. */
  visible: boolean;
  /** Whether this prop is the one the user has focused. */
  focused: boolean;
  /** Whether this user could actually read the source, gating the reader tier. */
  readable: boolean;
}

/**
 * Which rung a prop belongs on.
 *
 * `visible` and `onScreen` are checked first and together: a prop the user is not in
 * the audience for costs nothing at all, and neither does one behind them. The reader
 * tier additionally requires the prop to be big enough to actually read, because
 * fading in a live HTML card over a thumbnail helps nobody.
 */
export function lodFor(input: LodInput): LodTier {
  if (!input.visible || !input.onScreen) return "L0";
  if (input.focused && input.readable && input.apparentWidth >= LOD.READER) return "L3";
  if (input.apparentWidth < LOD.SILHOUETTE) return "L1";
  if (input.apparentWidth < LOD.COARSE) return "L2a";
  return "L2b";
}

/**
 * The texture long edge a tier wants, in pixels, snapped to a tier.
 *
 * `L3` renders live HTML over an unchanged texture, so it asks for the same pixels as
 * `L2b` — focusing a prop must not also reallocate it.
 */
export function textureLongEdge(
  tier: LodTier,
  apparentLongEdge: number,
  resolution: number
): number {
  if (tier === "L0" || tier === "L1") return 0;
  if (tier === "L2a") return 512;

  const wanted = apparentLongEdge * Math.max(1, resolution);
  return snapToTier(wanted);
}

/** The smallest tier that covers `pixels`, capped at the largest we ever allocate. */
export function snapToTier(pixels: number): number {
  for (const tier of RES_TIERS) if (pixels <= tier) return tier;
  return RES_TIERS[RES_TIERS.length - 1];
}

/**
 * How much of the effect to run.
 *
 * Half intensity at the coarse tier rather than none: an effect that switched off at a
 * distance would make props visibly change identity as a GM zoomed out, which reads as
 * a bug rather than as an optimisation.
 */
export function effectScale(tier: LodTier): number {
  switch (tier) {
    case "L2a":
      return 0.5;
    case "L2b":
    case "L3":
      return 1;
    default:
      return 0;
  }
}

/** The most shader taps a tier may spend. Baked effects are unaffected. */
export function tapBudget(tier: LodTier): number {
  return tier === "L2a" ? 3 : tier === "L2b" || tier === "L3" ? 16 : 0;
}

export function demote(tier: LodTier): LodTier {
  const index = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, index - 1)];
}

export function isHeavier(a: LodTier, b: LodTier): boolean {
  return TIER_ORDER.indexOf(a) > TIER_ORDER.indexOf(b);
}

// ---------------------------------------------------------------------------
// The performance guard
// ---------------------------------------------------------------------------

export interface PerfState {
  /** Consecutive frames over budget. Reset by a single frame under it. */
  over: number;
  /** Whether the module has already degraded and told the user. */
  degraded: boolean;
}

export const PERF_BUDGET_MS = 4;
export const PERF_FRAMES = 60;

export function initialPerf(): PerfState {
  return { over: 0, degraded: false };
}

/**
 * Advance the guard by one frame.
 *
 * CONSECUTIVE frames rather than an average: one expensive frame while a texture
 * uploads is normal and must not trip anything, whereas a solid second of them is a
 * scene that will not hold its frame rate. A single good frame resets the count, so
 * the guard measures sustained cost rather than accumulating a grudge.
 */
export function stepPerf(
  state: PerfState,
  frameMs: number,
  budgetMs = PERF_BUDGET_MS,
  frames = PERF_FRAMES
): { state: PerfState; degrade: boolean } {
  if (frameMs <= budgetMs) return { state: { ...state, over: 0 }, degrade: false };

  const over = state.over + 1;
  if (over < frames || state.degraded) return { state: { ...state, over }, degrade: false };

  // Degrade once and say so once. Repeating either would turn a slow scene into a
  // stream of notifications, which is worse than the slow scene.
  return { state: { over: 0, degraded: true }, degrade: true };
}

/**
 * Order in which props should be given work.
 *
 * Squared distance from the viewport centre: no square root, because this runs over
 * every prop on every recompute and the ordering is identical either way. What the GM
 * is looking at gets its texture first, which is the only ordering anyone can perceive.
 */
export function priorityOf(
  bounds: { x: number; y: number; width: number; height: number },
  centre: { x: number; y: number }
): number {
  const dx = bounds.x + bounds.width / 2 - centre.x;
  const dy = bounds.y + bounds.height / 2 - centre.y;
  return dx * dx + dy * dy;
}
