/**
 * Props drawn as DOM, for the clients that cannot draw them into the scene.
 *
 * IMPURE. This is the other half of `A7`: the setting offered a "DOM (compatibility)"
 * choice and the rasterisation probe fell back to it, and there was nothing on the other
 * side — every Safari user, and everyone who picked the documented compatibility option,
 * got invisible props and a `console.warn`. `OverlayRoot.mount` had exactly two callers,
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
 * 3. **One resolve per content key, two at a time.** The key carries the LOD rung and
 *    the effects level, because the dressing depends on both — and each rung crossed, each
 *    focus and each level flip used to enrich and measure the document again. The words
 *    and their height are now kept in the card cache (`render/card-cache.ts`, DESIGN A29),
 *    so a rung change costs a string; and resolves go through a two-slot queue, so fifty
 *    cards entering the view do not start fifty enrichments in one frame.
 *
 * One thing the canvas gives for free is taken back by hand: the scene's GLOBAL darkness.
 * A bright sheet of paper floating over a black crypt was the loudest of the losses, and
 * it is one number, so the overlay carries it as a custom property and the stylesheet
 * dims the cards. Per-light illumination and the fog mask stay out of reach — those are
 * fragment-shader work over the primary group, and no CSS can fake them.
 */

import { logger } from "../log";
import { cv } from "../fvtt";
import { curveFor } from "../motion";
import { escapeAttr } from "../html";
import { cardMetrics } from "../data/pin-schema";
import { resolveCard, type ResolvedCard } from "../render/ContentResolver";
import { currentLevel } from "../effects/level";
import { mount, overlay, write } from "../apps/OverlayRoot";
import { tileRect, type PlacedRect } from "./transform";
import type { LodTier } from "./lod";
import type { EffectsLevel } from "../effects/EffectRegistry";
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
  /** Core has this tile selected; the card draws the frame and the grip core's mesh cannot. */
  controlled: boolean;
}

interface DomProp {
  element: HTMLElement;
  /** The content key the element currently shows, so a re-sync is free. */
  key: string;
  /** The resolve this card is waiting for, so a slow one cannot overwrite a newer card. */
  generation: number;
  /** The geometry last written, so a LOD pass after a pan writes nothing. */
  placedAt: PlacedRect | null;
  /** The opacity last written, for the same reason. */
  alpha: number | null;
  /** The height at which the whole card fits, from the resolver; null when unknown. */
  naturalHeight: number | null;
  /** The card markup last written, so a resolve that changed nothing writes nothing. */
  html: string | null;
  /** Consecutive failed resolves, so a card that cannot be drawn stops being retried. */
  failures: number;
}

/** How many times a failed card is tried again before it is left alone. */
const RETRIES = 2;

const props = new Map<string, DomProp>();

/**
 * Every resolve's number, across every card the tier has ever mounted.
 *
 * One counter for the tier, never one per card. Per card it started again at 1 for a new
 * card under the same tile id — and a redraw of the same scene (in v14, switching the
 * viewed Level is one) clears the cards while a resolve is in flight. The old resolve
 * then matched the new card's first and wrote its older HTML over it.
 */
let generations = 0;

/**
 * What the card's CONTENT depends on.
 *
 * The HEIGHT is deliberately absent for HTML: the card fills its box and CSS re-lays it
 * out, so making a prop taller or shorter costs no resolve. That used to be a claim rather
 * than a fact — the card carried its own width, height and font size as inline pixels,
 * and nothing ever re-laid it out — which is why a resized prop sat clipped or short
 * inside its new box until an LOD boundary happened to be crossed.
 *
 * What IS in the key is what the card's pixels are drawn from: the type size and the
 * pad. For a pin whose metrics are stored those never follow the tile; for one that
 * predates stored metrics they derive from the short edge, so a legacy prop still
 * re-resolves when that changes — exactly as its look demands. The WIDTH is in, because
 * the card's natural height is measured at it: without it a narrowed prop kept the
 * height of its old width, and its overflow mark said the wrong thing. A cached body
 * makes that a measurement, not an enrichment. The effect's speed and motion are in,
 * because the dressing is drawn from them — a GM who stopped a preset's loop saw it go on
 * looping until a rung was crossed. A PDF page is rendered at a size, so its geometry is
 * in outright.
 */
function contentKeyOf(entry: DomPropEntry, level: EffectsLevel): string {
  const { pin, doc } = entry;
  const size = { width: doc.width, height: doc.height };
  const { fontPx, padPx } = cardMetrics(pin.display, size);
  return [
    pin.source.uuid ?? pin.source.src ?? entry.id,
    // Separate entries, never concatenated: joined by `|`, ("ab", null) and (null, "ab")
    // would otherwise be the same key. Without these the GM picks another page and the
    // card never re-resolves.
    pin.source.pageId ?? "",
    pin.source.pdfPage ?? "",
    // Which text of an Actor or an Item the card shows, chosen like a page.
    pin.source.field ?? "",
    pin.mode,
    pin.effect.id,
    pin.effect.intensity,
    pin.effect.seed,
    pin.effect.speed,
    pin.effect.motion,
    pin.display.paper,
    // The pin's own face; a preset's is covered by the effect id above.
    pin.display.font ?? "",
    fontPx,
    padPx,
    pin.display.showTitle ? 1 : 0,
    pin.display.label,
    size.width,
    entry.pdf ? `${size.width}x${size.height}` : "",
    entry.tier,
    level,
  ].join("|");
}

/**
 * Bring the mounted cards in line with what the LOD pass decided.
 *
 * A full reconcile rather than a diff the caller maintains: the entry list is tens of
 * items, and a caller-side diff would be one more place for the card and the placeable
 * to drift apart — which on this tier is a prop left behind on a scene it was deleted
 * from.
 *
 * `level` is the pass's, read once by the caller: per card it cost a settings read and a
 * fresh `matchMedia` for every prop on the scene, every pass.
 */
export function syncDomTier(
  entries: readonly DomPropEntry[],
  level: EffectsLevel = currentLevel()
): void {
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
    upsert(entry, level);
  }

  for (const [id, prop] of [...props]) {
    if (live.has(id)) continue;
    prop.element.remove();
    props.delete(id);
  }
}

function upsert(entry: DomPropEntry, level: EffectsLevel): void {
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
      html: null,
      failures: 0,
    };
    props.set(entry.id, prop);
    mount(element);
    mounted = true;
  }

  prop.element.dataset.dpFx = escapeAttr(entry.pin.effect.id);
  if (entry.focused) prop.element.dataset.dpFocused = "true";
  else delete prop.element.dataset.dpFocused;
  markControlled(prop.element, entry.controlled);
  placeGeometry(prop, entry.doc);
  applyAlpha(prop, entry.alpha);
  if (mounted) arrive(prop.element, entry);

  const key = contentKeyOf(entry, level);
  if (prop.key === key) return;
  prop.key = key;

  const generation = ++generations;
  prop.generation = generation;
  const { id, pin, tier } = entry;
  const size = { width: entry.doc.width, height: entry.doc.height };
  enqueue({ id, generation, run: () => resolveInto(id, generation, pin, size, tier) });
}

/** Resolve one card and hand it to `land`, if it is still the card this resolve was for. */
async function resolveInto(
  id: string,
  generation: number,
  pin: DpPinFlags,
  size: { width: number; height: number },
  tier: LodTier
): Promise<void> {
  try {
    const card = await resolveCard(pin, size, { tier, baked: false });
    const current = props.get(id);
    // The scene may have changed, or a newer resolve may already have landed.
    if (!current || current.generation !== generation) return;
    land(current, card);
  } catch (error) {
    log.warn(`DOM prop failed to resolve:`, error);
    // The key was claimed before the resolve, so keeping it would leave this card blank
    // for the rest of the session. Forgotten, the next pass tries again — a few times,
    // not on every pan forever: a card that always throws would otherwise warn after
    // each one. A change to its content, or an edit to its source, starts it over.
    const current = props.get(id);
    if (current && current.generation === generation && ++current.failures <= RETRIES) {
      current.key = "";
    }
  }
}

/**
 * Put a resolved card on the element: the markup and its overflow mark in ONE write.
 *
 * Both inside the write, never the mark after it: the mark is set on the `.dp-card` the
 * markup creates, and a mark decided before the write applies reads the card being
 * replaced — on a first mount, no card at all, so an overflowing letter arrived unmarked.
 *
 * And not at all when the markup is the one already there. A rung or a level crossed and
 * crossed back, or an edit to a source that changed nothing on this card, resolves to the
 * same string; writing it again tore down the card and restarted every animation on it —
 * a scanline sweep jumping back to the top for nothing. The mark still follows the height.
 */
function land(prop: DomProp, card: ResolvedCard): void {
  prop.naturalHeight = card.naturalHeight ?? null;
  prop.failures = 0;
  const element = prop.element;
  if (prop.html === card.html) {
    write(element, () => markOverflow(prop));
    return;
  }
  const html = card.html;
  prop.html = html;
  write(element, () => {
    element.innerHTML = html;
    markOverflow(prop);
  });
}

// ---------------------------------------------------------------------------
// The resolve queue
// ---------------------------------------------------------------------------

/**
 * How many cards resolve at once.
 *
 * Every card that changed key started its resolve in the same pass: a zoom that moved fifty
 * cards across a rung began fifty enrichments, fifty probe layouts and fifty `.then`s
 * writing markup in one burst — on the main thread, during the frames right after the
 * gesture, which are the ones the GM is watching. Two at a time is enough to keep a cached
 * card instant and an uncached one moving, and leaves the frame to the map.
 *
 * Here and not in the resolver: the reader resolves the card a player just clicked, and
 * that must never wait behind the map's fifty.
 */
const RESOLVE_SLOTS = 2;

/**
 * How long one resolve may hold a slot before the queue stops waiting for it.
 *
 * A resolve waits on a document load, an enricher and a PDF render, none of which promise
 * to settle. Two that never did would have stopped every other card on the scene; the
 * resolve goes on, and lands if it is still wanted, but its slot is freed.
 */
const SLOT_HOLD_MS = 10_000;

interface ResolveJob {
  id: string;
  generation: number;
  run: () => Promise<void>;
}

/** Waiting jobs, oldest first — at most one per card. */
let waiting: ResolveJob[] = [];
let running = 0;
/**
 * Bumped by `clearDomTier`. A job started for a scene since torn down does not hold a slot
 * any more, and must not free one the next scene's jobs now hold.
 */
let lane = 0;

/**
 * Start a card's resolve now when a slot is free — synchronously, so a quiet scene's card
 * arrives exactly as it did before there was a queue — or queue it. A card already queued
 * keeps its place with its newer job.
 */
function enqueue(job: ResolveJob): void {
  const queued = waiting.findIndex((other) => other.id === job.id);
  if (queued >= 0) {
    waiting[queued] = job;
    return;
  }
  if (running < RESOLVE_SLOTS) start(job);
  else waiting.push(job);
}

function start(job: ResolveJob): void {
  running += 1;
  const mine = lane;
  let released = false;
  let timer = 0;
  const release = () => {
    if (released) return;
    released = true;
    window.clearTimeout(timer);
    if (mine !== lane) return;
    running -= 1;
    next();
  };
  timer = window.setTimeout(release, SLOT_HOLD_MS);
  void job.run().finally(release);
}

/** Fill the free slots from the queue, passing over a job nobody wants any more. */
function next(): void {
  while (running < RESOLVE_SLOTS && waiting.length) {
    const job = waiting.shift()!;
    // Superseded by a newer resolve of the same card, or the card is gone: unmounted at
    // L0, or its scene torn down.
    if (props.get(job.id)?.generation !== job.generation) continue;
    start(job);
  }
}

/**
 * Forget what these cards show, so the next pass resolves them again.
 *
 * The content key is built from the PIN, and an edit to the journal behind it changes
 * nothing the key can see. `PropManager.invalidate` reset the canvas tier's cache and
 * never reached this one — and on every engine where HTML does not rasterise, which is
 * every engine today, this tier draws every text prop. So a GM who corrected a pinned
 * letter watched the reader show the new text while the paper on the map kept the old,
 * on every client, until a zoom happened to cross a detail boundary.
 *
 * An empty key matches nothing, so the card re-resolves in place: same element, no
 * arrival replayed, and the bumped generation drops a resolve still in flight.
 */
export function invalidateDomProps(ids: Iterable<string>): void {
  for (const id of ids) {
    const prop = props.get(id);
    if (!prop) continue;
    prop.key = "";
    prop.failures = 0;
  }
}

/**
 * Position in SCENE space, exactly as the reader does.
 *
 * The overlay root already carries the stage matrix, so these five values are written
 * once per geometry CHANGE and never per frame — dirty-checked, because a LOD pass runs
 * after every pan and five style writes per prop per pass is what this saves.
 *
 * The box is `tileRect(doc)`, never the document's own point: that point is the tile's
 * centre, and a card placed with its corner there sat half a card down and right of the
 * frame core drew — which is why a text prop showed no resize handle (it was under the
 * paper) and why a dragged prop trailed a white book (core's preview, where the tile
 * actually was).
 *
 * `now` writes in place rather than through `write()`'s frame, for `followDomProp`: core
 * refreshes a dragged or resized tile from inside its own frame, and a queued write
 * landed on the next one — the card a frame behind the handles. The LOD pass keeps the
 * queue, which batches fifty cards into one frame. Either way the write reads the
 * rectangle when it APPLIES, so a write queued by an earlier pass cannot put back a
 * position an immediate one has already moved on from.
 */
function placeGeometry(prop: DomProp, doc: any, now = false): void {
  const next = tileRect(doc);
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

  if (now) paintGeometry(prop);
  else write(prop.element, () => paintGeometry(prop));
}

/** The rectangle last placed, and the overflow mark that follows it, onto the element. */
function paintGeometry(prop: DomProp): void {
  const rect = prop.placedAt;
  if (!rect) return;
  const style = prop.element.style;
  style.left = `${rect.x}px`;
  style.top = `${rect.y}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.transform = `rotate(${rect.rotation}deg)`;
  markOverflow(prop);
}

/**
 * Mark the card when its content does not fit the box, and unmark it when it does.
 * Called INSIDE a write, never before one: it reads the card the element holds when the
 * write applies, and the box and the height as they are then.
 *
 * The resolver marks the card for the size it was resolved at; a resize changes the box
 * without a resolve, so the mark has to follow the geometry here. Skipped entirely while
 * the natural height is unknown — a card that cannot be measured is never told it
 * overflows.
 */
function markOverflow(prop: DomProp): void {
  const height = prop.placedAt?.height;
  if (prop.naturalHeight === null || height === undefined) return;
  const card = prop.element.querySelector<HTMLElement>(".dp-card");
  if (!card) return;
  const overflow = prop.naturalHeight > height + 1;
  if ((card.dataset.dpOverflow === "true") === overflow) return;
  if (overflow) card.dataset.dpOverflow = "true";
  else delete card.dataset.dpOverflow;
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
 * Re-place a mounted card at a document's CURRENT geometry, with no resolve.
 *
 * Core's resize handles mutate the document in memory on every tick of the drag and
 * commit on release; the LOD pass only hears the commit. This is what lets the card
 * follow the handles live, and it is dirty-checked, so a refresh that moved nothing
 * costs a few compares. Written at once, in core's own frame: see `placeGeometry`.
 *
 * `id` names the card when the document is not the card's own: a drag moves core's
 * preview clone, whose document is a copy, and the card that must follow it is the
 * original's.
 */
export function followDomProp(doc: any, id: string | undefined = doc?.id): void {
  const prop = id ? props.get(id) : undefined;
  if (!prop) return;
  placeGeometry(prop, doc, true);
}

/**
 * Core's selection, mirrored on the card.
 *
 * The card is opaque and paints over the Tiles layer, so core's own frame and resize
 * handle lie under it — a GM saw a grip on a PDF, which has no card, and none on a
 * letter. The stylesheet draws both on the marked card, in the same rectangle, and the
 * press still reaches core's handle because the card is pointer-transparent.
 */
export function setDomPropControlled(id: string, controlled: boolean): void {
  const prop = props.get(id);
  if (!prop) return;
  const element = prop.element;
  write(element, () => markControlled(element, controlled));
}

function markControlled(element: HTMLElement, controlled: boolean): void {
  if (controlled) element.dataset.dpControlled = "true";
  else delete element.dataset.dpControlled;
}

/**
 * Preview an intensity as a slider moves.
 *
 * One custom-property write: `--dp-i` is registered and every effect layer consumes it
 * through `calc()`, so the compositor interpolates the change on its own. The commit
 * arrives on `change`, re-resolves the card, and lands on an identical look.
 */
export function previewIntensity(id: string | undefined, intensity: number): void {
  const prop = id ? props.get(id) : null;
  const card = prop?.element.querySelector<HTMLElement>(".dp-card");
  if (!card) return;
  const value = String(Math.min(1, Math.max(0, intensity)));
  write(card, () => card.style.setProperty("--dp-i", value));
}

/** Warm light on the paper while the pointer is over it. The stylesheet draws it. */
export function setDomPropHover(id: string, hovering: boolean): void {
  const prop = props.get(id);
  if (!prop) return;
  const element = prop.element;
  write(element, () => {
    if (hovering) element.dataset.dpHover = "true";
    else delete element.dataset.dpHover;
  });
}

/**
 * A pulse around the paper, for Flash and Locate.
 *
 * A ping is drawn inside the canvas, and this tier's cards are drawn OVER the canvas —
 * so a flash aimed at a prop's centre landed underneath the one opaque thing it was
 * pointing at. The pulse is its own element laid over the card, in the card's rectangle:
 * inside the card it would be clipped by the card's own paint containment, and on the
 * card it would have to replace the card's arrival animation. It removes itself.
 *
 * Local to this client: a card on another screen has no way to hear of it without a
 * socket, which the module does not ship.
 */
export function flashDomProp(doc: any): boolean {
  const prop = doc?.id ? props.get(doc.id) : undefined;
  if (!prop) return false;
  const rect = prop.placedAt ?? tileRect(doc);
  const ring = document.createElement("div");
  ring.className = "dp-flash";
  ring.setAttribute("aria-hidden", "true");
  ring.style.left = `${rect.x}px`;
  ring.style.top = `${rect.y}px`;
  ring.style.width = `${rect.width}px`;
  ring.style.height = `${rect.height}px`;
  ring.style.transform = `rotate(${rect.rotation ?? 0}deg)`;
  const done = () => ring.remove();
  ring.addEventListener("animationend", done, { once: true });
  // A floor under the event, for a client whose animations never run at all.
  setTimeout(done, 2000);
  mount(ring);
  return true;
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
  // The queue is about cards that no longer exist, and the slots their resolves hold are
  // the old scene's: the next scene starts with both free.
  waiting = [];
  running = 0;
  lane += 1;
  // The overlay this value was written on goes with the scene. A stale memo would
  // swallow the next scene's first value whenever it happened to match the last one's.
  sceneDim = null;
}

/**
 * How dark a card gets at a scene darkness of 1 — the one number the live check tunes.
 *
 * Not black: the dim says "it is dark in here", it does not hide the letter, and the
 * reader a player actually reads in is never dimmed at all.
 */
const DARKEST_CARD = 0.35;

/** Twentieths, so a full 0 → 1 transition is at most 21 writes whatever the hook cadence. */
const DIM_STEPS = 20;

/**
 * The brightness a card is drawn at under a scene darkness level.
 *
 * PURE. Anything that is not a finite number reads as daylight: before the canvas
 * environment initialises there is no level at all, and an undimmed card is the
 * behaviour every client had before this existed.
 */
export function sceneBrightness(darkness: unknown): number {
  const level =
    typeof darkness === "number" && Number.isFinite(darkness)
      ? Math.min(1, Math.max(0, darkness))
      : 0;
  const raw = 1 - (1 - DARKEST_CARD) * level;
  return Math.max(DARKEST_CARD, Math.round(raw * DIM_STEPS) / DIM_STEPS);
}

/** The value last written onto the overlay, so an unchanged level costs a compare. */
let sceneDim: number | null = null;

/**
 * Put the scene's darkness on the overlay as `--dp-scene-dim`.
 *
 * One custom property on the ROOT, never a card re-resolve: darkness is deliberately in
 * no content key, and the stylesheet folds it into each card's existing filter chain. So
 * an animated darkness transition costs at most one property write per quantised step,
 * and nothing at all while the level holds.
 *
 * `canvas.environment.darknessLevel` rather than `canvas.darknessLevel`, which throws
 * when read before the canvas has initialised — and this runs from the environment's own
 * initialisation hook. Total: a hook body that threw would break core's canvas draw.
 */
export function syncSceneDim(force = false): void {
  try {
    const canvas = cv();
    const value = sceneBrightness(
      canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel
    );
    if (!force && value === sceneDim) return;
    const root = overlay();
    if (!root) return;
    sceneDim = value;
    write(root, () => root.style.setProperty("--dp-scene-dim", String(value)));
  } catch (error) {
    log.warn(`could not read the scene's darkness`, error);
  }
}

/** How many cards are mounted. A test seam. */
export function domPropCount(): number {
  return props.size;
}
