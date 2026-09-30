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
 *
 * It measures in the card's OWN face, which has to be loaded first. `document.fonts.ready`
 * only waits for loads already in flight, and nothing starts one for a face no element on
 * the page has used yet — a typewriter face chosen a moment ago measured in the fallback,
 * and "fit to content" fitted a different letter.
 */

import { HOUSE_STACK } from "../effects/typeface";

const PROBE_ID = "dp-measure";

/**
 * How long a face may take to arrive before the card is measured without it.
 *
 * Bounded because this runs inside `resolveCard`, which the DOM tier and fit-to-content
 * both wait on: a face that never loads must cost one mis-measure, not a stuck queue —
 * the lesson of A16's image decode.
 */
export const FONT_LOAD_TIMEOUT_MS = 1500;

/** Load the face the card asks for, or give up on it after the timeout. Never rejects. */
async function faceReady(card: HTMLElement): Promise<void> {
  const fonts: any = (document as any).fonts;
  if (!fonts) return;
  const family = card.style.getPropertyValue("--dp-font").trim() || HOUSE_STACK;
  const size = card.style.fontSize || "16px";

  let timer = 0;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
  });
  // `ready` as well, which is what this used to wait for alone: the body can name faces of
  // its own through the journal editor, and those load as the probe lays them out. A face
  // that fails to load is measured without, the same as one that times out.
  const loaded = Promise.resolve()
    .then(() =>
      Promise.all([
        typeof fonts.load === "function" ? fonts.load(`${size} ${family}`) : null,
        fonts.ready,
      ])
    )
    .catch(() => undefined);
  try {
    await Promise.race([loaded, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

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
    const card = (slot.firstElementChild as HTMLElement | null) ?? slot;
    // A face that has not arrived lays out at the fallback's metrics and mis-measures by
    // a line or two. Once loaded it is cached, so every later measure is instant.
    await faceReady(card);
    // The card is `block-size: 100%` of an auto-height parent, which is `auto`: the
    // sheet, the title and the body stack to their content height.
    const height = card.getBoundingClientRect().height;
    return height > 0 ? height : null;
  } finally {
    slot.remove();
  }
}
