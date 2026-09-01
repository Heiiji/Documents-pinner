/**
 * The motion table.
 *
 * PURE. One set of durations and curves for the whole module, mirrored as custom
 * properties in `styles/theme.css` and kept equal by a test, so the canvas tier — which
 * animates through `CanvasAnimation` and cannot read a stylesheet — and the DOM tier
 * arrive on the same clock. A reveal, a peek or a fade that took a different time on
 * the two tiers would make one gesture two events.
 *
 * Three rules the numbers serve. Motion is continuity of an object, never decoration:
 * a prop only ever changes opacity, blur or tint. Exits exist and are shorter than
 * entries. Nothing inside a rasterised card moves, so nothing here is ever needed
 * inside `card.css`.
 */

export const MOTION = {
  /** Hover, pressed, peek, the token fade, a tooltip arriving, a palette opening. */
  state: 120,
  /** Something arriving that is not a reveal: a draw-in, a remount, the ghost. */
  enter: 200,
  /** Anything leaving. Seventy per cent of an entry, always. */
  exit: 140,
  /** The reveal and the reader; a preset's own `reveal.durationMs` overrides it. */
  reveal: 400,
  /** The stamp pulse and the reader's settle. */
  emphasis: 320,
} as const;

export const EASE = {
  /** Every entry and state change. */
  out: "cubic-bezier(0.2, 0, 0, 1)",
  /** Every exit. */
  in: "cubic-bezier(0.4, 0, 1, 1)",
  /** `materialise`: the bezier of `easeInOutCosine`, so the DOM curve IS the canvas curve. */
  resolve: "cubic-bezier(0.37, 0, 0.63, 1)",
} as const;

/** The CSS timing function a preset's reveal animation maps to. */
export function curveFor(animation: string | undefined): string {
  return animation === "materialise" ? EASE.resolve : "linear";
}
