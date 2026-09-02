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
import { transparentForm } from "../effects/preset-css";

/** The paper stocks a pin can be printed on. Ids are stored in `display.paper`. */
export const PAPERS: Record<string, { base: string; ink: string; edge: string; bloom?: string }> = {
  parchment: { base: "#e8dcc0", ink: "#3a2410", edge: "#c9b58d" },
  vellum: { base: "#f2ead8", ink: "#2f2a21", edge: "#d8cdb2" },
  paper: { base: "#f7f5f0", ink: "#22222a", edge: "#ddd9d0" },
  linen: { base: "#e4e0d4", ink: "#2c2f2a", edge: "#c6c1b0" },
  slate: { base: "#2a2d33", ink: "#e6e3da", edge: "#454952" },
  bloodied: { base: "#ddccb4", ink: "#3a1810", edge: "#a8846b" },
  /**
   * Not paper: light.
   *
   * The base is TRANSLUCENT, and that alpha is the whole mechanism. A card cannot blend
   * against the WebGL canvas — the overlay is a different stacking context — so
   * "projected onto the map" has to be faked with alpha, which composites correctly on
   * every tier: over `#board` on the DOM path, into an RGBA texture in the rasteriser,
   * and through `globalAlpha` in the Canvas2D baker. `bloom` is the halo the ink carries,
   * which is what makes the type read as emitted rather than printed.
   */
  projection: { base: "#0b1a20d9", ink: "#dff6ff", edge: "#5fd8ec", bloom: "#7fe8ff66" },
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
  /**
   * Type size and padding in CARD pixels, from `cardMetrics`.
   *
   * Card pixels, not screen pixels: a prop is rasterised once at a chosen resolution
   * and then scaled, so type sized in screen units would grow and shrink relative to
   * the paper as the GM zoomed, which is the one thing a physical object must never do.
   * The card carries NO width or height of its own — it fills whatever box it is put
   * in, which is what lets a resized prop re-flow without being re-resolved.
   */
  fontPx: number;
  padPx: number;
  /** Effect id, exposed as a data attribute for the CSS renditions to key off. */
  effectId: string;
  /** The effect's custom properties, from `EffectRegistry.dressing`. */
  effectStyle?: string;
  /** The effect's data attributes, which the stylesheet selects on. */
  effectAttrs?: Record<string, string>;
  /** Placeholder mode: the source is gone, so say so instead of drawing a blank sheet. */
  missing?: boolean;
  /** The content does not fit the box, so the stylesheet fades its tail. */
  overflow?: boolean;
}

export function cardHtml(options: CardOptions): string {
  const paper = paperOf(options.paper);

  const style = [
    `--dp-paper-base:${paper.base}`,
    // The same base at zero alpha, for every gradient that fades OUT of the stock. A
    // gradient to the keyword `transparent` is rgb(0 0 0 / 0), which engines are free to
    // premultiply differently — a parchment fade picking up a grey cast — and which is
    // simply wrong for a translucent stock.
    `--dp-paper-base-0:${transparentForm(paper.base)}`,
    `--dp-paper-ink:${paper.ink}`,
    `--dp-paper-edge:${paper.edge}`,
    `--dp-paper-bloom:${paper.bloom ?? "transparent"}`,
    `--dp-card-pad:${options.padPx}px`,
    `font-size:${options.fontPx}px`,
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
    `<div class="dp-card" data-dp-fx="${escapeAttr(options.effectId)}"` +
    // The stock as an attribute, so a stock can style its own ink — the projection's
    // bloom and its technical caps are a property of the PAPER, not of any preset.
    ` data-dp-paper="${escapeAttr(options.paper)}"${attrs}` +
    `${options.missing ? ' data-dp-missing="true"' : ""}` +
    `${options.overflow ? ' data-dp-overflow="true"' : ""} style="${escapeAttr(style)}">` +
    `<div class="dp-card__sheet">${title}${body}</div>` +
    // Emitted only when the preset asks for it, so a parchment prop's markup is byte-
    // identical to what it was and the ten presets without an overlay pay nothing.
    (options.effectAttrs?.["data-dp-hud"] === "true"
      ? `<div class="dp-card__hud" aria-hidden="true"><i class="dp-card__hud-sweep"></i></div>`
      : "") +
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
 *
 * The root div is sized too, and that is the third load-bearing size. The card is
 * `100%` of its box, and a percentage height needs a definite containing block; inside
 * a foreignObject the root has none unless it is given one, and a card with no definite
 * height collapses to a transparent texture, as silently as the other two.
 *
 * The stylesheet is wrapped in CDATA, and that is not a nicety. This document is loaded
 * through `Blob -> img.src`, which parses it with the **XML** parser, and XML gives
 * `<style>` no implicit CDATA the way HTML does. A single bare `&` — which is every
 * line of native CSS nesting in `card.css` — makes the whole document ill-formed, the
 * decode rejects it, and every prop on every client silently fails to draw. CDATA is
 * used rather than de-nesting the stylesheet because it also covers whatever CSS is
 * written next year by someone who has never read this comment.
 */
export function svgDocument(card: string, css: string, width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="dp-card-root" ` +
    `style="width:${width}px;height:${height}px">` +
    `<style>${cdata(css)}</style>${card}` +
    `</div></foreignObject></svg>`
  );
}

/**
 * Wrap text in a CDATA section it cannot escape from.
 *
 * A literal `]]>` inside the text would end the section early and hand the rest of the
 * stylesheet to the XML parser as markup, so the one sequence that matters is split
 * across a section boundary rather than removed — the CSS still says what it said.
 */
function cdata(text: string): string {
  return `<![CDATA[${String(text ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
