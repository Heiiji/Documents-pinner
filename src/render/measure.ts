/**
 * How tall a card wants to be.
 *
 * IMPURE. Mounts the card in a hidden probe at the width it will be drawn at and reads
 * its natural height — the one number both "fit to content" and the overflow fade need,
 * and one CSS cannot supply: a stylesheet cannot ask whether its content fit.
 *
 * One forced layout per call, and the call sites keep it off the frame path: it runs
 * after the awaits inside `resolveCard`, once per content change, never per LOD pass.
 *
 * The probe is deliberately NOT `content-visibility: auto`. That is what `.dp-prop`
 * carries so an off-screen card costs no layout, and it is exactly what makes a mounted
 * prop unreliable to measure. Here the card has to be laid out, just not painted.
 */

const PROBE_ID = "dp-measure";

let probe: HTMLElement | null = null;

function probeRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (probe?.isConnected) return probe;

  probe = document.getElementById(PROBE_ID) ?? document.createElement("div");
  probe.id = PROBE_ID;
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;inset-block-start:0;inset-inline-start:-100000px;" +
    "visibility:hidden;pointer-events:none;contain:layout style;";
  document.body.appendChild(probe);
  return probe;
}

/**
 * The height at which the whole card shows at `width`, in the card's own pixels, or
 * `null` when it cannot be known.
 *
 * `null`, never 0: an element that has not been laid out measures 0, and "unknown" and
 * "empty" must not be the same answer — one leaves the tile alone, the other would
 * collapse it. One child per call, so two resolves in flight cannot clobber each other.
 */
export async function measureCardHeight(cardHtml: string, width: number): Promise<number | null> {
  const root = probeRoot();
  if (!root) return null;

  const slot = document.createElement("div");
  slot.style.width = `${Math.max(1, width)}px`;
  slot.innerHTML = cardHtml;
  root.appendChild(slot);

  try {
    // A late-loading face lays out at the fallback's metrics and mis-measures by a
    // line or two; the fonts are inlined and cached, so this is normally instant.
    await document.fonts?.ready;
    // The card is `block-size: 100%` of an auto-height parent, which is `auto`: the
    // sheet, the title and the body stack to their content height.
    const card = (slot.firstElementChild as HTMLElement | null) ?? slot;
    const height = card.getBoundingClientRect().height;
    return height > 0 ? height : null;
  } finally {
    slot.remove();
  }
}
