/**
 * Pin Studio's markup: the three tabs, the banner above them and the strip below, and the
 * form's way back from dotted names to a patch.
 *
 * IMPURE in what it reads, never in what it does: it writes nothing and awaits nothing, but
 * it asks the world about the pin's source — `describeSource`, its adapter, what a reveal
 * shares, who the chips are for, the scene's grid — so a test calls it with a fake world
 * installed. What only a load can say comes in through `StudioOptions`. `PinStudio`
 * re-exports `studioMarkup`, `liveBanner`, `formToPatch` and `valueOf` and their types,
 * which the tests read there.
 */

import { PLACEHOLDER_TEXTURE } from "../const";
import { cv } from "../fvtt";
import { t, tn, tOr } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import { cardMetrics } from "../data/pin-schema";
import { PAPERS } from "../render/CardTemplate";
import { allPresets, findPreset } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { fontChoices, fontLabel, fontOptionsMarkup } from "../effects/typeface";
import { revealSoundOf } from "../effects/reveal-sound";
import { describeSource, pdfSourceForPin } from "../sources/describe";
import { adapterForDoc, adapterOrJournal } from "../sources/index";
import { chipsMarkup, describeChips } from "./chips";
import { chipUsersFor } from "./PinHUD";
import type { DpPinFlags } from "../types/dp";

/** An id for the window, and the stem of the ids inside it, unique per pin across scenes. */
export const studioId = (doc: any): string =>
  `dp-studio-${String(doc?.uuid ?? doc?.id ?? "pin").replace(/[^\w-]/g, "-")}`;

export type TabId = "content" | "appearance" | "audience";

export const TABS: { id: TabId; key: string; icon: string }[] = [
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
  "display.font",
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

/**
 * How a slider is shown: a multiplier from the stored value to the shown one, and a unit.
 *
 * The readouts used to be bare numbers — "0.55", "12.5", "1.5" — with the intensity on a
 * 0–1 scale here and 0–100 in the HUD, so the same setting read as two different ones.
 * A fraction is shown as a percentage everywhere now, and every readout says its unit.
 */
interface RangeDisplay {
  scale?: number;
  unit?: string;
}

function range(
  name: string,
  value: number,
  min = 0,
  max = 1,
  step = 0.05,
  pdf = false,
  display: RangeDisplay = {}
): string {
  const scale = display.scale ?? 1;
  const unit = display.unit ?? "";
  const shown = Math.round(value * scale * 100) / 100;
  const extra =
    (scale !== 1 ? ` data-dp-scale="${scale}"` : "") +
    (unit ? ` data-dp-unit="${escapeAttr(unit)}"` : "");
  return (
    `<input type="range" name="${escapeAttr(name)}" min="${min}" max="${max}" step="${step}"` +
    ` value="${shown}"${extra}${inert(name, pdf)}><output>${shown}${escapeHtml(unit)}</output>`
  );
}

/** A percentage slider over a stored 0–1 fraction. */
const PERCENT = { scale: 100, unit: "%" } as const;

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
 * Everything the tabs need that only a load, or the application, can say.
 *
 * Resolved by `_renderHTML`, which is already async, and passed in, so the markup never
 * awaits: a compendium journal's page list needs its document loaded, and the PDF page
 * count is a promise besides.
 */
export interface StudioOptions {
  aspectLocked?: boolean;
  /** Whether the table is watching this pin, and whether this Studio has hidden it. */
  live?: StudioLive;
  /** Pages the GM may choose between, from the entry this pin's uuid names. */
  pages?: { id: string; name: string; type: string }[];
  /** How many pages the PDF behind this pin has, or 0 while that is not known. */
  pdfPages?: number;
  /**
   * Whether the page this pin shows is a PDF, when only a load can tell: a compendium
   * page, which is always drawn as a card but whose PDF page can still be chosen.
   */
  shownIsPdf?: boolean;
  /** The icons a pin may wear: core's map-note icons, labelled. */
  icons?: { label: string; src: string }[];
  /** The world's own font families, before `fontChoices` filters them. */
  fonts?: string[];
  /** Whether this core has a file browser to choose a sound with. No browser, no button. */
  canBrowse?: boolean;
  /**
   * The text fields of the actor or item a portrait pin shows, and the one the automatic
   * choice reads; absent for a journal or an image, which have pages or nothing instead.
   */
  fields?: api.FieldChoices | null;
}

/**
 * Which text of an actor or an item lies on the map, below its picture and its name: one
 * of the HTML fields its game system declares, or the automatic choice — named, so the GM
 * sees what "automatic" is before choosing anything else.
 */
function textField(pin: DpPinFlags, fields: api.FieldChoices): string {
  return field(
    "DP.studio.textShown",
    select("source.field", pin.source.field ?? "", [
      {
        value: "",
        label: t("DP.studio.textAutomatic", {
          label: fields.automatic ?? t("DP.studio.textNone"),
        }),
      },
      ...fields.fields.map((choice) => ({ value: choice.path, label: choice.label })),
    ]),
    "DP.studio.textShownHint"
  );
}

function contentTab(pin: DpPinFlags, options: StudioOptions, attrs = ""): string {
  const summary = describeSource(pin.source);
  const isPage = summary.isPage;
  const pages = options.pages ?? [];
  // A portrait card has a text to choose, and no page and no PDF.
  const portrait = options.fields ?? null;

  // Removed rather than disabled, unlike the PDF-inert controls on the Appearance tab.
  // A15 disabled a whole tab because a blank tab reads as broken; one absent field among
  // six reads as "not applicable", which is what it is.
  const pageField = portrait
    ? textField(pin, portrait)
    : pages.length
      ? field(
          "DP.studio.page",
          select("source.pageId", pin.source.pageId ?? "", [
            { value: "", label: t("DP.studio.pageFirst") },
            ...pages.map((page) => ({
              value: page.id,
              // The raw page type beside the name, only where it disambiguates: two pages
              // called "Map" can be a text page and an image, and the list cannot say which.
              label:
                page.type === "text"
                  ? page.name
                  : `${page.name} (${tOr(`DP.pageType.${page.type}`, page.type)})`,
            })),
          ]),
          "DP.studio.pageHint"
        )
      : isPage
        ? `<p class="dp-studio__note">${escapeHtml(t("DP.studio.pageIsOne"))}</p>`
        : "";

  const pdfField =
    !portrait && (isPdfPin(pin) || options.shownIsPdf)
      ? field(
          "DP.studio.pdfPage",
          `<input type="number" name="source.pdfPage" min="1"` +
            (options.pdfPages ? ` max="${options.pdfPages}"` : "") +
            ` step="1" value="${pin.source.pdfPage ?? 1}">`,
          "DP.studio.pdfPageHint"
        )
      : "";

  return (
    `<section class="dp-studio__tab" data-dp-tab="content"${attrs}>` +
    // The source, which page of it, and the way to change it — one block about the
    // document, before the block about the pin.
    `<div class="dp-studio__sourcebox">` +
    `<p class="dp-studio__source">` +
    `<i class="fa-solid fa-link" aria-hidden="true"></i> ` +
    escapeHtml(
      (pin.source.kind === "image" ? pin.source.src : summary.name) || t("DP.studio.sourceMissing")
    ) +
    `</p>` +
    (summary.pack
      ? `<span class="dp-studio__hint">` +
        `${escapeHtml(t("DP.studio.fromPack", { pack: summary.pack.title }))}</span>`
      : "") +
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
  return pdfSourceForPin(pin) !== null;
}

/**
 * The PDF a shown document is, asked of its own adapter: an actor whose game system
 * names a type "pdf" is not one.
 */
export const pdfOf = (shown: any): string | null =>
  shown ? adapterForDoc(shown).pdf(shown) : null;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The icon a document pin wears on the map — core's map-note icons, the shared book, or
 * any image from the file browser.
 *
 * Every document pin used to be the same book, so five pins on a map were five
 * identical markers. Offered on a prop too: it is the icon the prop becomes when it is
 * shrunk to a pin, and the sheet it shows until its card is drawn.
 */
function iconField(doc: any, pin: DpPinFlags, options: StudioOptions): string {
  if (pin.source.kind !== "document") return "";
  const current = doc?.texture?.src ?? PLACEHOLDER_TEXTURE;
  const choices = [
    { label: t("DP.studio.iconDefault"), src: PLACEHOLDER_TEXTURE },
    ...(options.icons ?? []).filter((icon) => icon.src !== PLACEHOLDER_TEXTURE),
  ];
  if (!choices.some((icon) => icon.src === current)) {
    const file = decodeURIComponent(String(current).split("/").pop() ?? current);
    choices.push({ label: t("DP.studio.iconCustom", { file }), src: current });
  }
  const items = choices
    .map(
      (icon) =>
        `<option value="${escapeAttr(icon.src)}"${icon.src === current ? " selected" : ""}>` +
        `${escapeHtml(icon.label)}</option>`
    )
    .join("");
  return field(
    "DP.studio.icon",
    `<select name="_icon" class="dp-studio__icon-select">${items}</select>` +
      `<button type="button" class="dp-studio__icon-browse" data-action="browseIcon"` +
      ` data-tooltip-text="${escapeAttr(t("DP.studio.iconBrowse"))}"` +
      ` aria-label="${escapeAttr(t("DP.studio.iconBrowse"))}">` +
      `<i class="fa-solid fa-folder-open" aria-hidden="true"></i></button>`,
    "DP.studio.iconHint"
  );
}

/**
 * The typeface: the effect's, a generic family, or one of this world's faces, each option
 * drawn in its own face so the choice can be judged from the list. Inert for a PDF, which
 * has no card and no text of the module's to set.
 */
function fontField(pin: DpPinFlags, options: StudioOptions, pdf: boolean): string {
  const items = fontOptionsMarkup(
    fontChoices(options.fonts ?? []),
    pin.display.font,
    t("DP.studio.fontFromEffect"),
    (name) => fontLabel(name, t)
  );
  return field(
    "DP.studio.font",
    `<select name="display.font"${inert("display.font", pdf)}>${items}</select>`,
    "DP.studio.fontHint"
  );
}

/** A path's last segment, for a GM to recognise; never throws on a stray `%`. */
function fileName(path: string): string {
  const last = path.split("/").pop() || path;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * This prop's own reveal sound, over the effect's: "this one letter arrives with a
 * thunderclap" is a pin's decision, not a preset's.
 *
 * Disabled, with the reason, on an icon: only a prop has an arrival — the manager tracks
 * props alone — and a control that cannot be honoured is not offered as if it could (A15).
 * The path is shown rather than typed. Every way in is the file browser or the clear
 * button, so every path meets the one same-origin rule on its way, and a refused one is
 * said instead of silently stored as nothing. ▶ plays what the players will hear, which is
 * the only way the GM hears it: their own client never sees a prop arrive.
 */
function revealSoundField(pin: DpPinFlags, options: StudioOptions): string {
  const icon = pin.mode !== "prop";
  const own = pin.effect.revealSound;
  const effects = findPreset(pin.effect.id)?.reveal.sound ?? null;
  const placeholder = effects
    ? t("DP.studio.revealSoundEffect", { file: fileName(effects) })
    : t("DP.studio.revealSoundSilent");
  const off = icon ? " disabled" : "";
  const button = (action: string, key: string, glyph: string) =>
    `<button type="button" data-action="${action}"${off}` +
    ` data-tooltip-text="${escapeAttr(t(key))}" aria-label="${escapeAttr(t(key))}">` +
    `<i class="fa-solid ${glyph}" aria-hidden="true"></i></button>`;
  return field(
    "DP.studio.revealSound",
    `<span class="dp-studio__sound">` +
      `<input type="text" readonly value="${escapeAttr(own ?? "")}"` +
      ` placeholder="${escapeAttr(placeholder)}"` +
      ` aria-label="${escapeAttr(t("DP.studio.revealSound"))}"${off}>` +
      (options.canBrowse
        ? button("browseRevealSound", "DP.studio.revealSoundBrowse", "fa-folder-open")
        : "") +
      (revealSoundOf(pin)
        ? button("previewRevealSound", "DP.studio.revealSoundPreview", "fa-play")
        : "") +
      (own ? button("clearRevealSound", "DP.studio.revealSoundClear", "fa-xmark") : "") +
      `</span>`,
    icon ? "DP.studio.revealSoundIcon" : "DP.studio.revealSoundHint"
  );
}

function appearanceTab(doc: any, pin: DpPinFlags, options: StudioOptions = {}, attrs = ""): string {
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
    `<section class="dp-studio__tab" data-dp-tab="appearance"${pdf ? ' data-dp-pdf="true"' : ""}${attrs}>` +
    inert +
    field(
      "DP.studio.mode",
      select("mode", pin.mode, [
        { value: "prop", label: t("DP.settings.defaultMode.prop") },
        { value: "pin", label: t("DP.settings.defaultMode.pin") },
      ])
    ) +
    iconField(doc, pin, options) +
    field(
      "DP.studio.paper",
      select(
        "display.paper",
        pin.display.paper,
        Object.keys(PAPERS).map((id) => ({ value: id, label: t(`DP.paper.${id}`) })),
        pdf
      )
    ) +
    fontField(pin, options, pdf) +
    field(
      "DP.studio.typeSize",
      range("display.typeSize", round2(metrics.fontPx), 6, 72, 0.5, pdf, { unit: " px" }),
      "DP.studio.typeSizeHint"
    ) +
    field(
      "DP.studio.margin",
      range("display.margin", round2(marginEm), 0, 6, 0.1, pdf, { unit: " em" }),
      "DP.studio.marginHint"
    ) +
    `<div class="dp-studio__swatches" role="group" aria-label="${escapeAttr(t("DP.studio.effect"))}">` +
    swatches +
    `</div>` +
    `<button type="button" class="dp-studio__link" data-action="editPresets">` +
    `${escapeHtml(t("DP.presets.edit"))}</button>` +
    field(
      "DP.studio.intensity",
      range("effect.intensity", pin.effect.intensity, 0, 100, 5, false, PERCENT)
    ) +
    field(
      "DP.studio.speed",
      range("effect.speed", pin.effect.speed, 0, 4, 0.1, pdf, { unit: "×" })
    ) +
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
    revealSoundField(pin, options) +
    field(
      "DP.studio.fadeUnderTokens",
      checkbox("display.fadeUnderTokens", pin.display.fadeUnderTokens),
      "DP.studio.fadeUnderTokensHint"
    ) +
    field(
      "DP.studio.fadeAlpha",
      range(
        "display.fadeUnderTokensAlpha",
        pin.display.fadeUnderTokensAlpha,
        0,
        100,
        5,
        false,
        PERCENT
      )
    ) +
    `</section>`
  );
}

/**
 * What revealing this pin shares, said where access is switched on.
 *
 * A grant outlives the pin by design, so "which document, and how much of it" is the one
 * question to answer before the checkbox rather than after. A pin on a whole journal
 * shares every page in it, and nothing on this tab used to say so.
 */
function grantNote(pin: DpPinFlags): string {
  if (!pin.audience.ownershipSync.enabled) return "";
  const scope = api.grantScope(pin);
  if (!scope) return "";
  const text =
    scope.kind === "pack"
      ? t("DP.studio.grantsPack", { pack: scope.pack, entry: scope.entry })
      : scope.kind === "page"
        ? t("DP.studio.grantsPage", { page: scope.page, entry: scope.entry })
        : scope.kind === "actor" || scope.kind === "item"
          ? t(scope.kind === "actor" ? "DP.studio.grantsActor" : "DP.studio.grantsItem", {
              name: scope.name,
            })
          : t("DP.studio.grantsJournal", { entry: scope.entry }) +
            (scope.pages > 1 ? ` ${t("DP.studio.grantsJournalHint")}` : "");
  return `<p class="dp-studio__note" data-dp-grants="${scope.kind}">${escapeHtml(text)}</p>`;
}

/**
 * A prop drawn as a card is visible through unexplored fog, so its reveal has to be timed.
 *
 * Every prop but a PDF — which is drawn into the scene and fogged like the map — and
 * whatever its audience: the advice matters most BEFORE the reveal (DESIGN A26). Not
 * `drawsAsDom`, which answers for the GM's own client; the players' clients are the ones
 * that draw the card over their fog.
 */
function fogNote(pin: DpPinFlags): string {
  if (pin.mode !== "prop" || isPdfPin(pin)) return "";
  return `<p class="dp-studio__note" data-dp-fog="true">${escapeHtml(t("DP.studio.fogNote"))}</p>`;
}

/**
 * The level a reveal grants. An actor is offered Limited alone, since that is all it is
 * ever granted (`grantTargets` caps it): Observer would open an NPC's whole sheet, and a
 * choice the grant would not honour is worse than none.
 */
function syncLevelField(pin: DpPinFlags): string {
  const documentName =
    pin.source.kind === "document" ? describeSource(pin.source).documentName : null;
  const capped = adapterOrJournal(documentName).maxGrant < 2;
  return field(
    "DP.studio.syncLevel",
    select(
      "audience.ownershipSync.level",
      capped ? "1" : String(pin.audience.ownershipSync.level),
      [
        ...(capped ? [] : [{ value: "2", label: t("DP.studio.syncObserver") }]),
        { value: "1", label: t("DP.studio.syncLimited") },
      ]
    ),
    capped ? "DP.studio.syncLevelActorHint" : "DP.studio.syncLevelHint"
  );
}

function audienceTab(doc: any, pin: DpPinFlags, attrs = ""): string {
  const users = chipUsersFor(doc);
  return (
    `<section class="dp-studio__tab" data-dp-tab="audience"${attrs}>` +
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
    fogNote(pin) +
    field(
      "DP.studio.sync",
      checkbox("audience.ownershipSync.enabled", pin.audience.ownershipSync.enabled),
      "DP.studio.syncHint"
    ) +
    grantNote(pin) +
    syncLevelField(pin) +
    // No "remember who has discovered it": `audience.sticky` is read only under the
    // `discovered` kind, which this tab deliberately does not offer (A9), so the box was
    // a control that could not be honoured.
    `</section>`
  );
}

/** The grid the anchor's scene uses, so sizes can be shown in squares. */
export function gridOf(doc: any): number {
  return doc?.parent?.grid?.size ?? cv()?.scene?.grid?.size ?? 100;
}

const squares = (px: number, grid: number) => Math.round((px / grid) * 100) / 100;

/** The facts the banner is drawn from, computed by the application and passed in. */
export interface StudioLive {
  /** Whether the pin reaches any player right now (`api.isRevealed`). */
  revealed: boolean;
  /** How many players can see it. */
  count: number;
  /** Whether this Studio hid it, and it is still exactly as that hide left it. */
  held: boolean;
}

/**
 * The line above the tabs that says when the table is watching.
 *
 * Every control here saves as it moves, which is right for prep and wrong in front of the
 * players: on a revealed prop they watched the GM cycle papers, sizes and effects. So a
 * revealed pin says so, with how many are watching, and offers to hide it until the
 * Studio closes — which reveals it again, to the same players. A pin this Studio hid says
 * that instead, with the way back. Anything else draws nothing.
 *
 * PURE: the application works out the facts.
 */
export function liveBanner(live: StudioLive | undefined): string {
  if (live?.held) {
    return (
      `<div class="dp-studio__live dp-studio__live--held" role="status">` +
      `<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>` +
      `<span>${escapeHtml(t("DP.studio.holdBanner"))}</span>` +
      // One focus key for both of the banner's buttons, so the keyboard crosses from one to
      // the other as the pin hides and shows, instead of falling back to the page.
      `<button type="button" data-action="resumeEdit" data-dp-focus-key="editHold">` +
      `${escapeHtml(t("DP.studio.resumeEdit"))}</button>` +
      `</div>`
    );
  }
  if (!live?.revealed) return "";
  return (
    `<div class="dp-studio__live" role="status">` +
    `<i class="fa-solid fa-eye" aria-hidden="true"></i>` +
    `<span>${escapeHtml(t("DP.studio.liveBanner", { count: live.count }))}</span>` +
    `<button type="button" data-action="holdForEdit" data-dp-focus-key="editHold"` +
    ` data-tooltip-text="${escapeAttr(t("DP.studio.holdHint"))}">` +
    `${escapeHtml(t("DP.studio.holdForEdit"))}</button>` +
    `</div>`
  );
}

export function studioMarkup(
  doc: any,
  pin: DpPinFlags,
  active: TabId,
  options: StudioOptions = {}
): string {
  const grid = gridOf(doc);
  // Ids unique per window: two Studios can be open at once, one per pin.
  const base = studioId(doc);
  const tabId = (id: TabId) => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;
  // A real tab pattern: one tab stop for the row, the arrows move along it, and the
  // panel says which tab labels it. The buttons used to be three tab stops with a role
  // and nothing behind it.
  const nav = TABS.map((tab) => {
    const selected = tab.id === active;
    return (
      `<button type="button" class="dp-studio__tabbtn" data-action="setTab"` +
      ` data-dp-tab="${tab.id}" role="tab" aria-selected="${selected}" id="${tabId(tab.id)}"` +
      (selected ? ` aria-controls="${panelId}" tabindex="0"` : ` tabindex="-1"`) +
      `><i class="fa-solid ${tab.icon}" aria-hidden="true"></i> ${escapeHtml(t(tab.key))}</button>`
    );
  }).join("");
  const attrs = ` role="tabpanel" id="${panelId}" aria-labelledby="${tabId(active)}"`;

  const body =
    active === "content"
      ? contentTab(pin, options, attrs)
      : active === "appearance"
        ? appearanceTab(doc, pin, options, attrs)
        : audienceTab(doc, pin, attrs);

  return (
    `<div class="dp-studio">` +
    liveBanner(options.live) +
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
    if (element.type === "range") {
      // A slider shown in percent stores a fraction.
      const scale = Number(element.dataset?.dpScale) || 1;
      return Number(element.value) / scale;
    }
  }
  // `ownershipSync.level` is the one select carrying a number rather than an enum.
  if (element.name.endsWith(".level")) return Number(element.value);
  // "Automatic" is the absence of a choice, not a field called "".
  if (element.name === "source.field") return element.value || null;
  return element.value;
}
