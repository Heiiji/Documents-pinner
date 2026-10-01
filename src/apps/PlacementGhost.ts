/**
 * Placement — a ghost that follows the cursor, not a modal.
 *
 * IMPURE. The transform maths comes from `canvas/transform.ts`; the key handling and
 * the geometry stepping are pure functions at the top of this file so they can be
 * tested without a canvas.
 *
 * Why a ghost at all: a modal cannot answer any of the questions that actually matter
 * while placing a pin — how big is it *here*, does the effect read against *this* map,
 * is it covering the door — and it costs two extra clicks each time. A GM placing ten
 * clue markers during prep would face ten dialogs. The ghost answers all three
 * questions by being the real thing at real size, and `Shift+click` places without
 * disarming, so ten markers is one arm and ten clicks.
 *
 * The legend chip is the other half. Nobody reads documentation mid-prep, so the
 * gesture vocabulary is printed next to the thing it operates on, and it is the only
 * place in the module that teaches itself.
 */

import { cfg, cv, isGM, notify, ns } from "../fvtt";
import { t } from "../i18n";
import { logger } from "../log";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import * as settings from "../settings";
import { readPin } from "../data/PinData";
import {
  DEFAULT_MARGIN_EM,
  TYPE_SIZE_MIN,
  defaultPin,
  defaultTypeSize,
  naturalSize,
  validatePin,
} from "../data/pin-schema";
import { scaleOf, screenToScene, stageMatrix } from "../canvas/transform";
import { allPresets } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { resolveCard } from "../render/ContentResolver";
import { measureCardHeight } from "../render/measure";
import { leave, mount, syncTransform, write } from "./OverlayRoot";
import { modifierGlyphs, platform } from "../ui/modifiers";
import { isTextEntry } from "../ui/cheatsheet";
import { closeCheatSheet, toggleCheatSheet } from "./CheatSheet";
import type { DpMode, DpPinFlags, DpSource } from "../types/dp";

const log = logger("ghost");

/** Everything the ghost holds while armed. Pure data, so the steppers can be tested. */
export interface GhostState {
  source: DpSource;
  mode: DpMode;
  /** Wrapped into 0..359, which is what the document stores. */
  rotation: number;
  /**
   * The same angle, unwrapped, which is what the element is drawn at: a CSS transition
   * from 345° to 0° turns the long way round, so the shown angle only ever accumulates.
   */
  rotationShown: number;
  /** Multiplier on the mode's natural size — the BOX. */
  scale: number;
  /** Type size in scene px — the density. The box and the type are two gestures. */
  typeSize: number;
  /** A height fitted to the content with `F`; forgotten when the box or type changes. */
  heightOverride: number | null;
  /** `F` was pressed and the measurement has not landed yet. */
  fitPending: boolean;
  effectIndex: number;
  audience: "everyone" | "hidden";
  /** Stays armed after a click, for placing a run of markers in one gesture. */
  sticky: boolean;
  /**
   * The Shift being held has already been used as a modifier — a fine rotation, a step
   * back through the effects. Such a hold is not a request to keep stamping, so the click
   * that ends it places once. Cleared when Shift is released.
   */
  shiftChorded: boolean;
  /** Suspend grid snapping while held. */
  freePlace: boolean;
  x: number;
  y: number;
}

export const SCALE_MIN = 0.25;
export const SCALE_MAX = 6;
/** Larger than this on a ghost is a poster, and the Studio slider stops there too. */
export const TYPE_SIZE_GHOST_MAX = 72;
export const TYPE_SIZE_STEP = 0.5;

/**
 * The modifier glyphs the legend prints, by platform — see `ui/modifiers.ts`, which the
 * Pinboard's help line shares. The letters E, V, R and F are window handlers rather than
 * keybindings, so they cannot be derived from Configure Controls; the modifiers can at
 * least be named in the language of the keyboard.
 */
export { modifierGlyphs };

export function initialState(source: DpSource, mode: DpMode, gridSize = 100): GhostState {
  return {
    source,
    mode,
    rotation: 0,
    rotationShown: 0,
    scale: 1,
    typeSize: settings.get("lastTypeSize") || defaultTypeSize(gridSize),
    heightOverride: null,
    fitPending: false,
    effectIndex: Math.max(
      0,
      allPresets().findIndex((p) => p.id === settings.get("lastPreset"))
    ),
    audience: settings.get("defaultAudience"),
    sticky: false,
    shiftChorded: false,
    freePlace: false,
    x: 0,
    y: 0,
  };
}

/**
 * Wheel handling.
 *
 * Four gestures on one wheel, because during placement the hand is already on the
 * pointer and reaching for a slider means losing the position. Rotation snaps to 15° so
 * a letter lands square without fiddling; `Shift` unlocks 1° for the times it should
 * look dropped rather than placed. `Alt` scales the BOX — how big on the map — and
 * `Shift+Alt` the TYPE — how dense; the preview makes the difference visible.
 */
export function stepWheel(
  state: GhostState,
  delta: number,
  mods: { shift?: boolean; alt?: boolean }
): GhostState {
  const direction = delta > 0 ? 1 : -1;
  // A Shift used here is a modifier on the wheel, not a request to keep placing.
  if (mods.shift) state = { ...state, sticky: false, shiftChorded: true };

  if (mods.alt && mods.shift) {
    const typeSize = state.typeSize - direction * TYPE_SIZE_STEP;
    return {
      ...state,
      typeSize: Math.min(TYPE_SIZE_GHOST_MAX, Math.max(TYPE_SIZE_MIN, typeSize)),
      heightOverride: null,
    };
  }
  if (mods.alt) {
    const scale = state.scale * (direction > 0 ? 1 / 1.1 : 1.1);
    return {
      ...state,
      scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)),
      heightOverride: null,
    };
  }
  const step = mods.shift ? 1 : 15;
  const rotation = (((state.rotation + direction * step) % 360) + 360) % 360;
  return { ...state, rotation, rotationShown: state.rotationShown + direction * step };
}

/**
 * Key handling, as a pure state transition.
 *
 * Returns `null` for a key the ghost does not claim, so the caller knows whether to
 * consume the event — swallowing keys the ghost has no opinion about would break every
 * other shortcut in Foundry while a pin is armed.
 */
export function stepKey(
  state: GhostState,
  key: string,
  mods: { shift?: boolean } = {}
): GhostState | "cancel" | "help" | null {
  switch (key) {
    case "Escape":
      return "cancel";
    case "?":
      return "help";
    case " ":
      return { ...state, mode: state.mode === "prop" ? "pin" : "prop", heightOverride: null };
    case "f":
    case "F":
      // Claimed here; the measurement is asynchronous and lands through `render`.
      return state.mode === "prop" ? { ...state, fitPending: true } : state;
    case "e":
    case "E": {
      const step = mods.shift ? -1 : 1;
      const next = (state.effectIndex + step + allPresets().length) % allPresets().length;
      const chord = mods.shift ? { sticky: false, shiftChorded: true } : {};
      return { ...state, ...chord, effectIndex: next };
    }
    case "v":
    case "V":
      return { ...state, audience: state.audience === "everyone" ? "hidden" : "everyone" };
    case "r":
    case "R": {
      // Back to square by the shortest turn: the nearest full rotation of the shown angle.
      const turns = Math.round(state.rotationShown / 360);
      return { ...state, rotation: 0, rotationShown: turns === 0 ? 0 : turns * 360 };
    }
    default:
      return null;
  }
}

export function sizeOf(state: GhostState, gridSize: number): { width: number; height: number } {
  const base = naturalSize(state.mode, gridSize);
  const fitted = state.mode === "prop" ? state.heightOverride : null;
  return {
    width: Math.round(base.width * state.scale),
    height: fitted ?? Math.round(base.height * state.scale),
  };
}

/**
 * Snap a scene-space point to a square grid unless free placement is held.
 *
 * A size of 0 never snaps, rather than collapsing everything to the origin. Which grid
 * the scene has is `snapToScene`'s question: v14 never reports a size of 0.
 */
export function snap(point: { x: number; y: number }, gridSize: number, free: boolean) {
  if (free || !gridSize) return point;
  const half = gridSize / 2;
  return {
    x: Math.round(point.x / half) * half,
    y: Math.round(point.y / half) * half,
  };
}

// ---------------------------------------------------------------------------
// The live ghost
// ---------------------------------------------------------------------------

let state: GhostState | null = null;
let element: HTMLElement | null = null;
let listeners: (() => void)[] = [];
/** Core's grid constants, looked up when the ghost is armed rather than on every move. */
let gridConstants: { types: any; modes: any } = { types: undefined, modes: undefined };

export function isArmed(): boolean {
  return state !== null;
}

function gridSize(): number {
  return cv()?.scene?.grid?.size ?? 100;
}

/**
 * Snap to the grid this scene actually has, unless free placement is held.
 *
 * The ghost assumed "a gridless scene reports size 0", which v14 does not allow — a grid's
 * size has a minimum and defaults to 100 — so a gridless scene jumped in 50 px steps, and
 * a hex scene snapped to a square lattice that lands between its hexes. Now: no grid, no
 * snap; a square grid, its half-square lattice, as before; hexagons, core's own snapping
 * to their centres, vertices and edge midpoints — the same points the half-square lattice
 * is on a square — or no snap on a core without it.
 */
function snapToScene(point: { x: number; y: number }, free: boolean): { x: number; y: number } {
  if (free) return point;
  const grid = cv()?.grid;
  const TYPES = gridConstants.types;
  const type = grid?.type ?? cv()?.scene?.grid?.type;
  if (TYPES && type === TYPES.GRIDLESS) return point;
  if (!TYPES || type === undefined || type === TYPES.SQUARE) return snap(point, gridSize(), false);

  const M = gridConstants.modes;
  if (typeof grid?.getSnappedPoint !== "function" || !M) return point;
  const snapped = grid.getSnappedPoint(
    { x: point.x, y: point.y },
    { mode: M.CENTER | M.VERTEX | M.EDGE_MIDPOINT, resolution: 1 }
  );
  return Number.isFinite(snapped?.x) && Number.isFinite(snapped?.y)
    ? { x: snapped.x, y: snapped.y }
    : point;
}

function legendMarkup(current: GhostState): string {
  const preset = allPresets()[current.effectIndex];
  const name = api.labelForSource(current.source);

  const lines = settings.get("placementLegend") ? legendLines() : "";

  const type = current.mode === "prop" ? `${Math.round(current.typeSize)} px · ` : "";

  return (
    // The effect, actually drawn. DESIGN §5.2's entire justification for a ghost over a
    // modal is "does the effect read against THIS map" — and the ghost was a dashed
    // rectangle: `dataset.dpFx` was set and nothing styled `.dp-ghost[data-dp-fx]`, so
    // the one question the ghost exists to answer was the one it could not. The swatch
    // is the instant answer; the real content replaces it once it resolves.
    `<div class="dp-ghost__body" aria-hidden="true">` +
    `<div class="dp-card" style="${escapeAttr(swatchStyle(preset))}"></div></div>` +
    `<div class="dp-ghost__chip">` +
    `<span class="dp-ghost__name">${escapeHtml(name)}</span>` +
    `<span class="dp-ghost__meta">${escapeHtml(t(preset.label))} · ` +
    `${Math.round(current.scale * 100)}% · ${type}` +
    `${escapeHtml(t(current.audience === "everyone" ? "DP.ghost.audienceAll" : "DP.ghost.audienceNone"))}` +
    `${current.sticky ? ` · ${escapeHtml(t("DP.ghost.stamping"))}` : ""}` +
    `</span></div>${lines}`
  );
}

/**
 * The legend, one span per key so a held modifier can light its own entries.
 *
 * Nobody reads documentation mid-prep, so the gestures are printed beside the thing
 * they operate on — and when Ctrl or Shift is down, the entries that key changes go
 * warm, which is the legend teaching by showing rather than by telling.
 */
export function legendLines(): string {
  const g = modifierGlyphs(platform());
  const key = (keys: string, text: string) =>
    `<span data-dp-key="${escapeAttr(keys)}">${escapeHtml(text)}</span>`;
  const sep = " · ";
  return (
    `<div class="dp-ghost__legend">` +
    `<span>` +
    key("wheel", `${g.wheel} ${t("DP.ghost.rotate")}`) +
    sep +
    key("shift", `${g.shift}${g.wheel} ${t("DP.ghost.fine")}`) +
    sep +
    key("alt", `${g.alt}${g.wheel} ${t("DP.ghost.scale")}`) +
    sep +
    key("shift alt", `${g.shift}${g.alt}${g.wheel} ${t("DP.ghost.textSize")}`) +
    sep +
    key("ctrl", `${g.ctrl}${g.wheel} ${t("DP.ghost.zoom")}`) +
    `</span>` +
    `<span>` +
    key("space", `${g.space} ${t("DP.ghost.shape")}`) +
    sep +
    key("e", `E ${t("DP.ghost.effect")}`) +
    sep +
    key("v", `V ${t("DP.ghost.audience")}`) +
    sep +
    key("f", `F ${t("DP.ghost.fit")}`) +
    `</span>` +
    `<span>` +
    key("ctrl", `${g.ctrl}${t("DP.ghost.freePlace")}`) +
    sep +
    key("shift", `${g.shift}${t("DP.ghost.click")} ${t("DP.ghost.stamp")}`) +
    sep +
    key("esc", `${g.esc} ${t("DP.ghost.cancel")}`) +
    sep +
    key("right", t("DP.ghost.pan")) +
    sep +
    // The rest, R among them, is on the sheet — which answers `?` with the legend off too.
    key("help", `? ${t("DP.cheat.legend")}`) +
    `</span>` +
    `</div>`
  );
}

/** The legend as last drawn, so a pointer move does not rebuild it. */
let lastChip = "";

/**
 * The chip, which changes only when the GM changes something.
 *
 * Split from the position write because it was `innerHTML`, synchronously, inside the
 * `pointermove` handler — a full parse and layout of the legend on every mouse movement,
 * for markup that only changes on a scale, effect, audience or mode step.
 */
function renderChip(current: GhostState): void {
  if (!element) return;
  const preset = allPresets()[current.effectIndex];
  element.dataset.dpFx = preset.id;
  element.dataset.dpMode = current.mode;

  // The held modifiers, as attributes the stylesheet can show: a solid border while
  // placing free of the grid, a stamp mark while a run of markers is armed.
  if (current.freePlace) element.dataset.dpFree = "true";
  else delete element.dataset.dpFree;
  if (current.sticky) element.dataset.dpSticky = "true";
  else delete element.dataset.dpSticky;

  const markup = legendMarkup(current);
  if (markup === lastChip) return;
  lastChip = markup;
  element.innerHTML = markup;
  // The rewrite just replaced the body with the swatch; put the resolved page back.
  applyPreview();
}

// ---------------------------------------------------------------------------
// The preview: the real page at the chosen type size
// ---------------------------------------------------------------------------

let previewKey = "";
let previewHtml = "";
let previewGeneration = 0;
let fitGeneration = 0;

/** What the preview's content depends on. Not the box: the card fills whatever box. */
function previewKeyOf(current: GhostState): string {
  return [
    current.mode,
    current.source.uuid ?? current.source.src ?? "",
    allPresets()[current.effectIndex].id,
    current.typeSize,
  ].join("|");
}

/** The pin the ghost would place, so the preview is resolved by the same rules. */
function ghostPin(current: GhostState): DpPinFlags {
  return validatePin({
    ...defaultPin(),
    mode: current.mode,
    source: current.source,
    effect: { ...defaultPin().effect, id: allPresets()[current.effectIndex].id },
    display: {
      ...defaultPin().display,
      typeSize: current.typeSize,
      margin: DEFAULT_MARGIN_EM,
    },
  }).pin;
}

function applyPreview(): void {
  if (!element || !state || !previewHtml || previewKey !== previewKeyOf(state)) return;
  const body = element.querySelector<HTMLElement>(".dp-ghost__body");
  if (body) body.innerHTML = previewHtml;
}

/**
 * Resolve the real content once per key, and never let a slow resolve overwrite a
 * newer one — the same generation guard the DOM tier uses.
 */
function renderPreview(current: GhostState): void {
  if (current.mode !== "prop") return;
  const key = previewKeyOf(current);
  if (key === previewKey) {
    applyPreview();
    return;
  }
  previewKey = key;
  previewHtml = "";
  const generation = ++previewGeneration;

  void resolveCard(ghostPin(current), sizeOf(current, gridSize()), { tier: "L2b", baked: false })
    .then((card) => {
      if (generation !== previewGeneration || !state || previewKeyOf(state) !== key) return;
      previewHtml = card.html;
      applyPreview();
    })
    .catch(() => {});
}

/**
 * `F`: fit the ghost's height to its content at the current width and type size.
 *
 * Measured from the resolved preview, so it needs one; before the page has resolved the
 * key is simply consumed, and pressing it again a moment later works.
 */
function requestFit(): void {
  if (!state || !state.fitPending) return;
  state = { ...state, fitPending: false };
  if (!previewHtml || state.mode !== "prop") return;

  const generation = ++fitGeneration;
  const width = sizeOf(state, gridSize()).width;
  void measureCardHeight(previewHtml, width).then((height) => {
    if (generation !== fitGeneration || !state || height === null) return;
    state = { ...state, heightOverride: Math.round(height) };
    render();
  });
}

/** The position, which changes on every pointer move and is a batched style write only. */
function renderPosition(current: GhostState): void {
  if (!element) return;
  const size = sizeOf(current, gridSize());
  const k = scaleOf(stageMatrix());

  write(element, () => {
    if (!element) return;
    // Positioned in SCENE space: the overlay root already carries the stage matrix, so
    // the ghost needs no scale of its own and stays pixel-exact through a zoom.
    element.style.left = `${current.x}px`;
    element.style.top = `${current.y}px`;
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    element.style.transform = `rotate(${current.rotationShown}deg)`;
    element.style.setProperty("--dp-ghost-zoom", String(1 / (k || 1)));
  });
}

function render(): void {
  if (!state || !element) return;
  renderChip(state);
  renderPreview(state);
  renderPosition(state);
  requestFit();
}

/** Arm placement. Returns false when there is nothing to place onto. */
export function arm(source: DpSource, mode?: DpMode): boolean {
  if (!isGM() || !cv()?.ready) return false;
  disarm();

  gridConstants = { types: ns("CONST.GRID_TYPES"), modes: ns("CONST.GRID_SNAPPING_MODES") };
  state = initialState(source, mode ?? settings.get("defaultMode"), gridSize());
  element = document.createElement("div");
  element.className = "dp-ghost";
  element.setAttribute("aria-hidden", "true");
  mount(element);

  attach();
  render();
  return true;
}

/** Arm and immediately place the ghost at a known scene point. Used by the drop path. */
export function armAt(source: DpSource, point: { x: number; y: number }, mode?: DpMode): boolean {
  if (!arm(source, mode)) return false;
  state = { ...state!, ...snapToScene(point, false) };
  render();
  return true;
}

export function disarm(): void {
  for (const off of listeners) off();
  listeners = [];
  // However the placement ended — a click, Shift+P, the window losing focus.
  closeCheatSheet("ghost", false);
  const node = element;
  element = null;
  state = null;
  lastChip = "";
  previewKey = "";
  previewHtml = "";
  previewGeneration++;
  fitGeneration++;
  if (node) void leave(node, "dp-ghost--out");
}

function on<K extends keyof WindowEventMap>(
  target: EventTarget,
  type: K | string,
  handler: (event: any) => void,
  options?: AddEventListenerOptions
): void {
  target.addEventListener(type, handler, options);
  listeners.push(() => target.removeEventListener(type, handler, options));
}

/**
 * The pointer in SCENE coordinates.
 *
 * Foundry already tracks this, and using it avoids both a client->scene conversion and
 * a `getBoundingClientRect` read on every pointer move. The manual conversion stays as
 * a fallback for a build that stops exposing it.
 */
function pointerScenePoint(event: PointerEvent): { x: number; y: number } {
  const tracked = cv()?.mousePosition;
  if (tracked && Number.isFinite(tracked.x)) return { x: tracked.x, y: tracked.y };
  return screenToScene({ x: event.clientX, y: event.clientY });
}

function attach(): void {
  const board = document.getElementById("board") ?? document.body;

  on(board, "pointermove", (event: PointerEvent) => {
    if (!state) return;
    const point = snapToScene(pointerScenePoint(event), state.freePlace);
    if (point.x === state.x && point.y === state.y) return;

    state = { ...state, x: point.x, y: point.y };
    syncTransform();
    // Position only: nothing in the legend can have changed by moving the mouse.
    renderPosition(state);
  });

  on(
    board,
    "wheel",
    (event: WheelEvent) => {
      if (!state) return;
      event.preventDefault();
      event.stopPropagation();
      // Ctrl or ⌘ zooms — and so does a trackpad pinch, which arrives as a ctrl-wheel.
      // The plain wheel is the rotation, as it is in the template placement the common
      // systems ship, so without this there was no way to zoom while a pin was armed.
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event);
        return;
      }
      state = stepWheel(state, event.deltaY, { shift: event.shiftKey, alt: event.altKey });
      render();
    },
    { passive: false, capture: true }
  );

  // Where a right press began, so its release can tell a click from a drag.
  let rightPress: { x: number; y: number } | null = null;

  on(
    board,
    "pointerdown",
    (event: PointerEvent) => {
      if (!state) return;
      // A right press is left to core, because a right DRAG is how Foundry pans — and a
      // target off the edge of the screen was unreachable while every right press
      // cancelled. A right CLICK still cancels, on its release, below.
      if (event.button === 2) {
        rightPress = { x: event.clientX, y: event.clientY };
        return;
      }
      // Middle-click cancels at once; it pans nothing in Foundry.
      if (event.button !== 0) {
        event.preventDefault();
        event.stopPropagation();
        disarm();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Shift at the click stamps — unless this Shift was already spent on the wheel or
      // on stepping back through the effects, which a click at the end of a fine rotation
      // used to turn into "and keep placing".
      const stamp = state.sticky || (event.shiftKey && !state.shiftChorded);
      place(stamp).catch((error) => {
        // The ghost stays armed, so the GM can simply press again.
        log.warn(`placing the pin failed`, error);
        notify({ key: "DP.notice.placeFailed" }, "warn");
      });
    },
    { capture: true }
  );

  on(
    window,
    "keydown",
    (event: KeyboardEvent) => {
      if (!state) return;
      if (event.key === "Control" || event.key === "Meta") {
        state = { ...state, freePlace: true };
        renderChip(state);
        return;
      }
      if (event.key === "Shift") {
        // A fresh hold: nothing has used it yet, so it means "keep placing" until the
        // wheel or a key claims it as a modifier. A key-repeat is the same hold.
        if (!event.repeat) state = { ...state, sticky: true, shiftChorded: false };
        renderChip(state);
        return;
      }
      const next = stepKey(state, event.key, { shift: event.shiftKey });
      if (next === null) return;
      // A `?` typed into the chat box is the chat's.
      if (next === "help" && isTextEntry(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      // The sheet is over the placement, so Escape takes the sheet down first.
      if (next === "cancel" && closeCheatSheet()) return;
      if (next === "cancel") disarm();
      else if (next === "help") {
        // `?` is Shift+/ on most layouts: that Shift was a modifier, not "keep placing".
        if (event.shiftKey) state = { ...state, sticky: false, shiftChorded: true };
        renderChip(state);
        toggleCheatSheet("ghost");
      } else {
        state = next;
        render();
      }
    },
    { capture: true }
  );

  on(window, "keyup", (event: KeyboardEvent) => {
    if (!state) return;
    if (event.key === "Control" || event.key === "Meta") {
      state = { ...state, freePlace: false };
      renderChip(state);
    }
    if (event.key === "Shift") {
      state = { ...state, sticky: false, shiftChorded: false };
      renderChip(state);
    }
  });

  // The release that decides whether a right press was a click (cancel) or a pan (keep).
  on(
    window,
    "pointerup",
    (event: PointerEvent) => {
      if (!state || event.button !== 2 || !rightPress) return;
      const moved = Math.hypot(event.clientX - rightPress.x, event.clientY - rightPress.y);
      rightPress = null;
      if (moved < RIGHT_CLICK_SLOP) disarm();
    },
    { capture: true }
  );

  // Losing the window mid-placement leaves a ghost stuck to a cursor that is no longer
  // there; so does switching layers. Both disarm.
  on(window, "blur", () => disarm());
  on(document, "visibilitychange", () => {
    if (document.hidden) disarm();
  });
}

/** How far a right press may travel and still be a click rather than the start of a pan. */
const RIGHT_CLICK_SLOP = 6;

/** How much one wheel notch zooms, the step core's own wheel uses. */
const ZOOM_STEP = 1.1;

/**
 * Zoom toward the pointer, within the canvas's own limits.
 *
 * The scene point under the pointer stays under it, which is what a zoom by wheel does
 * everywhere else and what keeps the ghost where the GM was aiming.
 */
function zoomAt(event: WheelEvent): void {
  const canvas = cv();
  const current = canvas?.stage?.scale?.x;
  if (!canvas?.pan || !current || !event.deltaY) return;
  const limits = cfg()?.Canvas ?? {};
  const next = Math.min(
    limits.maxZoom ?? 3,
    Math.max(limits.minZoom ?? 0.1, current * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
  );
  if (next === current) return;
  const pivot = canvas.stage?.pivot;
  if (!pivot || !Number.isFinite(pivot.x)) {
    canvas.pan({ scale: next });
    return;
  }
  const at = pointerScenePoint(event as unknown as PointerEvent);
  const keep = current / next;
  canvas.pan({
    x: at.x + (pivot.x - at.x) * keep,
    y: at.y + (pivot.y - at.y) * keep,
    scale: next,
  });
}

/** Whether a placement is in flight, so a double press cannot place twice. */
let placing = false;

async function place(keepArmed: boolean): Promise<void> {
  if (!state || placing) return;
  const current = state;
  const scene = cv()?.scene;
  const size = sizeOf(current, gridSize());
  const preset = allPresets()[current.effectIndex];

  // The ghost holds until the prop exists. Disarming first left one server round trip
  // with nothing on the map at all; now the real card mounts under the fading ghost.
  placing = true;
  if (keepArmed) stamp();

  // Released whatever happens: a create the server refuses used to leave this set, and
  // every placement after it — ghost, drop, `/pin`, Shift+P — did nothing for the rest
  // of the session while the ghost went on swallowing the clicks.
  let anchor: any;
  try {
    anchor = await api.pinAt(scene, current.source, {
      x: current.x,
      y: current.y,
      centred: true,
      mode: current.mode,
      width: size.width,
      height: size.height,
      rotation: current.rotation,
      // Zero, NOT `foregroundElevation`. That field is the scene's foreground THRESHOLD
      // (default 20): a tile at or above it is an overhead tile and sorts above tokens in
      // `canvas.primary`, which breaks acceptance criterion 4 — "a token standing on a
      // prop renders in front of it" — for every ghost-placed prop. That is one of the two
      // visual claims the whole primary-group architecture was chosen for. The brief asked
      // for the active Scene Level, not the threshold; the Studio's elevation field is
      // where a GM raises a prop deliberately.
      elevation: 0,
      effectId: preset.id,
      audienceKind: current.audience,
      typeSize: current.typeSize,
      margin: DEFAULT_MARGIN_EM,
    });
  } finally {
    placing = false;
  }
  if (!keepArmed) disarm();

  await settings.set("lastPreset", preset.id);
  await settings.set("lastTypeSize", current.typeSize);
  if (anchor) announce(anchor, current);
}

/**
 * The stamp: a one-shot pulse on the preview when a pin lands and the ghost stays
 * armed, so a run of markers acknowledges each one without a glance at the toast.
 */
function stamp(): void {
  const body = element?.querySelector<HTMLElement>(".dp-ghost__body");
  if (!body) return;
  body.classList.remove("dp-ghost--stamp");
  // Reflow between remove and add, or a second stamp in a row never restarts.
  void body.offsetWidth;
  body.classList.add("dp-ghost--stamp");
  body.addEventListener("animationend", () => body.classList.remove("dp-ghost--stamp"), {
    once: true,
  });
}

/**
 * The commit toast.
 *
 * Says what was placed AND who can see it, because "visible to everyone" is the single
 * fact a GM most needs to catch immediately and least expects to have got wrong.
 */
function announce(anchor: any, current: GhostState): void {
  const notifications = (globalThis as any).ui?.notifications;
  const pin = readPin(anchor);
  const label = pin ? api.labelFor(pin) : "";
  const message = t(
    current.audience === "everyone" ? "DP.ghost.placedVisible" : "DP.ghost.placedHidden",
    { name: label }
  );
  notifications?.info?.(message);
}

/** Escape-hatch used by the keybindings: place the last-used source under the cursor. */
export function armLastUsed(): boolean {
  const uuid = settings.get("lastSourceUuid");
  if (!uuid) return false;
  return arm({ kind: "document", uuid, src: null, pageId: null, pdfPage: null, followName: true });
}
