/**
 * Props drawn as DOM, for the clients that cannot draw them into the scene.
 *
 * IMPURE. This is the other half of `A7`: the setting offered a "DOM (compatibility)"
 * choice and the WebKit probe fell back to it, and there was nothing on the other side
 * — every Safari user, and everyone who picked the documented compatibility option, got
 * invisible props and a `console.warn`. `OverlayRoot.mount` had exactly two callers,
 * neither of them a prop.
 *
 * What this tier gives up is stated plainly in the README and in DESIGN §6: a card
 * mounted over the canvas is **not lit, not fogged and not occluded**, because those are
 * properties of being drawn *into* `canvas.primary` rather than over it. What it keeps
 * is everything else — position, size, rotation, the effect, the audience, the peek and
 * the token fade — so a prop is a prop on every browser, just a flatter one.
 *
 * Three rules, each of which is the reason a naive version of this file would be worse
 * than nothing:
 *
 * 1. **Pointer-transparent.** `PropHitLayer` already owns player interaction and works
 *    the same whichever tier drew the pixels. A card that captured its own clicks would
 *    give DOM-mode clients a second, subtly different interaction path.
 * 2. **Positioned in SCENE space.** The overlay root already carries the stage matrix,
 *    so a card is placed once at document coordinates and stays glued through any pan
 *    or zoom with no per-frame write at all.
 * 3. **One resolve per content key.** Card resolution enriches a document; doing it per
 *    LOD pass would enrich fifty documents after every pan.
 */

import { logger } from "../log";
import { escapeAttr } from "../html";
import { resolveCard } from "../render/ContentResolver";
import { currentLevel } from "../effects/level";
import { mount, write } from "../apps/OverlayRoot";
import type { LodTier } from "./lod";
import type { DpPinFlags } from "../types/dp";

const log = logger("props.dom");

export interface DomPropEntry {
  id: string;
  /** The anchor TileDocument. */
  doc: any;
  pin: DpPinFlags;
  tier: LodTier;
  /** The reader is already showing this one; a second copy under it helps nobody. */
  focused: boolean;
  alpha: number;
}

interface DomProp {
  element: HTMLElement;
  /** The content key the element currently shows, so a re-sync is free. */
  key: string;
  /** Bumped on every resolve, so a slow one cannot overwrite a newer card. */
  generation: number;
}

const props = new Map<string, DomProp>();

/**
 * What the card's CONTENT depends on. Deliberately not the geometry: a resized prop is
 * re-laid-out by CSS, which is the one thing the DOM tier gets for free.
 */
function contentKeyOf(entry: DomPropEntry): string {
  const { pin } = entry;
  return [
    pin.source.uuid ?? pin.source.src ?? entry.id,
    pin.mode,
    pin.effect.id,
    pin.effect.intensity,
    pin.effect.seed,
    pin.display.paper,
    pin.display.padding,
    pin.display.showTitle ? 1 : 0,
    pin.display.label,
    entry.tier,
    currentLevel(),
  ].join("|");
}

/**
 * Bring the mounted cards in line with what the LOD pass decided.
 *
 * A full reconcile rather than a diff the caller maintains: the entry list is tens of
 * items, and a caller-side diff would be one more place for the card and the placeable
 * to drift apart — which on this tier is a prop left behind on a scene it was deleted
 * from.
 */
export function syncDomTier(entries: readonly DomPropEntry[]): void {
  const live = new Set<string>();

  for (const entry of entries) {
    // Only L0 is skipped. The canvas tier draws a silhouette at L1 from the tile's own
    // texture, but on this path the mesh is held at alpha 0 — the card IS the prop — so
    // skipping L1 here would make a prop vanish as the GM zoomed out rather than shrink.
    // The focused one is the reader's job; a second copy under it helps nobody.
    if (entry.tier === "L0" || entry.focused) continue;
    live.add(entry.id);
    upsert(entry);
  }

  for (const [id, prop] of [...props]) {
    if (live.has(id)) continue;
    prop.element.remove();
    props.delete(id);
  }
}

function upsert(entry: DomPropEntry): void {
  let prop = props.get(entry.id);

  let mounted = false;
  if (!prop) {
    const element = document.createElement("div");
    element.className = "dp-prop";
    element.setAttribute("aria-hidden", "true");
    element.dataset.dpId = entry.id;
    prop = { element, key: "", generation: 0 };
    props.set(entry.id, prop);
    mount(element);
    mounted = true;
  }

  prop.element.dataset.dpFx = escapeAttr(entry.pin.effect.id);
  place(prop.element, entry, mounted);

  const key = contentKeyOf(entry);
  if (prop.key === key) return;
  prop.key = key;

  const generation = ++prop.generation;
  const size = { width: entry.doc.width, height: entry.doc.height };
  void resolveCard(entry.pin, size, { tier: entry.tier, baked: false })
    .then((card) => {
      const current = props.get(entry.id);
      // The scene may have changed, or a newer resolve may already have landed.
      if (!current || current.generation !== generation) return;
      current.element.innerHTML = card.html;
    })
    .catch((error) => log.warn(`DOM prop failed to resolve:`, error));
}

/**
 * Position in SCENE space, exactly as the reader does.
 *
 * The overlay root carries the stage matrix, so these five values are written once per
 * geometry change and never per frame.
 */
function place(element: HTMLElement, entry: DomPropEntry, revealing: boolean): void {
  const doc = entry.doc;
  write(element, () => {
    element.style.left = `${doc.x}px`;
    element.style.top = `${doc.y}px`;
    element.style.width = `${doc.width}px`;
    element.style.height = `${doc.height}px`;
    element.style.transform = `rotate(${doc.rotation ?? 0}deg)`;
    element.style.opacity = String(entry.alpha);
    // The reveal. A prop appearing instantly reads as a rendering glitch; the same prop
    // fading up reads as something being revealed, which is the moment the module exists
    // for — and the canvas tier has always had it. The class is added on the frame AFTER
    // the element is mounted so the transition has an initial state to run from; the
    // stylesheet drops it entirely under `prefers-reduced-motion`.
    if (revealing) requestAnimationFrame(() => element.classList.add("dp-prop--in"));
  });
}

/** The token fade and the peek, pushed to a card that has no mesh to carry them. */
export function setDomPropAlpha(id: string, alpha: number): void {
  const prop = props.get(id);
  if (!prop) return;
  write(prop.element, () => {
    prop.element.style.opacity = String(alpha);
  });
}

export function clearDomTier(): void {
  for (const prop of props.values()) prop.element.remove();
  props.clear();
}

/** For the Pinboard's diagnostics and for tests. */
export function domPropCount(): number {
  return props.size;
}
