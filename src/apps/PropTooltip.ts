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

import { g } from "../fvtt";
import { t } from "../i18n";
import { escapeHtml } from "../html";
import * as api from "../api";
import { readPin } from "../data/PinData";
import { rotatedBounds, scaleOf, stageMatrix, tileRect } from "../canvas/transform";
import { mount, write } from "./OverlayRoot";
import type { DpPinFlags } from "../types/dp";

let element: HTMLElement | null = null;
let shownFor: string | null = null;
/** The markup last written, so a re-hover of the same pin writes nothing. */
let shownMarkup = "";

/**
 * What the tooltip says: a line of text and, for a player, how to open it.
 *
 * The text is the GM's own tooltip, else the pin's name wherever the map does not already
 * show it — every document pin is the same book icon, so without the name a player could
 * not tell one from the next, where a core map note shows its label. A prop that prints
 * its title on the paper says nothing twice.
 *
 * The hint is for players only. The pointer cursor says "click" and the default is a
 * double-click, so a player's single click did nothing and nothing said why.
 */
export function tooltipContent(pin: DpPinFlags, player: boolean): { text: string; hint: string } {
  const own = pin.interaction.tooltip?.trim() ?? "";
  const named = pin.mode === "pin" || !pin.display.showTitle;
  const text = own || (named ? api.labelFor(pin) : "");
  return { text, hint: player ? openHint(pin) : "" };
}

function openHint(pin: DpPinFlags): string {
  const open = pin.interaction.open;
  if (open === "never") return "";
  // A prop — or a pin set to read in place — reads on the map; a pin opens its sheet.
  const reads = pin.mode === "prop" || open === "readInPlace";
  // `readInPlace` is taken by a single tap in the hit layer, like `single`.
  const double = open === "double";
  return t(
    double
      ? reads
        ? "DP.tooltip.doubleRead"
        : "DP.tooltip.doubleOpen"
      : reads
        ? "DP.tooltip.clickRead"
        : "DP.tooltip.clickOpen"
  );
}

/** Show the tooltip for a hovered pin, or hide it. Wired to the `propHover` hook. */
export function setPropHover(doc: any, hovering: boolean): void {
  if (!hovering) {
    hidePropTooltip();
    return;
  }

  const pin = doc ? readPin(doc) : null;
  const player = g()?.user?.isGM !== true;
  const content = pin ? tooltipContent(pin, player) : { text: "", hint: "" };
  if (!content.text && !content.hint) {
    hidePropTooltip();
    return;
  }

  const node = tooltipNode();
  const markup =
    (content.text ? `<span class="dp-tooltip__text">${escapeHtml(content.text)}</span>` : "") +
    (content.hint ? `<span class="dp-tooltip__hint">${escapeHtml(content.hint)}</span>` : "");
  if (shownFor !== doc.id || shownMarkup !== markup) {
    node.innerHTML = markup;
    shownMarkup = markup;
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
  shownMarkup = "";
  return element;
}

/** Fade it out. The element stays, so a re-hover a moment later is a class flip. */
export function hidePropTooltip(): void {
  shownFor = null;
  const node = element;
  if (!node) return;
  write(node, () => node.classList.remove("dp-tooltip--in"));
}

/** For tests and diagnostics: the main line while shown, null while hidden. */
export function tooltipText(): string | null {
  if (!shownFor || !element) return null;
  return element.querySelector(".dp-tooltip__text")?.textContent ?? "";
}

/** For tests and diagnostics: the hint line while shown, null while hidden. */
export function tooltipHint(): string | null {
  if (!shownFor || !element) return null;
  return element.querySelector(".dp-tooltip__hint")?.textContent ?? "";
}
