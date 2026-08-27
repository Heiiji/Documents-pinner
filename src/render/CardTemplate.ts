/**
 * The card: the markup a prop actually is.
 *
 * PURE. Takes already-enriched, already-scrubbed HTML and wraps it in a self-contained
 * card. It is the SAME markup in both rendering tiers — rasterised into a texture for
 * the canvas, and mounted live for the focus reader — because a reader that did not
 * match the prop it zoomed out of would break the illusion the whole module is for.
 *
 * The card is deliberately theme-INDEPENDENT. A prop is a physical object lying on a
 * map, not a piece of UI: a letter is parchment whether Foundry is in light or dark
 * mode, and it has to look the same in a rasterised texture — where the page's CSS
 * variables do not exist at all — as it does in the DOM. Every colour therefore comes
 * from the card's own `--dp-paper-*` variables, set per pin, with literal fallbacks
 * that resolve correctly inside an SVG `foreignObject`.
 */

import { escapeAttr, escapeHtml } from "../html";

/** The paper stocks a pin can be printed on. Ids are stored in `display.paper`. */
export const PAPERS: Record<string, { base: string; ink: string; edge: string }> = {
  parchment: { base: "#e8dcc0", ink: "#3a2410", edge: "#c9b58d" },
  vellum: { base: "#f2ead8", ink: "#2f2a21", edge: "#d8cdb2" },
  paper: { base: "#f7f5f0", ink: "#22222a", edge: "#ddd9d0" },
  linen: { base: "#e4e0d4", ink: "#2c2f2a", edge: "#c6c1b0" },
  slate: { base: "#2a2d33", ink: "#e6e3da", edge: "#454952" },
  bloodied: { base: "#ddccb4", ink: "#3a1810", edge: "#a8846b" },
};

export const DEFAULT_PAPER = "parchment";

export function paperOf(id: string) {
  return PAPERS[id] ?? PAPERS[DEFAULT_PAPER];
}

export interface CardOptions {
  title: string;
  /** Already enriched and scrubbed. Never raw user input. */
  bodyHtml: string;
  showTitle: boolean;
  paper: string;
  /** Fraction of the short edge, 0–0.5. */
  padding: number;
  /** The card's pixel size, so type scales with the prop rather than with the screen. */
  width: number;
  height: number;
  /** Effect id, exposed as a data attribute for the CSS renditions to key off. */
  effectId: string;
  /** The effect's custom properties, from `EffectRegistry.dressing`. */
  effectStyle?: string;
  /** The effect's data attributes, which the stylesheet selects on. */
  effectAttrs?: Record<string, string>;
  /** Placeholder mode: the source is gone, so say so instead of drawing a blank sheet. */
  missing?: boolean;
}

/**
 * Type size, derived from the card's own short edge.
 *
 * Font size in card pixels, not screen pixels: a prop is rasterised once at a chosen
 * resolution and then scaled, so type sized in screen units would grow and shrink
 * relative to the paper as the GM zoomed, which is the one thing a physical object
 * must never do.
 */
export function baseFontSize(width: number, height: number): number {
  const short = Math.max(1, Math.min(width, height));
  // Deliberately not rounded to whole pixels: rounding makes the size only ALMOST
  // proportional to the card, and "almost" is what makes type visibly drift as a prop
  // is resized. Fractional font sizes are exact in both CSS and an SVG foreignObject.
  // ~26 lines of body text down the short edge reads as a letter, not a poster.
  return Math.max(8, short / 26);
}

export function cardHtml(options: CardOptions): string {
  const paper = paperOf(options.paper);
  const pad = Math.round(Math.min(options.width, options.height) * options.padding);
  const font = baseFontSize(options.width, options.height);

  const style = [
    `--dp-paper-base:${paper.base}`,
    `--dp-paper-ink:${paper.ink}`,
    `--dp-paper-edge:${paper.edge}`,
    `--dp-card-pad:${pad}px`,
    `font-size:${font}px`,
    `width:${options.width}px`,
    `height:${options.height}px`,
    // The effect's own properties last, so a preset can override a paper default
    // rather than the other way round.
    options.effectStyle ?? "",
  ]
    .filter(Boolean)
    .join(";");

  const title =
    options.showTitle && options.title
      ? `<h1 class="dp-card__title">${escapeHtml(options.title)}</h1>`
      : "";

  const body = options.missing
    ? `<p class="dp-card__missing">${escapeHtml(options.title)}</p>`
    : `<div class="dp-card__body">${options.bodyHtml}</div>`;

  const attrs = Object.entries(options.effectAttrs ?? {})
    .map(([key, value]) => ` ${escapeAttr(key)}="${escapeAttr(value)}"`)
    .join("");

  return (
    `<div class="dp-card" data-dp-fx="${escapeAttr(options.effectId)}"${attrs}` +
    `${options.missing ? ' data-dp-missing="true"' : ""} style="${escapeAttr(style)}">` +
    `<div class="dp-card__sheet">${title}${body}</div>` +
    `</div>`
  );
}

/**
 * The card wrapped in an SVG `foreignObject`, ready to rasterise.
 *
 * Explicit `width` and `height` on BOTH the `<svg>` and the `<foreignObject>`: Chrome
 * renders nothing at all without them, and the failure is silent — a fully transparent
 * texture that looks exactly like a prop that has not loaded yet.
 *
 * The XHTML namespace on the inner div is equally load-bearing: without it the content
 * is parsed as SVG, where a `<div>` means nothing and draws nothing.
 */
export function svgDocument(card: string, css: string, width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="dp-card-root">` +
    `<style>${css}</style>${card}` +
    `</div></foreignObject></svg>`
  );
}
