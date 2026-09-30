/**
 * Preset Studio — authoring the effects themselves.
 *
 * IMPURE. Three panes: the library, a live preview, and the parameters of whatever is
 * selected.
 *
 * The preview's BACKGROUND SWATCHES matter more than they look. An effect authored
 * against a white panel is invisible on a dark dungeon map, and an author has no way to
 * discover that from inside a settings window — so the preview offers the current map,
 * dark, light and a checker, and switching between them is one click.
 *
 * Core presets are read-only and Duplicate is the only way to edit one, so a preset
 * broken while being tuned always has a working ancestor. That is also why the cost
 * meter is derived rather than authored: a meter that lied about what is expensive
 * would be worse than no meter at all.
 */

import { ns } from "../fvtt";
import { t } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import { readPin } from "../data/PinData";
import * as library from "../effects/preset-library";
import { dressing } from "../effects/EffectRegistry";
import {
  EDGE_STYLES,
  FRAME_STYLES,
  HUD_GRIDS,
  HUD_MARKS,
  estimateCost,
  type DpPreset,
} from "../effects/preset-schema";
import { currentLevel } from "../effects/level";
import { fontChoices, fontLabel, fontOptionsMarkup, fontStack } from "../effects/typeface";
import { registeredFontFamilies } from "../render/AssetInliner";
import { restoreFocus, snapshotFocus } from "./focus-restore";

let StudioClass: any = null;
let instance: any = null;

type Backdrop = "map" | "dark" | "light" | "checker";

const BACKDROPS: { id: Backdrop; key: string }[] = [
  { id: "map", key: "DP.presets.bgMap" },
  { id: "dark", key: "DP.presets.bgDark" },
  { id: "light", key: "DP.presets.bgLight" },
  { id: "checker", key: "DP.presets.bgChecker" },
];

/** The numeric parameters offered as sliders, with the ranges the schema clamps to. */
const SLIDERS: { path: string; key: string; min: number; max: number; step: number }[] = [
  { path: "tint.amount", key: "DP.presets.tintAmount", min: 0, max: 1, step: 0.05 },
  { path: "glow.radius", key: "DP.presets.glowRadius", min: 0, max: 200, step: 5 },
  { path: "glow.opacity", key: "DP.presets.glowOpacity", min: 0, max: 1, step: 0.05 },
  { path: "glow.pulseHz", key: "DP.presets.glowPulse", min: 0, max: 10, step: 0.25 },
  { path: "blur", key: "DP.presets.blur", min: 0, max: 64, step: 1 },
  { path: "chroma.offset", key: "DP.presets.chroma", min: 0, max: 32, step: 1 },
  { path: "scanlines.spacing", key: "DP.presets.scanGap", min: 1, max: 64, step: 1 },
  { path: "scanlines.opacity", key: "DP.presets.scanOpacity", min: 0, max: 1, step: 0.05 },
  { path: "noise.amount", key: "DP.presets.noise", min: 0, max: 1, step: 0.05 },
  { path: "noise.scale", key: "DP.presets.noiseScale", min: 0.1, max: 16, step: 0.1 },
  { path: "flicker.amount", key: "DP.presets.flicker", min: 0, max: 1, step: 0.05 },
  { path: "jitter.amount", key: "DP.presets.jitter", min: 0, max: 32, step: 1 },
  { path: "edge.amount", key: "DP.presets.edgeAmount", min: 0, max: 1, step: 0.05 },
  { path: "frame.thickness", key: "DP.presets.frameWidth", min: 0, max: 32, step: 1 },
  { path: "surface.opacity", key: "DP.presets.surface", min: 0, max: 1, step: 0.05 },
  { path: "shadow.opacity", key: "DP.presets.shadow", min: 0, max: 1, step: 0.05 },
  { path: "hud.opacity", key: "DP.presets.hudOpacity", min: 0, max: 1, step: 0.05 },
  { path: "hud.pitch", key: "DP.presets.hudPitch", min: 2, max: 128, step: 1 },
  { path: "hud.weight", key: "DP.presets.hudWeight", min: 0, max: 8, step: 0.5 },
  // Seconds, not Hz — see the note on `sweepSec` in the schema. A slider in Hz could not
  // reach a nine-second pass at all.
  { path: "hud.sweepSec", key: "DP.presets.hudSweep", min: 0, max: 60, step: 0.5 },
];

/**
 * The colours and the shapes, which had no control at all.
 *
 * `SLIDERS` covers only numbers, so until now nothing in this window could change a
 * colour or any enum: `edge.style` and `frame.style` were as unreachable as the new
 * overlay's geometry, and a GM who duplicated a preset could not make it amber. Every
 * value below is validated by `validatePreset` on the way back in — colours against `HEX`
 * and the enums against their own lists — so a bad one degrades rather than throws.
 */
const COLOURS: { path: string; key: string }[] = [
  { path: "tint.color", key: "DP.presets.tintColour" },
  { path: "glow.color", key: "DP.presets.glowColour" },
  { path: "frame.color", key: "DP.presets.frameColour" },
  { path: "hud.color", key: "DP.presets.hudColour" },
];

const CHOICES: {
  path: string;
  key: string;
  options: readonly string[];
  /**
   * Composed rather than stored as a prefix string. A bare quoted prefix looks exactly
   * like a key to the scan in `i18n.test.ts`, which would then demand a table entry for
   * a key that is only ever half of one. (This comment is why it is a function and not
   * two lines shorter — and why it may not quote the prefix either.)
   */
  label: (option: string) => string;
}[] = [
  {
    path: "edge.style",
    key: "DP.presets.edgeStyle",
    options: EDGE_STYLES,
    label: (o) => t(`DP.edge.${o}`),
  },
  {
    path: "frame.style",
    key: "DP.presets.frameStyle",
    options: FRAME_STYLES,
    label: (o) => t(`DP.frame.${o}`),
  },
  {
    path: "hud.marks",
    key: "DP.presets.hudMarks",
    options: HUD_MARKS,
    label: (o) => t(`DP.hudMarks.${o}`),
  },
  {
    path: "hud.grid",
    key: "DP.presets.hudGrid",
    options: HUD_GRIDS,
    label: (o) => t(`DP.hudGrid.${o}`),
  },
];

/**
 * The parameters, by the layer of the effect they shape.
 *
 * They used to be one column of twenty-eight controls in no order a GM could predict,
 * with the layers a preset does not use sitting at zero among the ones it does. Each
 * layer is now a disclosure, open when the preset uses it — so a shipped preset opens on
 * the handful of settings that make it what it is — and a GM's own opening and closing
 * is remembered while the window is open.
 */
export const GROUPS: {
  id: string;
  key: string;
  paths: string[];
  inUse: (p: DpPreset["params"]) => boolean;
}[] = [
  {
    id: "surface",
    key: "DP.presets.group.surface",
    paths: ["tint.color", "tint.amount", "surface.opacity", "noise.amount", "noise.scale"],
    inUse: (p) => p.tint.amount > 0 || p.surface.opacity > 0 || p.noise.amount > 0,
  },
  {
    id: "type",
    key: "DP.presets.group.type",
    paths: ["type.family"],
    inUse: (p) => p.type.family !== null,
  },
  {
    id: "edges",
    key: "DP.presets.group.edges",
    paths: [
      "edge.style",
      "edge.amount",
      "frame.style",
      "frame.color",
      "frame.thickness",
      "shadow.opacity",
    ],
    inUse: (p) =>
      (p.edge.style !== "none" && p.edge.amount > 0) ||
      (p.frame.style !== "none" && p.frame.thickness > 0) ||
      p.shadow.opacity > 0,
  },
  {
    id: "glow",
    key: "DP.presets.group.glow",
    paths: ["glow.color", "glow.radius", "glow.opacity", "glow.pulseHz"],
    inUse: (p) => p.glow.opacity > 0 && p.glow.radius > 0,
  },
  {
    id: "lens",
    key: "DP.presets.group.lens",
    paths: ["blur", "chroma.offset", "jitter.amount", "flicker.amount"],
    inUse: (p) => p.blur > 0 || p.chroma.offset > 0 || p.jitter.amount > 0 || p.flicker.amount > 0,
  },
  {
    id: "scanlines",
    key: "DP.presets.group.scanlines",
    paths: ["scanlines.spacing", "scanlines.opacity"],
    inUse: (p) => p.scanlines.opacity > 0,
  },
  {
    id: "projection",
    key: "DP.presets.group.projection",
    paths: [
      "hud.color",
      "hud.opacity",
      "hud.marks",
      "hud.grid",
      "hud.pitch",
      "hud.weight",
      "hud.sweepSec",
    ],
    inUse: (p) => p.hud.opacity > 0,
  },
];

/** What the window knows beyond the preset itself. */
export interface PresetStudioContext {
  /** The GM's own opening and closing of a layer, when there is one; else it follows use. */
  isOpen?: (groupId: string) => boolean | undefined;
  /** The pin the studio was opened from, so a preset can be put on it from here. */
  target?: { name: string; effectId: string } | null;
  /** The world's own font families, resolved by the window so this markup stays pure. */
  fonts?: string[];
}

/** PURE. Read a dotted path out of a preset's parameters. */
export function readParam(preset: DpPreset, path: string): number {
  const value = path
    .split(".")
    .reduce<any>((node, key) => (node == null ? undefined : node[key]), preset.params);
  return typeof value === "number" ? value : 0;
}

/** PURE. Read a dotted path as a string — a colour or an enum member. */
function readParamText(preset: DpPreset, path: string): string {
  const value = path
    .split(".")
    .reduce<any>((node, key) => (node == null ? undefined : node[key]), preset.params);
  return typeof value === "string" ? value : "";
}

/** PURE. Write a dotted path, returning a new preset. */
export function writeParam(
  preset: DpPreset,
  path: string,
  value: number | string | null
): DpPreset {
  const keys = path.split(".");
  const params: any = structuredClone(preset.params);

  let node = params;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys[keys.length - 1]] = value;

  return { ...preset, params };
}

function listMarkup(presets: readonly DpPreset[], selectedId: string): string {
  const item = (preset: DpPreset) =>
    `<li><button type="button" class="dp-presets__item" data-action="select"` +
    ` data-dp-preset="${escapeAttr(preset.id)}" aria-pressed="${preset.id === selectedId}">` +
    `<span class="dp-presets__name">${escapeHtml(t(preset.label))}</span>` +
    (preset.author === "core"
      ? `<i class="fa-solid fa-lock" aria-hidden="true" title="${escapeAttr(t("DP.presets.readOnly"))}"></i>`
      : "") +
    `</button></li>`;

  return (
    `<ul class="dp-presets__list" aria-label="${escapeAttr(t("DP.presets.library"))}">` +
    presets.map(item).join("") +
    `</ul>`
  );
}

function previewMarkup(preset: DpPreset, backdrop: Backdrop, frozen: boolean): string {
  const dressed = dressing({
    preset,
    intensity: 1,
    seed: 1,
    tier: "L2b",
    level: frozen ? "reduced" : currentLevel(),
    baked: false,
  });

  const swatches = BACKDROPS.map(
    (b) =>
      `<button type="button" class="dp-presets__bg" data-action="setBackdrop"` +
      ` data-dp-bg="${b.id}" aria-pressed="${b.id === backdrop}">${escapeHtml(t(b.key))}</button>`
  ).join("");

  const attrs = Object.entries(dressed.attrs)
    .map(([key, value]) => ` ${escapeAttr(key)}="${escapeAttr(value)}"`)
    .join("");
  // The face goes on the card by hand, as the resolver puts it on a pin's: it is not in
  // the dressing, so a preview built from the dressing alone would show the house face.
  const font = fontStack(preset.params.type.family);
  const style = font ? `${dressed.style};--dp-font:${font}` : dressed.style;

  return (
    `<div class="dp-presets__preview" data-dp-bg="${backdrop}">` +
    `<div class="dp-card"${attrs} style="${escapeAttr(style)}">` +
    `<div class="dp-card__sheet">` +
    `<h1 class="dp-card__title">${escapeHtml(t(preset.label))}</h1>` +
    `<div class="dp-card__body"><p>${escapeHtml(t("DP.presets.sample"))}</p></div>` +
    `</div></div></div>` +
    `<div class="dp-presets__bgs" role="group" aria-label="${escapeAttr(t("DP.presets.backdrop"))}">` +
    swatches +
    `<button type="button" data-action="toggleFreeze" aria-pressed="${frozen}">` +
    `${escapeHtml(t("DP.presets.freeze"))}</button>` +
    `</div>`
  );
}

function sliderMarkup(preset: DpPreset, path: string, editable: boolean): string {
  const slider = SLIDERS.find((entry) => entry.path === path)!;
  const value = readParam(preset, slider.path);
  return (
    `<label class="dp-presets__param">` +
    `<span>${escapeHtml(t(slider.key))}</span>` +
    `<input type="range" name="${escapeAttr(slider.path)}" min="${slider.min}"` +
    ` max="${slider.max}" step="${slider.step}" value="${value}"` +
    `${editable ? "" : " disabled"}>` +
    `<output>${Math.round(value * 100) / 100}</output>` +
    `</label>`
  );
}

function colourMarkup(preset: DpPreset, path: string, editable: boolean): string {
  const entry = COLOURS.find((colour) => colour.path === path)!;
  const value = readParamText(preset, entry.path) || "#ffffff";
  return (
    `<label class="dp-presets__param">` +
    `<span>${escapeHtml(t(entry.key))}</span>` +
    // A colour input rather than a text field: it accepts only `#rrggbb`, which is
    // exactly the subset `HEX` allows, so the control cannot produce a bad value.
    `<input type="color" name="${escapeAttr(entry.path)}" value="${escapeAttr(value.slice(0, 7))}"` +
    `${editable ? "" : " disabled"}>` +
    `<output>${escapeHtml(value)}</output>` +
    `</label>`
  );
}

function choiceMarkup(preset: DpPreset, path: string, editable: boolean): string {
  const entry = CHOICES.find((choice) => choice.path === path)!;
  const value = readParamText(preset, entry.path);
  const options = entry.options
    .map(
      (option) =>
        `<option value="${escapeAttr(option)}"${option === value ? " selected" : ""}>` +
        `${escapeHtml(entry.label(option))}</option>`
    )
    .join("");
  return (
    `<label class="dp-presets__param">` +
    `<span>${escapeHtml(t(entry.key))}</span>` +
    `<select name="${escapeAttr(entry.path)}"${editable ? "" : " disabled"}>${options}</select>` +
    `</label>`
  );
}

/**
 * The typeface, from the same list the Pin Studio offers. The empty choice is the card's
 * own face, which is what a preset without one has always drawn in.
 */
function fontMarkup(preset: DpPreset, editable: boolean, fonts: readonly string[]): string {
  const items = fontOptionsMarkup(
    fontChoices(fonts),
    preset.params.type.family,
    t("DP.presets.typeDefault"),
    (name) => fontLabel(name, t)
  );
  return (
    `<label class="dp-presets__param">` +
    `<span>${escapeHtml(t("DP.presets.typeFamily"))}</span>` +
    `<select name="type.family"${editable ? "" : " disabled"}>${items}</select>` +
    `</label>`
  );
}

function controlMarkup(
  preset: DpPreset,
  path: string,
  editable: boolean,
  context: PresetStudioContext
): string {
  if (path === "type.family") return fontMarkup(preset, editable, context.fonts ?? []);
  if (COLOURS.some((entry) => entry.path === path)) return colourMarkup(preset, path, editable);
  if (CHOICES.some((entry) => entry.path === path)) return choiceMarkup(preset, path, editable);
  return sliderMarkup(preset, path, editable);
}

function paramsMarkup(
  preset: DpPreset,
  editable: boolean,
  context: PresetStudioContext = {}
): string {
  const cost = estimateCost(preset);

  const groups = GROUPS.map((group) => {
    const used = group.inUse(preset.params);
    const open = context.isOpen?.(group.id) ?? used;
    return (
      `<details class="dp-presets__group" data-dp-group="${group.id}"${open ? " open" : ""}>` +
      `<summary data-dp-focus-key="group-${group.id}">${escapeHtml(t(group.key))}` +
      (used
        ? ""
        : ` <span class="dp-presets__unused">${escapeHtml(t("DP.presets.unused"))}</span>`) +
      `</summary>` +
      group.paths.map((path) => controlMarkup(preset, path, editable, context)).join("") +
      `</details>`
    );
  }).join("");

  // A user preset can be named. A duplicate used to be "(copy)" forever, because there
  // was no name field anywhere in the window.
  const name = editable
    ? `<label class="dp-presets__param dp-presets__name-field">` +
      `<span>${escapeHtml(t("DP.presets.name"))}</span>` +
      `<input type="text" name="_label" value="${escapeAttr(preset.label)}" maxlength="64">` +
      `</label>`
    : "";

  return (
    `<div class="dp-presets__params">` +
    (editable
      ? ""
      : `<p class="dp-presets__locked">${escapeHtml(t("DP.presets.readOnlyHint"))}</p>`) +
    name +
    groups +
    `<p class="dp-presets__cost" data-dp-cost="${escapeAttr(cost.tier)}">` +
    escapeHtml(t("DP.presets.cost", { tier: t(`DP.cost.${cost.tier}`), score: cost.score })) +
    `</p></div>`
  );
}

/**
 * The way back to the pin the studio was opened from.
 *
 * A GM who duplicated a preset from a pin's gallery, tuned the copy and closed the window
 * found the pin still wearing the original: nothing here could put the copy on it, and
 * the gallery was two windows away. Now the studio names the pin and offers the preset
 * that is showing.
 */
function useOnPinMarkup(selected: DpPreset, target: PresetStudioContext["target"]): string {
  if (!target) return "";
  if (target.effectId === selected.id) {
    return (
      `<p class="dp-presets__using">` +
      `${escapeHtml(t("DP.presets.inUseOn", { name: target.name }))}</p>`
    );
  }
  return (
    `<button type="button" class="dp-presets__use" data-action="useOnPin">` +
    `${escapeHtml(t("DP.presets.useOn", { name: target.name }))}</button>`
  );
}

export function presetStudioMarkup(
  presets: readonly DpPreset[],
  selected: DpPreset,
  backdrop: Backdrop,
  frozen: boolean,
  context: PresetStudioContext = {}
): string {
  const editable = selected.author !== "core";
  return (
    `<div class="dp-presets">` +
    `<div class="dp-presets__pane dp-presets__pane--list">` +
    listMarkup(presets, selected.id) +
    `<div class="dp-presets__actions">` +
    `<button type="button" data-action="duplicate">${escapeHtml(t("DP.presets.duplicate"))}</button>` +
    `<button type="button" data-action="import">${escapeHtml(t("DP.presets.import"))}</button>` +
    `<button type="button" data-action="export">${escapeHtml(t("DP.presets.export"))}</button>` +
    (editable
      ? `<button type="button" class="dp-danger" data-action="remove">${escapeHtml(t("DP.presets.delete"))}</button>`
      : "") +
    `</div></div>` +
    `<div class="dp-presets__pane dp-presets__pane--preview">` +
    previewMarkup(selected, backdrop, frozen) +
    useOnPinMarkup(selected, context.target) +
    `</div>` +
    `<div class="dp-presets__pane dp-presets__pane--params">` +
    paramsMarkup(selected, editable, context) +
    `</div></div>`
  );
}

export function definePresetStudio(): any {
  if (StudioClass) return StudioClass;

  const ApplicationV2 = ns("applications.api.ApplicationV2");
  if (!ApplicationV2) return null;

  StudioClass = class PresetStudio extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "dp-preset-studio",
      classes: ["dp-scope", "dp-presets-app"],
      tag: "section",
      window: {
        title: "DP.presets.title",
        icon: "fa-solid fa-wand-magic-sparkles",
        resizable: true,
      },
      position: { width: 760, height: 560 },
      actions: {
        select: onSelect,
        setBackdrop: onSetBackdrop,
        toggleFreeze: onToggleFreeze,
        duplicate: onDuplicate,
        remove: onRemove,
        import: onImport,
        export: onExport,
        useOnPin: onUseOnPin,
      },
    };

    selectedId = "aged-parchment";
    backdrop: Backdrop = "map";
    frozen = false;
    /** The pin this window was opened from, if any. */
    forDoc: any = null;
    /** The layers the GM opened or closed by hand, by preset and layer. */
    groupState = new Map<string, boolean>();

    get selected(): DpPreset {
      return library.findPreset(this.selectedId) ?? library.allPresets()[0];
    }

    async _renderHTML() {
      const wrapper = document.createElement("div");
      const selected = this.selected;
      const pin = this.forDoc ? readPin(this.forDoc) : null;
      wrapper.innerHTML = presetStudioMarkup(
        library.allPresets(),
        selected,
        this.backdrop,
        this.frozen,
        {
          isOpen: (group) => this.groupState.get(`${selected.id}:${group}`),
          target: pin ? { name: api.labelFor(pin), effectId: pin.effect.id } : null,
          fonts: registeredFontFamilies(),
        }
      );
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Every change saves the preset and re-renders, which used to drop the focus: a
      // slider moved with the arrow keys commits on each step, so it moved one step.
      const focus = snapshotFocus(content);
      content.replaceChildren(result);
      restoreFocus(content, focus);

      // `toggle` does not bubble, so it is caught on the way down.
      result.addEventListener(
        "toggle",
        (event) => {
          const details = event.target as HTMLDetailsElement;
          const group = details?.dataset?.dpGroup;
          if (group) this.groupState.set(`${this.selected.id}:${group}`, details.open);
        },
        true
      );

      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      result.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input?.type !== "range") return;
        const output = input.nextElementSibling;
        if (output?.tagName === "OUTPUT") output.textContent = input.value;
      });

      result.addEventListener("change", (event) => {
        const input = event.target as HTMLInputElement;
        if (input?.name === "_label") {
          void this.#rename(input.value);
          return;
        }
        if (input.disabled || !input.name) return;
        if (input.type === "range") {
          void this.#setParam(input.name, Number(input.value));
          return;
        }
        // The typeface's empty choice is "none", which the schema stores as null.
        if (input.name === "type.family") {
          void this.#setParam(input.name, input.value || null);
          return;
        }
        // A colour and an enum both arrive as strings; `validatePreset` decides whether
        // either is one this version understands.
        if (input.type === "color" || input.tagName === "SELECT") {
          void this.#setParam(input.name, input.value);
        }
      });
    }

    async #rename(label: string) {
      const preset = this.selected;
      const next = label.trim().slice(0, 64);
      if (preset.author === "core" || !next || next === preset.label) return;
      await library.savePreset({ ...preset, label: next });
      this.render();
    }

    async #setParam(path: string, value: number | string | null) {
      const preset = this.selected;
      if (preset.author === "core") return;
      await library.savePreset(writeParam(preset, path, value));
      this.render();
    }
  };

  return StudioClass;
}

function onSelect(this: any, _event: Event, target: HTMLElement) {
  this.selectedId = target.dataset.dpPreset ?? this.selectedId;
  this.render();
}

function onSetBackdrop(this: any, _event: Event, target: HTMLElement) {
  this.backdrop = (target.dataset.dpBg ?? "map") as Backdrop;
  this.render();
}

/** Freeze motion while authoring: a still frame is the only way to judge a still look. */
function onToggleFreeze(this: any) {
  this.frozen = !this.frozen;
  this.render();
}

async function onDuplicate(this: any) {
  const copy = await library.duplicatePreset(this.selectedId);
  if (copy) this.selectedId = copy.id;
  this.render();
}

async function onRemove(this: any) {
  const DialogV2 = ns("applications.api.DialogV2");
  const confirmed = DialogV2?.confirm
    ? await DialogV2.confirm({
        window: { title: t("DP.presets.delete") },
        content: `<p>${escapeHtml(t("DP.presets.deleteBody"))}</p>`,
      }).catch(() => false)
    : false;
  if (!confirmed) return;

  await library.deletePreset(this.selectedId);
  this.selectedId = "aged-parchment";
  this.render();
}

/**
 * Import by paste.
 *
 * Paste rather than a file picker as the primary route, because presets are meant to
 * be shared in a chat window and pasted straight in — a round trip through a saved
 * file is friction on the gesture the format exists for.
 */
async function onImport(this: any) {
  const DialogV2 = ns("applications.api.DialogV2");
  if (!DialogV2?.prompt) return;

  const json = await DialogV2.prompt({
    window: { title: t("DP.presets.import") },
    content: `<textarea name="json" rows="8" style="width:100%"></textarea>`,
    ok: { callback: (_e: any, button: any) => button.form.elements.json.value },
  }).catch(() => null);
  if (!json) return;

  const imported = await library.importPreset(json);
  if (imported) this.selectedId = imported.id;
  this.render();
}

async function onExport(this: any) {
  const json = library.exportPreset(this.selected);
  try {
    await navigator.clipboard.writeText(json);
    (globalThis as any).ui?.notifications?.info?.(t("DP.presets.copied"));
  } catch {
    // Clipboard access can be refused; show the JSON so it can still be copied by hand.
    const DialogV2 = ns("applications.api.DialogV2");
    void DialogV2?.prompt?.({
      window: { title: t("DP.presets.export") },
      content: `<textarea rows="12" style="width:100%">${escapeHtml(json)}</textarea>`,
    });
  }
}

/** Put the preset that is showing on the pin the studio was opened from. */
async function onUseOnPin(this: any) {
  if (!this.forDoc) return;
  await api.setEffect(this.forDoc, this.selectedId);
  this.render();
}

/**
 * Open the studio, on a given preset when one is named — from the galleries — and for
 * the pin it was opened from, when there is one. Opened from the settings menu, it is
 * for no pin, and forgets the last one.
 */
export function openPresetStudio(id?: string, doc?: any): any {
  const Studio = definePresetStudio();
  if (!Studio) return null;
  instance ??= new Studio();
  if (id && library.findPreset(id)) instance.selectedId = id;
  instance.forDoc = doc ?? null;
  instance.render(true);
  return instance;
}
