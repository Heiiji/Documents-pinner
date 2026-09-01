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
import * as library from "../effects/preset-library";
import { dressing } from "../effects/EffectRegistry";
import { estimateCost, validatePreset, type DpPreset } from "../effects/preset-schema";
import { currentLevel } from "../effects/level";

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
];

/** PURE. Read a dotted path out of a preset's parameters. */
export function readParam(preset: DpPreset, path: string): number {
  const value = path
    .split(".")
    .reduce<any>((node, key) => (node == null ? undefined : node[key]), preset.params);
  return typeof value === "number" ? value : 0;
}

/** PURE. Write a dotted path, returning a new preset. */
export function writeParam(preset: DpPreset, path: string, value: number): DpPreset {
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

  return (
    `<div class="dp-presets__preview" data-dp-bg="${backdrop}">` +
    `<div class="dp-card"${attrs} style="${escapeAttr(dressed.style)}">` +
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

function paramsMarkup(preset: DpPreset, editable: boolean): string {
  const cost = estimateCost(preset);
  const sliders = SLIDERS.map((slider) => {
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
    sliders +
    `<p class="dp-presets__cost" data-dp-cost="${escapeAttr(cost.tier)}">` +
    escapeHtml(t("DP.presets.cost", { tier: t(`DP.cost.${cost.tier}`), score: cost.score })) +
    `</p></div>`
  );
}

export function presetStudioMarkup(
  presets: readonly DpPreset[],
  selected: DpPreset,
  backdrop: Backdrop,
  frozen: boolean
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
    `</div>` +
    `<div class="dp-presets__pane dp-presets__pane--params">` +
    paramsMarkup(selected, editable) +
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
      },
    };

    selectedId = "aged-parchment";
    backdrop: Backdrop = "map";
    frozen = false;

    get selected(): DpPreset {
      return library.findPreset(this.selectedId) ?? library.allPresets()[0];
    }

    async _renderHTML() {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = presetStudioMarkup(
        library.allPresets(),
        this.selected,
        this.backdrop,
        this.frozen
      );
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      content.replaceChildren(result);

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
        if (input?.type !== "range" || input.disabled) return;
        void this.#setParam(input.name, Number(input.value));
      });
    }

    async #rename(label: string) {
      const preset = this.selected;
      const next = label.trim().slice(0, 64);
      if (preset.author === "core" || !next || next === preset.label) return;
      await library.savePreset({ ...preset, label: next });
      this.render();
    }

    async #setParam(path: string, value: number) {
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

/** Open the studio, on a given preset when one is named — from the galleries. */
export function openPresetStudio(id?: string): any {
  const Studio = definePresetStudio();
  if (!Studio) return null;
  instance ??= new Studio();
  if (id && library.findPreset(id)) instance.selectedId = id;
  instance.render(true);
  return instance;
}

export { validatePreset };
