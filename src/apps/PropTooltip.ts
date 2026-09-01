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
 *
 * ONE element for the session, shown and hidden by a class. It used to be created on
 * every show and removed on every hide, with the class added in the same frame as the
 * mount — so the fade-in never had an earlier style to run from and never played, and
 * there was no fade-out at all because there was no element left to fade.
 */

import { escapeHtml } from "../html";
import { readPin } from "../data/PinData";
import { rotatedBounds, scaleOf, stageMatrix, tileRect } from "../canvas/transform";
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

  const node = tooltipNode();
  if (shownFor !== doc.id) {
    node.innerHTML = escapeHtml(text);
    shownFor = doc.id;
  }

  const zoom = 1 / (scaleOf(stageMatrix()) || 1);
  // Above the prop as it actually lies: a rotated letter's top edge is not `doc.y`.
  const bounds = rotatedBounds(tileRect(doc));
  write(node, () => {
    // Centred above the pin, in scene coordinates.
    node.style.left = `${bounds.x + bounds.width / 2}px`;
    node.style.top = `${bounds.y}px`;
    node.style.setProperty("--dp-tooltip-zoom", String(zoom));
    node.classList.add("dp-tooltip--in");
  });
}

/** The element, created once and re-created only if the overlay it lived in is gone. */
function tooltipNode(): HTMLElement {
  if (element?.isConnected) return element;
  element = document.createElement("div");
  element.className = "dp-tooltip";
  element.setAttribute("role", "tooltip");
  element.setAttribute("aria-hidden", "true");
  mount(element);
  return element;
}

/** Fade it out. The element stays, so a re-hover a moment later is a class flip. */
export function hidePropTooltip(): void {
  shownFor = null;
  const node = element;
  if (!node) return;
  write(node, () => node.classList.remove("dp-tooltip--in"));
}

/** For tests and diagnostics: the text while shown, null while hidden. */
export function tooltipText(): string | null {
  return shownFor && element ? element.textContent : null;
}
