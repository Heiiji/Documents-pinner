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
import { curveFor } from "../motion";
import { escapeAttr } from "../html";
import { cardMetrics } from "../data/pin-schema";
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
  /** A PDF page is drawn at a size, so its card depends on the geometry; HTML does not. */
  pdf: boolean;
  /** This pass is the one where the prop became visible to this client. */
  revealing: boolean;
  /** The preset's reveal, so the card arrives the way the canvas tier's mesh would. */
  reveal: { animation: string; durationMs: number };
}

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

interface DomProp {
  element: HTMLElement;
  /** The content key the element currently shows, so a re-sync is free. */
  key: string;
  /** Bumped on every resolve, so a slow one cannot overwrite a newer card. */
  generation: number;
  /** The geometry last written, so a LOD pass after a pan writes nothing. */
  placedAt: Placed | null;
  /** The opacity last written, for the same reason. */
  alpha: number | null;
  /** The height at which the whole card fits, from the resolver; null when unknown. */
  naturalHeight: number | null;
}

const props = new Map<string, DomProp>();

/**
 * What the card's CONTENT depends on.
 *
 * Geometry is deliberately absent for HTML: the card fills its box and CSS re-lays it
 * out, so a resize costs no resolve. That used to be a claim rather than a fact — the
 * card carried its own width, height and font size as inline pixels, and nothing ever
 * re-laid it out — which is why a resized prop sat clipped or short inside its new box
 * until an LOD boundary happened to be crossed.
 *
 * What IS in the key is what the card's pixels are drawn from: the type size and the
 * pad. For a pin whose metrics are stored those never follow the tile; for one that
 * predates stored metrics they derive from the short edge, so a legacy prop still
 * re-resolves when that changes — exactly as its look demands. A PDF page is rendered
 * at a size, so its geometry is in outright.
 */
function contentKeyOf(entry: DomPropEntry): string {
  const { pin, doc } = entry;
  const size = { width: doc.width, height: doc.height };
  const { fontPx, padPx } = cardMetrics(pin.display, size);
  return [
    pin.source.uuid ?? pin.source.src ?? entry.id,
    pin.mode,
    pin.effect.id,
    pin.effect.intensity,
    pin.effect.seed,
    pin.display.paper,
    fontPx,
    padPx,
    pin.display.showTitle ? 1 : 0,
    pin.display.label,
    entry.pdf ? `${size.width}x${size.height}` : "",
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
    // The focused one STAYS mounted, hidden under the reader: unmounting it meant that
    // closing the reader re-resolved the card and replayed its arrival under a reader
    // that had already vanished. A card at opacity 0 costs a layer, which is what the
    // reader costs anyway.
    if (entry.tier === "L0") continue;
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
    prop = {
      element,
      key: "",
      generation: 0,
      placedAt: null,
      alpha: null,
      naturalHeight: null,
    };
    props.set(entry.id, prop);
    mount(element);
    mounted = true;
  }

  prop.element.dataset.dpFx = escapeAttr(entry.pin.effect.id);
  if (entry.focused) prop.element.dataset.dpFocused = "true";
  else delete prop.element.dataset.dpFocused;
  placeGeometry(prop, entry.doc);
  applyAlpha(prop, entry.alpha);
  if (mounted) arrive(prop.element, entry);

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
      current.naturalHeight = card.naturalHeight ?? null;
      applyOverflow(current);
    })
    .catch((error) => log.warn(`DOM prop failed to resolve:`, error));
}

/**
 * Position in SCENE space, exactly as the reader does.
 *
 * The overlay root already carries the stage matrix, so these five values are written
 * once per geometry CHANGE and never per frame — dirty-checked, because a LOD pass runs
 * after every pan and five style writes per prop per pass is what this saves.
 */
function placeGeometry(prop: DomProp, doc: any): void {
  const next: Placed = {
    x: doc.x,
    y: doc.y,
    width: doc.width,
    height: doc.height,
    rotation: doc.rotation ?? 0,
  };
  const last = prop.placedAt;
  if (
    last &&
    last.x === next.x &&
    last.y === next.y &&
    last.width === next.width &&
    last.height === next.height &&
    last.rotation === next.rotation
  ) {
    return;
  }
  prop.placedAt = next;

  const element = prop.element;
  write(element, () => {
    element.style.left = `${next.x}px`;
    element.style.top = `${next.y}px`;
    element.style.width = `${next.width}px`;
    element.style.height = `${next.height}px`;
    element.style.transform = `rotate(${next.rotation}deg)`;
  });
  applyOverflow(prop);
}

/**
 * Mark the card when its content does not fit the box, and unmark it when it does.
 *
 * The resolver marks the card for the size it was resolved at; a resize changes the box
 * without a resolve, so the mark has to follow the geometry here. Skipped entirely while
 * the natural height is unknown — a card that cannot be measured is never told it
 * overflows.
 */
function applyOverflow(prop: DomProp): void {
  const height = prop.placedAt?.height;
  if (prop.naturalHeight === null || height === undefined) return;
  const overflow = prop.naturalHeight > height + 1;

  const card = prop.element.querySelector<HTMLElement>(".dp-card");
  if (!card) return;
  const marked = card.dataset.dpOverflow === "true";
  if (marked === overflow) return;
  write(card, () => {
    if (overflow) card.dataset.dpOverflow = "true";
    else delete card.dataset.dpOverflow;
  });
}

function applyAlpha(prop: DomProp, alpha: number): void {
  if (prop.alpha === alpha) return;
  prop.alpha = alpha;
  const element = prop.element;
  write(element, () => {
    element.style.opacity = String(alpha);
  });
}

/**
 * The arrival: a reveal at the preset's own duration and curve, or a plain fade at the
 * enter duration for a card that is merely being mounted again — panning back over a
 * culled prop, say. A prop appearing instantly reads as a rendering glitch; the same
 * prop resolving reads as something being revealed, which is the moment the module
 * exists for, and it used to play the same 260 ms unblur on EVERY mount whatever the
 * preset said. The class is added on the frame AFTER the element is mounted so the
 * animation has a frame to start from; the stylesheet drops it under reduced motion.
 */
function arrive(element: HTMLElement, entry: DomPropEntry): void {
  const animation = entry.revealing ? entry.reveal.animation : "fade";
  element.dataset.dpReveal = animation;
  if (entry.revealing) {
    element.style.setProperty("--dp-reveal-dur", `${entry.reveal.durationMs}ms`);
    element.style.setProperty("--dp-reveal-ease", curveFor(animation));
  } else {
    element.style.removeProperty("--dp-reveal-dur");
    element.style.removeProperty("--dp-reveal-ease");
  }
  write(element, () => {
    requestAnimationFrame(() => element.classList.add("dp-prop--in"));
  });
}

/**
 * Re-place a mounted card at the document's CURRENT geometry, with no resolve.
 *
 * Core's resize handles mutate the document in memory on every tick of the drag and
 * commit on release; the LOD pass only hears the commit. This is what lets the card
 * follow the handles live, and it is dirty-checked, so a refresh that moved nothing
 * costs a few compares.
 */
export function followDomProp(doc: any): void {
  const prop = props.get(doc?.id);
  if (!prop) return;
  placeGeometry(prop, doc);
}

/** The token fade and the peek, pushed to a card that has no mesh to carry them. */
export function setDomPropAlpha(id: string, alpha: number): void {
  const prop = props.get(id);
  if (!prop) return;
  applyAlpha(prop, alpha);
}

export function clearDomTier(): void {
  for (const prop of props.values()) prop.element.remove();
  props.clear();
}

/** For the Pinboard's diagnostics and for tests. */
export function domPropCount(): number {
  return props.size;
}
