/**
 * How tall a card wants to be.
 *
 * IMPURE. Mounts the card in a hidden probe at the width it will be drawn at and reads
 * its natural height — the one number both "fit to content" and the overflow fade need,
 * and one CSS cannot supply: a stylesheet cannot ask whether its content fit.
 *
 * One forced layout per call, and few calls: `resolveCard` keeps each answer in the card
 * cache (`card-cache.ts`), keyed by the body and what moves its lines — so a LOD rung, a
 * focus or an effects-level change measures nothing, and a content, width, type or face
 * change measures once. (This said "once per content change, never per LOD pass" while
 * the DOM tier's every rung change re-resolved, and so re-measured, every card.)
 *
 * The probe is deliberately NOT `content-visibility: auto`. That is what `.dp-prop`
 * carries so an off-screen card costs no layout, and it is exactly what makes a mounted
 * prop unreliable to measure. Here the card has to be laid out, just not painted.
 *
 * It measures in the card's OWN face, which has to be loaded first. `document.fonts.ready`
 * only waits for loads already in flight, and nothing starts one for a face no element on
 * the page has used yet — a typewriter face chosen a moment ago measured in the fallback,
 * and "fit to content" fitted a different letter. And with its pictures DECODED: an image
 * without a size of its own lays out at 0 px until it has, so a page of handout pictures
 * measured as a page of captions, and the fit cut the pictures off.
 */

import { HOUSE_STACK } from "../effects/typeface";

const PROBE_ID = "dp-measure";

/**
 * How long a card's face and pictures may take, together, before it is measured without
 * whatever has not arrived.
 *
 * ONE deadline for both, not one each: this runs inside `resolveCard`, which the DOM tier
 * and fit-to-content both wait on, and a face that never loads beside a picture that never
 * decodes must cost one mis-measure, not two timeouts in a row — the lesson of A16's image
 * decode. A measurement that hit it is reported, so it is never kept.
 */
export const MEASURE_DEADLINE_MS = 1500;

/** The height, and whether everything the card waited on arrived in time. */
export interface Measurement {
  /** In the card's own pixels, or `null` when it cannot be known. */
  height: number | null;
  /**
   * False when the deadline passed, or a picture failed to decode: the height is the best
   * there was, and the card cache must not keep it.
   */
  complete: boolean;
}

/** Load the face the card asks for. Resolves when it has, or has failed; never rejects. */
function faceLoaded(card: HTMLElement): Promise<unknown> {
  const fonts: any = (document as any).fonts;
  if (!fonts) return Promise.resolve();
  const family = card.style.getPropertyValue("--dp-font").trim() || HOUSE_STACK;
  const size = card.style.fontSize || "16px";
  // `ready` as well, which is what this used to wait for alone: the body can name faces of
  // its own through the journal editor, and those load as the probe lays them out. A face
  // that fails to load is measured without — and that is an answer, not a timeout.
  return Promise.resolve()
    .then(() =>
      Promise.all([
        typeof fonts.load === "function" ? fonts.load(`${size} ${family}`) : null,
        fonts.ready,
      ])
    )
    .catch(() => undefined);
}

/**
 * Decode a picture, made eager first: a journal's `<img loading="lazy">` in a probe parked
 * a hundred thousand pixels off screen would never start loading at all. Resolves to
 * whether it decoded; never rejects. An engine with no `decode` cannot be waited on, and
 * its pictures are measured as they are.
 */
function pictureDecoded(image: HTMLImageElement): Promise<boolean> {
  if (typeof image.decode !== "function") return Promise.resolve(true);
  return image.decode().then(
    () => true,
    () => false
  );
}

/** Wait for the face and the pictures, under one deadline. Whether all of it arrived. */
async function settled(card: HTMLElement, images: HTMLImageElement[]): Promise<boolean> {
  let timer = 0;
  let late = false;
  const deadline = new Promise<void>((resolve) => {
    timer = window.setTimeout(() => {
      late = true;
      resolve();
    }, MEASURE_DEADLINE_MS);
  });
  const arrived = Promise.all([faceLoaded(card), ...images.map(pictureDecoded)]).then(
    ([, ...decoded]) => decoded.every(Boolean)
  );
  try {
    const decodedAll = await Promise.race([arrived, deadline.then(() => false)]);
    return decodedAll && !late;
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
 * The height at which the whole card shows at `width`, and whether it is one to keep.
 *
 * `null`, never 0: an element that has not been laid out measures 0, and "unknown" and
 * "empty" must not be the same answer — one leaves the tile alone, the other would
 * collapse it. One child per call, so two resolves in flight cannot clobber each other.
 */
export async function measureCard(cardHtml: string, width: number): Promise<Measurement> {
  const root = probeRoot();
  if (!root) return { height: null, complete: false };

  const slot = document.createElement("div");
  slot.style.width = `${Math.max(1, width)}px`;
  slot.innerHTML = cardHtml;
  const images = [...slot.querySelectorAll("img")];
  for (const image of images) image.setAttribute("loading", "eager");
  root.appendChild(slot);

  try {
    const card = (slot.firstElementChild as HTMLElement | null) ?? slot;
    // A face that has not arrived lays out at the fallback's metrics and mis-measures by
    // a line or two; a picture that has not decoded lays out at nothing. Once loaded both
    // are cached by the browser, so every later measure is instant.
    const complete = await settled(card, images);
    // The card is `block-size: 100%` of an auto-height parent, which is `auto`: the
    // sheet, the title and the body stack to their content height.
    const height = card.getBoundingClientRect().height;
    return { height: height > 0 ? height : null, complete };
  } finally {
    slot.remove();
  }
}

/** `measureCard`'s height alone, for a caller that keeps nothing: the placement ghost. */
export async function measureCardHeight(cardHtml: string, width: number): Promise<number | null> {
  return (await measureCard(cardHtml, width)).height;
}
