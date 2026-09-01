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

import { cv, isGM } from "../fvtt";
import { t } from "../i18n";
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
import { CORE_PRESETS } from "../effects/presets/core-presets";
import { swatchStyle } from "../effects/preset-css";
import { resolveCard } from "../render/ContentResolver";
import { measureCardHeight } from "../render/measure";
import { mount, syncTransform, write } from "./OverlayRoot";
import type { DpMode, DpPinFlags, DpSource } from "../types/dp";

/** Everything the ghost holds while armed. Pure data, so the steppers can be tested. */
export interface GhostState {
  source: DpSource;
  mode: DpMode;
  rotation: number;
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

export function initialState(source: DpSource, mode: DpMode, gridSize = 100): GhostState {
  return {
    source,
    mode,
    rotation: 0,
    scale: 1,
    typeSize: settings.get("lastTypeSize") || defaultTypeSize(gridSize),
    heightOverride: null,
    fitPending: false,
    effectIndex: Math.max(
      0,
      CORE_PRESETS.findIndex((p) => p.id === settings.get("lastPreset"))
    ),
    audience: settings.get("defaultAudience"),
    sticky: false,
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
  return { ...state, rotation };
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
): GhostState | "cancel" | null {
  switch (key) {
    case "Escape":
      return "cancel";
    case " ":
      return { ...state, mode: state.mode === "prop" ? "pin" : "prop", heightOverride: null };
    case "f":
    case "F":
      // Claimed here; the measurement is asynchronous and lands through `render`.
      return state.mode === "prop" ? { ...state, fitPending: true } : state;
    case "e":
    case "E": {
      const step = mods.shift ? -1 : 1;
      const next = (state.effectIndex + step + CORE_PRESETS.length) % CORE_PRESETS.length;
      return { ...state, effectIndex: next };
    }
    case "v":
    case "V":
      return { ...state, audience: state.audience === "everyone" ? "hidden" : "everyone" };
    case "r":
    case "R":
      return { ...state, rotation: 0 };
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
 * Snap a scene-space point to the grid unless free placement is held.
 *
 * Snapping is to the grid the scene actually uses; a gridless scene reports size 0 and
 * simply never snaps, rather than collapsing everything to the origin.
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

export function isArmed(): boolean {
  return state !== null;
}

function gridSize(): number {
  return cv()?.scene?.grid?.size ?? 100;
}

function legendMarkup(current: GhostState): string {
  const preset = CORE_PRESETS[current.effectIndex];
  const name = api.labelForSource(current.source);

  const lines = settings.get("placementLegend")
    ? `<div class="dp-ghost__legend">` +
      `<span>${escapeHtml(t("DP.ghost.keysRotate"))}</span>` +
      `<span>${escapeHtml(t("DP.ghost.keysMode"))}</span>` +
      `<span>${escapeHtml(t("DP.ghost.keysPlace"))}</span>` +
      `</div>`
    : "";

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
    `</span></div>${lines}`
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
  const preset = CORE_PRESETS[current.effectIndex];
  element.dataset.dpFx = preset.id;
  element.dataset.dpMode = current.mode;

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
    CORE_PRESETS[current.effectIndex].id,
    current.typeSize,
  ].join("|");
}

/** The pin the ghost would place, so the preview is resolved by the same rules. */
function ghostPin(current: GhostState): DpPinFlags {
  return validatePin({
    ...defaultPin(),
    mode: current.mode,
    source: current.source,
    effect: { ...defaultPin().effect, id: CORE_PRESETS[current.effectIndex].id },
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
    element.style.transform = `rotate(${current.rotation}deg)`;
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
  state = { ...state!, ...snap(point, gridSize(), false) };
  render();
  return true;
}

export function disarm(): void {
  for (const off of listeners) off();
  listeners = [];
  element?.remove();
  element = null;
  state = null;
  lastChip = "";
  previewKey = "";
  previewHtml = "";
  previewGeneration++;
  fitGeneration++;
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
    const point = snap(pointerScenePoint(event), gridSize(), state.freePlace);
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
      state = stepWheel(state, event.deltaY, { shift: event.shiftKey, alt: event.altKey });
      render();
    },
    { passive: false, capture: true }
  );

  on(
    board,
    "pointerdown",
    (event: PointerEvent) => {
      if (!state) return;
      // Right-click and middle-click cancel; they are the universal "not this" and a
      // GM should never have to find the Escape key to get out of a placement.
      if (event.button !== 0) {
        event.preventDefault();
        event.stopPropagation();
        disarm();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void place(event.shiftKey);
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
        return;
      }
      const next = stepKey(state, event.key, { shift: event.shiftKey });
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (next === "cancel") disarm();
      else {
        state = next;
        render();
      }
    },
    { capture: true }
  );

  on(window, "keyup", (event: KeyboardEvent) => {
    if (!state) return;
    if (event.key === "Control" || event.key === "Meta") state = { ...state, freePlace: false };
  });

  // Losing the window mid-placement leaves a ghost stuck to a cursor that is no longer
  // there; so does switching layers. Both disarm.
  on(window, "blur", () => disarm());
  on(document, "visibilitychange", () => {
    if (document.hidden) disarm();
  });
}

async function place(keepArmed: boolean): Promise<void> {
  if (!state) return;
  const current = state;
  const scene = cv()?.scene;
  const size = sizeOf(current, gridSize());
  const preset = CORE_PRESETS[current.effectIndex];

  if (!keepArmed) disarm();

  const anchor = await api.pinAt(scene, current.source, {
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

  await settings.set("lastPreset", preset.id);
  await settings.set("lastTypeSize", current.typeSize);
  if (anchor) announce(anchor, current);
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
  return arm({ kind: "document", uuid, src: null, pageId: null, followName: true });
}
