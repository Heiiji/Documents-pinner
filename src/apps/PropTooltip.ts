/**
 * The hover tooltip a pin's `interaction.tooltip` field always promised.
 *
 * IMPURE, and tiny on purpose. The Pin Studio offered the field, the schema validated it
 * and the store persisted it, and NOTHING read it — while `PropHitLayer` fired a
 * `propHover` hook that nothing listened to, so a player hovering a pin got no feedback
 * at all beyond the cursor.
 *
 * Mounted in the scene-transformed overlay rather than in screen space, for the same
 * reason the reader is: the overlay root already carries the stage matrix, so the tooltip
 * is placed once at document coordinates and stays glued through any pan or zoom with no
 * per-frame write. It counter-scales through `--dp-ghost-zoom`-style sizing so it stays
 * legible at any zoom, exactly as the placement legend does.
 */

import { escapeHtml } from "../html";
import { readPin } from "../data/PinData";
import { scaleOf, stageMatrix } from "../canvas/transform";
import { mount, write } from "./OverlayRoot";

let element: HTMLElement | null = null;
let shownFor: string | null = null;

/** Show the tooltip for a hovered pin, or hide it. Wired to the `propHover` hook. */
export function setPropHover(doc: any, hovering: boolean): void {
  if (!hovering) {
    hidePropTooltip();
    return;
  }

  const pin = doc ? readPin(doc) : null;
  const text = pin?.interaction.tooltip?.trim();
  if (!text) {
    hidePropTooltip();
    return;
  }

  if (!element) {
    element = document.createElement("div");
    element.className = "dp-tooltip";
    element.setAttribute("role", "tooltip");
    element.setAttribute("aria-hidden", "true");
    mount(element);
  }

  if (shownFor !== doc.id) {
    element.innerHTML = escapeHtml(text);
    shownFor = doc.id;
  }

  const node = element;
  const zoom = 1 / (scaleOf(stageMatrix()) || 1);
  write(node, () => {
    // Centred above the pin, in scene coordinates.
    node.style.left = `${doc.x + doc.width / 2}px`;
    node.style.top = `${doc.y}px`;
    node.style.setProperty("--dp-tooltip-zoom", String(zoom));
    node.classList.add("dp-tooltip--in");
  });
}

export function hidePropTooltip(): void {
  shownFor = null;
  element?.remove();
  element = null;
}

/** For tests and diagnostics. */
export function tooltipText(): string | null {
  return element?.textContent ?? null;
}
