/**
 * Pin Studio — everything about one pin.
 *
 * IMPURE. A bespoke ApplicationV2, deliberately NOT a tab bolted onto the core Tile
 * config: there are more than twenty controls and a live preview here, none of which
 * fit a sheet built for a tile's geometry, and mutating a core class's `static PARTS`
 * to make room would be monkey-patching a class other modules also extend.
 *
 * The interaction model is the point:
 *
 * - **No Save button.** `submitOnChange` with `closeOnSubmit: false` means every change
 *   lands on the canvas as it is made. A GM adjusting an effect against a specific map
 *   is asking "does this read *here*", and a dialog that answers only after you commit
 *   and reopen cannot answer it at all.
 * - **Three tabs, one question each.** Content is what it says, Appearance is what it
 *   looks like, Audience is who gets it. Nothing that belongs to one appears in another.
 * - **The audience tab is the same chip widget as the HUD and the Pinboard.** A GM
 *   should never have to learn a second vocabulary for the module's central idea.
 */

import { MODULE_ID } from "../const";
import { cv, ns } from "../fvtt";
import { previewIntensity } from "../canvas/DomPropTier";
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import { readPin } from "../data/PinData";
import { cardMetrics, freezeMetrics } from "../data/pin-schema";
import { PAPERS } from "../render/CardTemplate";
import { allPresets } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { pdfPageCount, pdfSourceOf } from "../render/PdfPage";
import { chipsMarkup, describeChips } from "./chips";
import { openPicker } from "./DocumentPicker";
import { chipUsersFor } from "./PinHUD";
import type { DpPinFlags, DpSource } from "../types/dp";

let StudioClass: any = null;
const open = new Map<string, any>();

type TabId = "content" | "appearance" | "audience";

const TABS: { id: TabId; key: string; icon: string }[] = [
  { id: "content", key: "DP.studio.tabContent", icon: "fa-file-lines" },
  { id: "appearance", key: "DP.studio.tabAppearance", icon: "fa-palette" },
  { id: "audience", key: "DP.studio.tabAudience", icon: "fa-users" },
];

// ---------------------------------------------------------------------------
// Field helpers — one markup shape per control type, so the form stays consistent
// ---------------------------------------------------------------------------

function field(labelKey: string, control: string, hintKey?: string): string {
  return (
    `<label class="dp-studio__field">` +
    `<span class="dp-studio__label">${escapeHtml(t(labelKey))}</span>` +
    control +
    (hintKey ? `<span class="dp-studio__hint">${escapeHtml(t(hintKey))}</span>` : "") +
    `</label>`
  );
}

/**
 * The Appearance controls a PDF prop cannot honour.
 *
 * They were dimmed by a `:has()` rule carrying `pointer-events: none`, which stops a
 * mouse and not a keyboard — in ANY engine — so a GM tabbing through the tab could still
 * move a slider that would do nothing. The stylesheet keeps the dimming as presentation;
 * the markup carries the state. A15's rule, applied to a browser rather than a feature.
 */
const PDF_INERT = new Set([
  "display.paper",
  "display.typeSize",
  "display.margin",
  "effect.speed",
  "effect.motion",
]);

const inert = (name: string, pdf: boolean) => (pdf && PDF_INERT.has(name) ? " disabled" : "");

function select(
  name: string,
  value: string,
  options: { value: string; label: string }[],
  pdf = false
): string {
  const items = options
    .map(
      (o) =>
        `<option value="${escapeAttr(o.value)}"${o.value === value ? " selected" : ""}>` +
        `${escapeHtml(o.label)}</option>`
    )
    .join("");
  return `<select name="${escapeAttr(name)}"${inert(name, pdf)}>${items}</select>`;
}

function checkbox(name: string, checked: boolean): string {
  return `<input type="checkbox" name="${escapeAttr(name)}"${checked ? " checked" : ""}>`;
}

function range(name: string, value: number, min = 0, max = 1, step = 0.05, pdf = false): string {
  return (
    `<input type="range" name="${escapeAttr(name)}" min="${min}" max="${max}" step="${step}"` +
    ` value="${value}"${inert(name, pdf)}><output>${Math.round(value * 100) / 100}</output>`
  );
}

function text(name: string, value: string, placeholderKey?: string): string {
  return (
    `<input type="text" name="${escapeAttr(name)}" value="${escapeAttr(value)}"` +
    (placeholderKey ? ` placeholder="${escapeAttr(t(placeholderKey))}"` : "") +
    `>`
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Everything the Content tab needs that a Foundry global would otherwise be asked for.
 *
 * Resolved by `_renderHTML`, which is already async, and passed in — so `studioMarkup`
 * stays a pure function of its arguments and the tests can call it with no world at all.
 * A page list looked up inside the markup would end that, and the PDF page count is a
 * promise besides.
 */
export interface StudioOptions {
  aspectLocked?: boolean;
  /** Pages the GM may choose between, from the entry this pin's uuid names. */
  pages?: { id: string; name: string; type: string }[];
  /** How many pages the PDF behind this pin has, or 0 while that is not known. */
  pdfPages?: number;
}

function contentTab(pin: DpPinFlags, options: StudioOptions): string {
  const source = api.resolveSourceSync(pin);
  const isPage = source?.documentName === "JournalEntryPage";
  const pages = options.pages ?? [];

  // Removed rather than disabled, unlike the PDF-inert controls on the Appearance tab.
  // A15 disabled a whole tab because a blank tab reads as broken; one absent field among
  // six reads as "not applicable", which is what it is.
  const pageField = pages.length
    ? field(
        "DP.studio.page",
        select("source.pageId", pin.source.pageId ?? "", [
          { value: "", label: t("DP.studio.pageFirst") },
          ...pages.map((page) => ({
            value: page.id,
            // The raw page type beside the name, only where it disambiguates: two pages
            // called "Map" can be a text page and an image, and the list cannot say which.
            label: page.type === "text" ? page.name : `${page.name} (${page.type})`,
          })),
        ]),
        "DP.studio.pageHint"
      )
    : isPage
      ? `<p class="dp-studio__note">${escapeHtml(t("DP.studio.pageIsOne"))}</p>`
      : "";

  const pdfField = isPdfPin(pin)
    ? field(
        "DP.studio.pdfPage",
        `<input type="number" name="source.pdfPage" min="1"` +
          (options.pdfPages ? ` max="${options.pdfPages}"` : "") +
          ` step="1" value="${pin.source.pdfPage ?? 1}">`,
        "DP.studio.pdfPageHint"
      )
    : "";

  return (
    `<section class="dp-studio__tab" data-dp-tab="content">` +
    // The source, which page of it, and the way to change it — one block about the
    // document, before the block about the pin.
    `<div class="dp-studio__sourcebox">` +
    `<p class="dp-studio__source">` +
    `<i class="fa-solid fa-link" aria-hidden="true"></i> ` +
    escapeHtml(source?.name ?? pin.source.src ?? t("DP.studio.sourceMissing")) +
    `</p>` +
    `<button type="button" class="dp-studio__link" data-action="retargetSource">` +
    `${escapeHtml(t("DP.studio.retarget"))}</button>` +
    `<span class="dp-studio__hint">${escapeHtml(t("DP.studio.retargetHint"))}</span>` +
    `</div>` +
    pageField +
    pdfField +
    field(
      "DP.studio.label",
      text("display.label", pin.display.label, "DP.studio.labelPlaceholder"),
      "DP.studio.labelHint"
    ) +
    field(
      "DP.studio.followName",
      checkbox("source.followName", pin.source.followName),
      "DP.studio.followNameHint"
    ) +
    field("DP.studio.showTitle", checkbox("display.showTitle", pin.display.showTitle)) +
    field(
      "DP.studio.open",
      select("interaction.open", pin.interaction.open, [
        { value: "double", label: t("DP.studio.openDouble") },
        { value: "single", label: t("DP.studio.openSingle") },
        { value: "readInPlace", label: t("DP.studio.openInPlace") },
        { value: "never", label: t("DP.studio.openNever") },
      ])
    ) +
    field("DP.studio.tooltip", text("interaction.tooltip", pin.interaction.tooltip)) +
    `</section>`
  );
}

/**
 * A PDF page is painted by pdf.js straight into a texture — no card, no paper, no CSS.
 *
 * So every appearance control below is inert for one: the paper stock, the type size,
 * the margins and anything that moves all describe a card that a PDF prop does not
 * have. Offering controls that cannot be honoured is worse than not offering them, so
 * they are disabled and the reason is stated where the GM is looking.
 */
function isPdfPin(pin: DpPinFlags): boolean {
  return pdfSourceOf(api.resolveSourceSync(pin)) !== null;
}

/** How many pages the PDF behind this pin has, or 0 when there is no answer. */
async function pdfPageCountFor(pin: DpPinFlags): Promise<number> {
  const src = pdfSourceOf(api.resolveSourceSync(pin));
  if (!src) return 0;
  try {
    return await pdfPageCount(src);
  } catch {
    return 0;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function appearanceTab(doc: any, pin: DpPinFlags): string {
  // The EFFECTIVE metrics, so a pin that predates stored type sizes shows the size it
  // is actually drawn at rather than an empty slider; the first edit freezes both.
  const size = { width: Number(doc?.width) || 1, height: Number(doc?.height) || 1 };
  const metrics = cardMetrics(pin.display, size);
  const marginEm = metrics.padPx / metrics.fontPx;

  // The whole library, so a preset a GM authored can actually be assigned to a pin.
  // The preset's OWN variables, so a GM can tell Glitch from Torn Edges without applying
  // it. Every swatch used to be the same beige rectangle: the markup carried a preset id
  // and nothing anywhere styled from it, so the gallery was name-only in both live
  // surfaces while `presetToCssVars` sat one import away.
  const swatches = allPresets()
    .map(
      (preset) =>
        `<button type="button" class="dp-studio__swatch" data-action="setEffect"` +
        ` data-dp-preset="${escapeAttr(preset.id)}" aria-pressed="${pin.effect.id === preset.id}">` +
        `<span class="dp-studio__swatch-preview dp-card" data-dp-fx="${escapeAttr(preset.id)}"` +
        ` aria-hidden="true" style="${escapeAttr(swatchStyle(preset))}"></span>` +
        // Named, because the grid declares a `name` area. Without the class this span was
        // auto-placed, landed on top of the cost label, and every swatch read as
        // "LégerSceau de cire" with the two strings overlapping.
        `<span class="dp-studio__swatch-name">${escapeHtml(t(preset.label))}</span>` +
        `<span class="dp-studio__cost" data-dp-cost="${escapeAttr(preset.cost)}">` +
        `${escapeHtml(t(`DP.cost.${preset.cost}`))}</span>` +
        `</button>`
    )
    .join("");

  const pdf = isPdfPin(pin);
  const inert = pdf
    ? `<p class="dp-studio__note">${escapeHtml(t("DP.studio.pdfAppearance"))}</p>`
    : "";

  return (
    `<section class="dp-studio__tab" data-dp-tab="appearance"${pdf ? ' data-dp-pdf="true"' : ""}>` +
    inert +
    field(
      "DP.studio.mode",
      select("mode", pin.mode, [
        { value: "prop", label: t("DP.settings.defaultMode.prop") },
        { value: "pin", label: t("DP.settings.defaultMode.pin") },
      ])
    ) +
    field(
      "DP.studio.paper",
      select(
        "display.paper",
        pin.display.paper,
        Object.keys(PAPERS).map((id) => ({ value: id, label: t(`DP.paper.${id}`) })),
        pdf
      )
    ) +
    field(
      "DP.studio.typeSize",
      range("display.typeSize", round2(metrics.fontPx), 6, 72, 0.5, pdf),
      "DP.studio.typeSizeHint"
    ) +
    field(
      "DP.studio.margin",
      range("display.margin", round2(marginEm), 0, 6, 0.1, pdf),
      "DP.studio.marginHint"
    ) +
    `<div class="dp-studio__swatches" role="group" aria-label="${escapeAttr(t("DP.studio.effect"))}">` +
    swatches +
    `</div>` +
    `<button type="button" class="dp-studio__link" data-action="editPresets">` +
    `${escapeHtml(t("DP.presets.edit"))}</button>` +
    field("DP.studio.intensity", range("effect.intensity", pin.effect.intensity)) +
    field("DP.studio.speed", range("effect.speed", pin.effect.speed, 0, 4, 0.1, pdf)) +
    field(
      "DP.studio.motion",
      // `onReveal` is not offered: nothing implements a play-once animation, and the
      // renderer treats it exactly as `loop`. A third choice that behaves like the first
      // is a control that does not work.
      select(
        "effect.motion",
        pin.effect.motion === "none" ? "none" : "loop",
        [
          { value: "loop", label: t("DP.studio.motionLoop") },
          { value: "none", label: t("DP.studio.motionNone") },
        ],
        pdf
      )
    ) +
    field(
      "DP.studio.fadeUnderTokens",
      checkbox("display.fadeUnderTokens", pin.display.fadeUnderTokens),
      "DP.studio.fadeUnderTokensHint"
    ) +
    field(
      "DP.studio.fadeAlpha",
      range("display.fadeUnderTokensAlpha", pin.display.fadeUnderTokensAlpha)
    ) +
    `</section>`
  );
}

function audienceTab(doc: any, pin: DpPinFlags): string {
  const users = chipUsersFor(doc);
  return (
    `<section class="dp-studio__tab" data-dp-tab="audience">` +
    field(
      "DP.studio.audience",
      // `discovered` is deliberately NOT offered. Its visibility half works — each client
      // tests its own line of sight — but the sticky half needs a player's discovery to be
      // PERSISTED, and players never write pin configuration (DESIGN §3) while the module
      // ships no socket (DESIGN §8). So `discovered` stayed permanently empty,
      // `grantKeysFor` returned nothing, and ownership sync could never fire: a permanent
      // "visible but won't open" for an audience kind the Studio was offering. See A9.
      select("audience.kind", pin.audience.kind, [
        { value: "everyone", label: t("DP.audience.everyone") },
        { value: "selected", label: t("DP.hud.audienceSome") },
        { value: "hidden", label: t("DP.audience.hidden") },
      ])
    ) +
    chipsMarkup(users, { t: tn }) +
    `<p class="dp-studio__status" aria-live="polite">${escapeHtml(tn(describeChips(users)))}</p>` +
    field(
      "DP.studio.sync",
      checkbox("audience.ownershipSync.enabled", pin.audience.ownershipSync.enabled),
      "DP.studio.syncHint"
    ) +
    field(
      "DP.studio.syncLevel",
      select("audience.ownershipSync.level", String(pin.audience.ownershipSync.level), [
        { value: "2", label: t("DP.studio.syncObserver") },
        { value: "1", label: t("DP.studio.syncLimited") },
      ]),
      "DP.studio.syncLevelHint"
    ) +
    // No "remember who has discovered it": `audience.sticky` is read only under the
    // `discovered` kind, which this tab deliberately does not offer (A9), so the box was
    // a control that could not be honoured.
    `</section>`
  );
}

/** The grid the anchor's scene uses, so sizes can be shown in squares. */
function gridOf(doc: any): number {
  return doc?.parent?.grid?.size ?? cv()?.scene?.grid?.size ?? 100;
}

const squares = (px: number, grid: number) => Math.round((px / grid) * 100) / 100;

export function studioMarkup(
  doc: any,
  pin: DpPinFlags,
  active: TabId,
  options: StudioOptions = {}
): string {
  const grid = gridOf(doc);
  const nav = TABS.map(
    (tab) =>
      `<button type="button" class="dp-studio__tabbtn" data-action="setTab"` +
      ` data-dp-tab="${tab.id}" role="tab" aria-selected="${tab.id === active}">` +
      `<i class="fa-solid ${tab.icon}" aria-hidden="true"></i> ${escapeHtml(t(tab.key))}</button>`
  ).join("");

  const body =
    active === "content"
      ? contentTab(pin, options)
      : active === "appearance"
        ? appearanceTab(doc, pin)
        : audienceTab(doc, pin);

  return (
    `<div class="dp-studio">` +
    `<nav class="dp-studio__tabs" role="tablist">${nav}</nav>` +
    body +
    // Always visible, on every tab: geometry is the question a GM asks while looking
    // at any of the others, and hiding it behind a tab would mean leaving the effect
    // they are judging to answer it.
    `<footer class="dp-studio__strip">` +
    `<div class="dp-studio__strip-row">` +
    `<label>${escapeHtml(t("DP.studio.elevation"))}` +
    `<input type="number" name="_elevation" value="${Number(doc.elevation ?? 0)}" step="1"></label>` +
    `<label>${escapeHtml(t("DP.studio.rotation"))}` +
    `<input type="number" name="_rotation" value="${Number(doc.rotation ?? 0)}" step="15"></label>` +
    // In grid squares, which is how a GM thinks about a map: "four squares wide".
    `<label>${escapeHtml(t("DP.studio.width"))}` +
    `<input type="number" name="_width" value="${squares(Number(doc.width) || 0, grid)}"` +
    ` step="0.5" min="0.05"></label>` +
    `<label>${escapeHtml(t("DP.studio.height"))}` +
    `<input type="number" name="_height" value="${squares(Number(doc.height) || 0, grid)}"` +
    ` step="0.5" min="0.05"></label>` +
    `<label>${escapeHtml(t("DP.studio.aspect"))}` +
    `<input type="checkbox" name="_aspect"${options.aspectLocked ? " checked" : ""}></label>` +
    `<label>${escapeHtml(t("DP.studio.locked"))}` +
    `<input type="checkbox" name="_locked"${doc.locked ? " checked" : ""}></label>` +
    `</div>` +
    `<div class="dp-studio__strip-row dp-studio__strip-row--actions">` +
    // Fit is a prop's verb: a pin is one grid square and has no content to fit.
    `<button type="button" data-action="fitHeight"${pin.mode !== "prop" ? " disabled" : ""}>` +
    `${escapeHtml(t("DP.studio.fitHeight"))}</button>` +
    `<button type="button" data-action="resetSize">${escapeHtml(t("DP.studio.resetSize"))}</button>` +
    `<button type="button" data-action="locate">${escapeHtml(t("DP.board.locate"))}</button>` +
    `<button type="button" class="dp-danger" data-action="deletePin">` +
    `${escapeHtml(t("DP.studio.delete"))}</button>` +
    `</div>` +
    `</footer>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

/**
 * Turn a flat form of dotted names into a nested patch.
 *
 * PURE and exported so the mapping is testable: this is the one place a typo in a
 * field name would silently stop saving a control, with no error anywhere.
 */
export function formToPatch(entries: [string, unknown][]): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const [name, value] of entries) {
    if (name.startsWith("_")) continue;
    const path = name.split(".");
    let node = patch;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path[path.length - 1]] = value;
  }
  return patch;
}

/** Read a form element's value with the type the schema expects. */
export function valueOf(element: HTMLInputElement | HTMLSelectElement): unknown {
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") return element.checked;
    // An emptied number input is "no value", not zero. `source.pdfPage` is nullable and
    // the schema clamps to one, so `Number("")` would store page 1 — a page the GM never
    // chose — the moment they cleared the field to type another number.
    if (element.type === "number") return element.value === "" ? null : Number(element.value);
    if (element.type === "range") return Number(element.value);
  }
  // `ownershipSync.level` is the one select carrying a number rather than an enum.
  if (element.name.endsWith(".level")) return Number(element.value);
  return element.value;
}

export function definePinStudio(): any {
  if (StudioClass) return StudioClass;

  const ApplicationV2 = ns("applications.api.ApplicationV2");
  if (!ApplicationV2) return null;

  StudioClass = class PinStudio extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ["dp-scope", "dp-studio-app"],
      tag: "form",
      window: { title: "DP.studio.title", icon: "fa-solid fa-sliders", resizable: true },
      // Tall enough for the Appearance tab's gallery to show without a scroll on a
      // laptop; the window is resizable for anything narrower.
      position: { width: 500, height: 700 },
      form: { submitOnChange: true, closeOnSubmit: false },
      actions: {
        setTab: onSetTab,
        setEffect: onSetEffect,
        locate: onLocate,
        fitHeight: onFitHeight,
        resetSize: onResetSize,
        editPresets: onEditPresets,
        retargetSource: onRetargetSource,
        deletePin: onDeletePin,
      },
    };

    doc: any = null;
    tab: TabId = "content";
    /** Whether editing one dimension in the strip carries the other with it. */
    aspectLocked = false;

    async _renderHTML() {
      const pin = readPin(this.doc);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pin
        ? studioMarkup(this.doc, pin, this.tab, {
            aspectLocked: this.aspectLocked,
            pages: api.pageChoices(pin),
            // Awaited here and not in the markup: parsing a PDF is not free and the
            // markup builder must stay synchronous and world-free. A count that fails to
            // arrive leaves the field with no ceiling, which is still a usable control.
            pdfPages: await pdfPageCountFor(pin),
          })
        : `<p class="dp-studio__gone">${escapeHtml(t("DP.studio.gone"))}</p>`;
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Every change re-renders the whole form, which started the tab at the top again
      // on each slider tick. Keep the scroll when the tab is the same one.
      const before = content.querySelector<HTMLElement>(".dp-studio__tab");
      const scrollTop = before?.dataset.dpTab === this.tab ? before.scrollTop : 0;

      content.replaceChildren(result);
      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      this.#wire(result);

      const after = content.querySelector<HTMLElement>(".dp-studio__tab");
      if (after && scrollTop) after.scrollTop = scrollTop;
    }

    #wire(root: HTMLElement) {
      // One listener for every control: `submitOnChange` fires on the form, and going
      // through it keeps the whole form on one code path rather than one per field.
      root.addEventListener("change", (event) => {
        const target = event.target as HTMLInputElement;
        if (!target?.name) return;
        void this.#apply(target);
      });

      root.addEventListener("input", (event) => {
        const target = event.target as HTMLInputElement;
        if (target?.type !== "range") return;
        const output = target.nextElementSibling;
        if (output?.tagName === "OUTPUT") output.textContent = target.value;
        // The prop previews the intensity as the slider moves; the commit is on change.
        if (target.name === "effect.intensity") {
          previewIntensity(this.doc?.id, Number(target.value));
        }
      });

      root.addEventListener("click", (event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>(".dp-chip");
        if (!chip) return;
        event.preventDefault();
        const userId = chip.dataset.dpUser ?? "";
        const change = (event as MouseEvent).shiftKey
          ? api.soloUser(this.doc, userId)
          : api.setUserVisible(this.doc, userId, chip.getAttribute("aria-checked") !== "true");
        void change?.then(() => this.render());
      });
    }

    async #apply(target: HTMLInputElement) {
      // The placement strip writes tile fields, not the pin payload.
      if (target.name.startsWith("_")) {
        const field = target.name.slice(1);
        if (field === "aspect") {
          this.aspectLocked = target.checked;
          return;
        }
        if (field === "width" || field === "height") {
          await this.#resize(field, Number(target.value));
          return;
        }
        const value = target.type === "checkbox" ? target.checked : Number(target.value);
        await this.doc.update({ [field]: value });
        return;
      }

      if (target.name === "mode") {
        await api.setMode(this.doc, target.value as any);
        this.render();
        return;
      }

      const patch = formToPatch([[target.name, valueOf(target)]]);

      // Touching one metric must not leave the other proportional: a stored type with a
      // margin still derived from the short edge would drift on the next resize, which is
      // the exact thing storing the type exists to stop. So the first edit freezes both.
      if (target.name === "display.typeSize" || target.name === "display.margin") {
        const pin = readPin(this.doc);
        if (pin && (pin.display.typeSize === null || pin.display.margin === null)) {
          const frozen = freezeMetrics(pin, this.doc).display;
          patch.display = { typeSize: frozen.typeSize, margin: frozen.margin, ...patch.display };
        }
      }

      // Deep-merged and ownership-synced in one call: spreading the patch here would
      // replace a whole group, and `{ ownershipSync: { level } }` would then wipe the
      // `enabled` flag beside it.
      await api.patchAndSync(this.doc, patch);

      // Which controls exist depends on the chosen page: pick a PDF page and the PDF
      // field has to appear, the Appearance tab flips to its inert variant, and the pin
      // changes rendering tier. `refreshStudios` gets there on `updateTile` anyway; this
      // is the difference between instant and a hook away.
      if (target.name === "source.pageId") this.render();
    }

    /** One dimension from the strip, in squares; the other follows if the ratio is locked. */
    async #resize(axis: "width" | "height", squaresWanted: number) {
      const grid = gridOf(this.doc);
      const px = Math.max(1, Math.round(squaresWanted * grid));
      let width = Number(this.doc.width) || 1;
      let height = Number(this.doc.height) || 1;
      if (axis === "width") {
        const ratio = height / width;
        width = px;
        if (this.aspectLocked) height = Math.max(1, Math.round(px * ratio));
      } else {
        const ratio = width / height;
        height = px;
        if (this.aspectLocked) width = Math.max(1, Math.round(px * ratio));
      }
      await api.resize(this.doc, { width, height });
      this.render();
    }
  };

  return StudioClass;
}

function onSetTab(this: any, _event: Event, target: HTMLElement) {
  this.tab = (target.dataset.dpTab ?? "content") as TabId;
  this.render();
}

function onSetEffect(this: any, _event: Event, target: HTMLElement) {
  const id = target.dataset.dpPreset;
  if (!id) return;
  void api.patch(this.doc, { effect: { id } })?.then(() => this.render());
}

function onLocate(this: any) {
  void api.locate(this.doc);
}

function onFitHeight(this: any) {
  void api.fitToContent(this.doc).then(() => this.render());
}

function onEditPresets(this: any) {
  Hooks.call(`${MODULE_ID}.openPresets`, readPin(this.doc)?.effect.id);
}

function onResetSize(this: any) {
  void api.resetSize(this.doc).then(() => this.render());
}

/**
 * Delete asks first.
 *
 * The only action in the Studio that does. Everything else here is one change to undo;
 * this one is not, and it is sitting next to controls a GM is clicking quickly.
 */
async function onDeletePin(this: any) {
  const DialogV2 = ns("applications.api.DialogV2");
  const confirmed = DialogV2?.confirm
    ? await DialogV2.confirm({
        window: { title: t("DP.studio.delete") },
        content: `<p>${escapeHtml(t("DP.board.deleteBody", { count: 1 }))}</p>`,
      }).catch(() => false)
    : false;
  if (!confirmed) return;

  await api.deletePin(this.doc);
  this.close();
}

/**
 * Point this pin at a different document.
 *
 * Asks AFTER the picker, not before, so the dialog can name the document — which is what
 * makes the confirmation informative rather than ritual — and because a GM asked before
 * choosing is being asked to confirm a decision they have not made yet. It asks at all
 * for the reason delete does: this is not one change to undo. It rewrites the source,
 * moves an ownership grant between two documents, and changes what players looking at the
 * map are seeing right now. Two of those three are invisible from this window.
 *
 * Closes over `doc`, never `this`: the picker is a separate application and outlives the
 * Studio if the GM closes it while the picker is open.
 */
function onRetargetSource(this: any) {
  const doc = this.doc;
  openPicker({
    onChoose: (source) => {
      void confirmRetarget(source).then((ok) => {
        if (ok) void api.retarget(doc, source);
      });
    },
  });
}

async function confirmRetarget(source: DpSource): Promise<boolean> {
  const DialogV2 = ns("applications.api.DialogV2");
  if (!DialogV2?.confirm) return false;
  const name = api.labelForSource(source);
  return DialogV2.confirm({
    window: { title: t("DP.studio.retargetTitle") },
    content: `<p>${escapeHtml(t("DP.studio.retargetBody", { name }))}</p>`,
  }).catch(() => false);
}

/** Open the Studio for a pin, reusing the window already showing it. */
export function openStudio(doc: any, tab: TabId = "content"): any {
  const Studio = definePinStudio();
  if (!Studio || !doc) return null;

  let app = open.get(doc.id);
  if (!app) {
    app = new Studio({ id: `dp-studio-${doc.id}` });
    app.doc = doc;
    open.set(doc.id, app);
  }
  app.tab = tab;
  app.render(true);
  return app;
}

/** Re-render every open Studio. Wired to the tile hooks. */
export function refreshStudios(): void {
  for (const [id, app] of open) {
    if (app.rendered) app.render();
    else open.delete(id);
  }
}

declare const Hooks: any;
