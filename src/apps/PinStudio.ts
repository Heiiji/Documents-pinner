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

import { MODULE_ID, PLACEHOLDER_TEXTURE } from "../const";
import { cfg, cv, g, isGM, notify, ns, playerIds, resolveUuidSync } from "../fvtt";
import { previewIntensity } from "../canvas/DomPropTier";
import { t, tn, tOr } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import { logger } from "../log";
import { resumeAfterEdit, toggleVisibility } from "../data/audience";
import * as settings from "../settings";
import type { EditHold } from "../settings";
import { readPin } from "../data/PinData";
import { cardMetrics, freezeMetrics } from "../data/pin-schema";
import { PAPERS } from "../render/CardTemplate";
import { allPresets, findPreset } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { fontChoices, fontLabel, fontOptionsMarkup } from "../effects/typeface";
import { registeredFontFamilies } from "../render/AssetInliner";
import { playRevealSound, revealSoundOf } from "../canvas/PropManager";
import { soundPath } from "../normalise";
import { pdfPageCount } from "../render/PdfPage";
import { describeSource, pdfSourceForPin } from "../sources/describe";
import { adapterForDoc, adapterOrJournal } from "../sources/index";
import { chipsMarkup, describeChips } from "./chips";
import { openPicker } from "./DocumentPicker";
import { chipUsersFor } from "./PinHUD";
import { restoreFocus, snapshotFocus } from "./focus-restore";
import type { DpNotice, DpPinFlags, DpSource } from "../types/dp";

const log = logger("studio");

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
 * Everything the Content tab needs that a Foundry global would otherwise be asked for.
 *
 * Resolved by `_renderHTML`, which is already async, and passed in — so `studioMarkup`
 * stays a pure function of its arguments and the tests can call it with no world at all.
 * A page list looked up inside the markup would end that, and the PDF page count is a
 * promise besides.
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
const pdfOf = (shown: any): string | null => (shown ? adapterForDoc(shown).pdf(shown) : null);

/** How many pages the PDF a pin shows has, or 0 when there is no answer. */
async function pdfPageCountOf(shown: any): Promise<number> {
  const src = pdfOf(shown);
  if (!src) return 0;
  try {
    return await pdfPageCount(src);
  } catch {
    return 0;
  }
}

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
 * whatever its audience: the advice matters most BEFORE the reveal (K8). Not
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
function gridOf(doc: any): number {
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
 * PURE, like the rest of the markup: the application works out the facts.
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
  const base = `dp-studio-${String(doc?.id ?? "pin").replace(/[^\w-]/g, "")}`;
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
        browseIcon: onBrowseIcon,
        browseRevealSound: onBrowseRevealSound,
        previewRevealSound: onPreviewRevealSound,
        clearRevealSound: onClearRevealSound,
        setEffect: onSetEffect,
        locate: onLocate,
        fitHeight: onFitHeight,
        resetSize: onResetSize,
        editPresets: onEditPresets,
        retargetSource: onRetargetSource,
        deletePin: onDeletePin,
        holdForEdit: onHoldForEdit,
        resumeEdit: onResumeEdit,
      },
    };

    doc: any = null;
    tab: TabId = "content";
    /** Whether editing one dimension in the strip carries the other with it. */
    aspectLocked = false;
    /** Where the focus goes after the next render, when it is not where it was. */
    focusAfterRender: string | null = null;
    /**
     * The hold this Studio placed with "Hide while I edit", or null. Kept here for the
     * banner and the close, and in the `editHolds` setting for a reload.
     */
    hold: EditHold | null = null;
    /** The hide in flight, so a close in the middle of it ends the hold after it lands. */
    hiding: Promise<void> | null = null;

    /** Who is watching, and whether this Studio has hidden the pin from them. */
    liveState(pin: DpPinFlags): StudioLive {
      const doc = this.doc;
      return {
        revealed: api.isRevealed(doc, pin),
        count: playerIds().filter((id) => api.canUserSee(doc, id)).length,
        held: !!this.hold && resumeAfterEdit(pin.audience, this.hold.restore) !== null,
      };
    }

    /**
     * "Hide while I edit", in the order that can never strand the pin: the hold is
     * written, THEN the pin is hidden, then the hide is checked. A reload between the
     * first two finds the pin still showing and drops the hold; the other order could
     * leave it hidden with nothing to bring it back.
     */
    async holdForEdit() {
      const doc = this.doc;
      const pin = readPin(doc);
      if (!pin || !doc?.uuid || !api.isRevealed(doc, pin)) return;

      const hidden = toggleVisibility(pin.audience);
      const hold: EditHold = { anchor: doc.uuid, world: worldId(), restore: hidden.restore };
      const release = () => writeHolds((holds) => holds.filter((h) => h.anchor !== hold.anchor));
      await writeHolds((holds) => [...holds.filter((h) => h.anchor !== hold.anchor), hold]);
      // Closed while the hold was being written: nothing was hidden, so nothing is held.
      if (!this.rendered) return release();

      // Held before the hide lands, so the render the hide itself triggers already shows
      // the way back, and a hide that throws still has its hold ended by the close.
      this.hold = hold;
      this.hiding = api.setAudience(doc, hidden);
      try {
        await this.hiding;
      } finally {
        this.hiding = null;
      }

      // A write core refused still resolves: keep the hold only if the pin now hides.
      const after = readPin(doc);
      if (!after || (doc.hidden !== true && after.audience.kind !== "hidden")) {
        this.hold = null;
        await release();
        notify({ key: "DP.notice.editHoldFailed" }, "error");
        return;
      }
      this.render();
    }

    /**
     * End the hold: reveal the pin again if it is still as the hold left it, and forget
     * the hold whatever happens — a pin the GM revealed or re-hid by hand is theirs.
     */
    async resumeHold() {
      const hold = this.hold;
      if (!hold) return;
      this.hold = null;
      try {
        // A close in the middle of the hide waits for it: resuming first would find the
        // pin still showing, and the hide would land after, with no hold left to end it.
        await this.hiding?.catch(() => undefined);
        await resumeOne(hold);
      } finally {
        await writeHolds((holds) => holds.filter((h) => h.anchor !== hold.anchor));
      }
      if (this.rendered) this.render();
    }

    /**
     * The pin showed again since the hide: whatever the GM does to it next is theirs, not
     * the close's.
     *
     * `resumeAfterEdit` can only compare what the pin remembers with what the hold
     * remembers, and a pin shown again by hand and hidden again by hand remembers the
     * same audience — so the close revealed it against the GM's last word. The hold ends
     * the moment the pin is seen showing, in memory and in the setting a reload reads.
     */
    dropHold() {
      const hold = this.hold;
      if (!hold) return;
      this.hold = null;
      void writeHolds((holds) => holds.filter((h) => h.anchor !== hold.anchor)).catch(
        (error: unknown) => log.warn("could not forget the edit hold", error)
      );
    }

    /** The fire-and-forget form the close and the banner's button use. */
    runResume() {
      void this.resumeHold().catch((error: unknown) => {
        log.warn("could not reveal the pin again after editing", error);
        notify({ key: "DP.notice.editHoldResumeFailed" }, "error");
      });
    }

    /**
     * Closing the Studio ends its hold. Core calls this after the window has gone and
     * does not await it, so nothing here may throw into it; the reveal runs on its own.
     */
    _onClose(options: unknown) {
      try {
        super._onClose?.(options);
        if (this.hold) this.runResume();
      } catch (error) {
        log.warn("the Studio did not close cleanly", error);
      }
    }

    /**
     * The pin's name in the title bar. Every Studio said "Pin Studio", and a GM with
     * three of them open could tell them apart only by reading their fields.
     */
    get title(): string {
      const pin = readPin(this.doc);
      return pin ? t("DP.studio.titleFor", { name: api.labelFor(pin) }) : t("DP.studio.title");
    }

    async _renderHTML() {
      const pin = readPin(this.doc);
      // Every audience change reaches an open Studio as a render — `refreshStudios` on the
      // tile's update, or the chip handler's own — so the first render that finds the pin
      // showing, outside the hide's own write, is where a hold learns it is over.
      const showing = this.doc?.hidden !== true && pin?.audience.kind !== "hidden";
      if (pin && showing && this.hold && !this.hiding) this.dropHold();
      // A compendium document is loaded to list its pages and read its PDF: the index
      // its pack keeps knows neither. A world one is at hand, as it always was.
      const shown = pin ? await api.shownSource(pin) : null;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pin
        ? studioMarkup(this.doc, pin, this.tab, {
            aspectLocked: this.aspectLocked,
            live: this.liveState(pin),
            pages: await api.pageChoicesFor(pin),
            // Awaited here and not in the markup: parsing a PDF is not free and the
            // markup builder must stay synchronous and world-free. A count that fails to
            // arrive leaves the field with no ceiling, which is still a usable control.
            pdfPages: await pdfPageCountOf(shown),
            shownIsPdf: pdfOf(shown) !== null,
            fields: api.fieldChoices(pin),
            icons: noteIcons(),
            fonts: registeredFontFamilies(),
            canBrowse: !!ns("applications.apps.FilePicker.implementation"),
          })
        : `<p class="dp-studio__gone">${escapeHtml(t("DP.studio.gone"))}</p>`;
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Every change re-renders the whole form, which started the tab at the top again
      // on each slider tick. Keep the scroll when the tab is the same one.
      const before = content.querySelector<HTMLElement>(".dp-studio__tab");
      const scrollTop = before?.dataset.dpTab === this.tab ? before.scrollTop : 0;
      // And keep the focus, which the same render destroyed: a slider moved with the
      // arrow keys commits on every step, so it could be moved exactly one step, and a
      // GM tabbing down the form was sent back to the window after each field.
      const focus = snapshotFocus(content);

      content.replaceChildren(result);
      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      this.#wire(result);

      const after = content.querySelector<HTMLElement>(".dp-studio__tab");
      if (after && scrollTop) after.scrollTop = scrollTop;

      // ApplicationV2 writes the title bar once, when the frame is built; a pin renamed
      // while its Studio is open is renamed here too.
      const bar = this.window?.title;
      if (bar instanceof HTMLElement && bar.textContent !== this.title)
        bar.textContent = this.title;

      if (this.focusAfterRender) {
        content.querySelector<HTMLElement>(this.focusAfterRender)?.focus({ preventScroll: true });
        this.focusAfterRender = null;
      } else {
        restoreFocus(content, focus);
      }
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
        if (output?.tagName === "OUTPUT") {
          output.textContent = `${target.value}${target.dataset.dpUnit ?? ""}`;
        }
        // The prop previews the intensity as the slider moves; the commit is on change.
        if (target.name === "effect.intensity") {
          previewIntensity(this.doc?.id, valueOf(target) as number);
        }
      });

      // The arrows move along the tab row, and the tab they reach is the one shown.
      root.addEventListener("keydown", (event) => {
        const tab = (event.target as HTMLElement)?.closest?.<HTMLElement>(".dp-studio__tabbtn");
        if (!tab) return;
        const at = TABS.findIndex((entry) => entry.id === tab.dataset.dpTab);
        const next =
          event.key === "ArrowRight"
            ? (at + 1) % TABS.length
            : event.key === "ArrowLeft"
              ? (at - 1 + TABS.length) % TABS.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? TABS.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        this.tab = TABS[next].id;
        this.focusAfterRender = `.dp-studio__tabbtn[data-dp-tab="${TABS[next].id}"]`;
        this.render();
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
        if (field === "icon") {
          await api.setPinIcon(this.doc, target.value);
          return;
        }
        // An emptied field is a GM part-way through typing, not a request for a
        // one-pixel tile — which is what `Number("")` clamped to on the way through
        // `#resize`. The same rule the payload's own number input follows in `valueOf`.
        if (target.type === "number" && target.value === "") return;
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

      // "Some players" with nobody chosen reaches nobody while its kind says otherwise —
      // the Pinboard counted such a pin as visible, over a row of hollow chips. The HUD
      // never allowed it; the dropdown wrote it. Now both ask for a player instead, and
      // both take back a selection the pin remembers from before it was hidden.
      if (target.name === "audience.kind" && target.value === "selected") {
        if (await api.chooseSome(this.doc)) return;
        target.value = readPin(this.doc)?.audience.kind ?? "hidden";
        const status = target
          .closest(".dp-studio")
          ?.querySelector<HTMLElement>(".dp-studio__status");
        if (status) status.textContent = t("DP.hud.chooseWho");
        target.closest(".dp-studio")?.querySelector<HTMLElement>(".dp-chip")?.focus();
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
  void api.setEffect(this.doc, id)?.then(() => this.render());
}

function onLocate(this: any) {
  void api.locate(this.doc);
}

function onFitHeight(this: any) {
  void api.fitToContent(this.doc).then(() => this.render());
}

/** The pin rides along, so the Preset Studio can offer to put a new preset on it. */
function onEditPresets(this: any) {
  Hooks.call(`${MODULE_ID}.openPresets`, readPin(this.doc)?.effect.id, this.doc);
}

/** Any image as this pin's icon, from the file browser. */
function onBrowseIcon(this: any) {
  const FilePicker = ns("applications.apps.FilePicker.implementation");
  if (!FilePicker) return;
  const doc = this.doc;
  new FilePicker({
    type: "image",
    current: doc?.texture?.src,
    callback: (path: string) => void api.setPinIcon(doc, path),
  }).render(true);
}

/**
 * Store this prop's own reveal sound, or refuse it and say so.
 *
 * The pin normaliser refuses a bad path too — but silently, and by storing a null over
 * whatever the prop had. Checked here first, so a refused pick changes nothing.
 */
async function setRevealSound(doc: any, value: string | null): Promise<void> {
  const warnings: DpNotice[] = [];
  const path = soundPath(value, warnings, "effect.revealSound", "DP.pin.warn.badSound");
  for (const warning of warnings) notify(warning, "warn");
  if (warnings.length || !readPin(doc)) return;
  await api.patchAndSync(doc, { effect: { revealSound: path } });
}

/**
 * Choose this prop's reveal sound from the file browser, audio only. Closes over `doc`,
 * never `this`: the browser outlives the Studio if the GM closes it first.
 */
function onBrowseRevealSound(this: any) {
  const FilePicker = ns("applications.apps.FilePicker.implementation");
  const doc = this.doc;
  if (!FilePicker || readPin(doc)?.mode !== "prop") return;
  const failed = (error: unknown) => log.warn(`the reveal sound could not be set`, error);
  try {
    const picker = new FilePicker({
      type: "audio",
      current: readPin(doc)?.effect.revealSound ?? "",
      callback: (path: string) => void setRevealSound(doc, path).catch(failed),
    });
    void Promise.resolve(picker.render({ force: true })).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** Hear what the players will hear when this prop arrives. */
function onPreviewRevealSound(this: any) {
  const pin = readPin(this.doc);
  if (pin) playRevealSound(revealSoundOf(pin), { preview: true });
}

/** Back to the effect's own sound. */
function onClearRevealSound(this: any) {
  void setRevealSound(this.doc, null).catch((error: unknown) =>
    log.warn(`the reveal sound could not be cleared`, error)
  );
}

/**
 * Core's map-note icons, which is the set a GM already knows from placing notes.
 * Labels may be localisation keys; `localize` returns anything else unchanged.
 */
function noteIcons(): { label: string; src: string }[] {
  const icons = cfg()?.JournalEntry?.noteIcons;
  if (!icons || typeof icons !== "object") return [];
  const localize = (label: string) => g()?.i18n?.localize?.(label) ?? label;
  return Object.entries(icons)
    .filter(([, src]) => typeof src === "string" && src)
    .map(([label, src]) => ({ label: localize(label), src: src as string }));
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

function onHoldForEdit(this: any) {
  void this.holdForEdit().catch((error: unknown) => {
    log.warn("could not hide the pin for editing", error);
    notify({ key: "DP.notice.editHoldFailed" }, "error");
  });
}

function onResumeEdit(this: any) {
  this.runResume();
}

// ---------------------------------------------------------------------------
// Edit holds, across a reload
// ---------------------------------------------------------------------------

/** The world this client is in, or null on a build that does not say. */
function worldId(): string | null {
  const id = g()?.world?.id;
  return typeof id === "string" && id ? id : null;
}

/** The holds this client has placed, read defensively: the setting is ours, but stored. */
function readHolds(): EditHold[] {
  const stored = settings.get("editHolds");
  if (!Array.isArray(stored)) return [];
  return stored.filter((hold): hold is EditHold => typeof hold?.anchor === "string");
}

function writeHolds(change: (holds: EditHold[]) => EditHold[]): Promise<void> {
  return settings.set("editHolds", change(readHolds()));
}

/**
 * Reveal a held pin again iff it is still exactly as the hold left it.
 *
 * The anchor is resolved afresh from its uuid, never taken from a Studio: the pin may have
 * been deleted meanwhile, and a deleted pin is simply not there to reveal.
 */
async function resumeOne(hold: EditHold): Promise<boolean> {
  const doc = resolveUuidSync(hold.anchor);
  const pin = readPin(doc);
  const next = pin ? resumeAfterEdit(pin.audience, hold.restore) : null;
  if (!next) return false;
  await api.setAudience(doc, next);
  return true;
}

/**
 * The `ready` sweep: end every hold a Studio could not end itself — the page reloaded,
 * or the browser closed, with a pin hidden for editing.
 *
 * Each pin still as its hold left it is revealed again, to the same players; one the GM
 * changed since is left as it is. Every hold of this world is then dropped in one write,
 * resumed or not, and the GM is told how many came back. A hold of another world is kept
 * for that world. A GM who never returns leaves the pin hidden with its audience
 * remembered: one Space from where it was.
 */
export async function resumeEditHolds(): Promise<number> {
  if (!isGM()) return 0;
  const world = worldId();
  const mine = readHolds().filter((hold) => !hold.world || !world || hold.world === world);
  if (!mine.length) return 0;

  let resumed = 0;
  for (const hold of mine) {
    try {
      if (await resumeOne(hold)) resumed++;
    } catch (error) {
      log.warn(`could not reveal ${hold.anchor} again after a reload`, error);
    }
  }
  const swept = new Set(mine.map((hold) => hold.anchor));
  await writeHolds((holds) => holds.filter((hold) => !swept.has(hold.anchor)));
  if (resumed) notify({ key: "DP.notice.editHoldsResumed", data: { count: resumed } }, "info");
  return resumed;
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

/**
 * Re-render the open Studios for these pins, or every one when no ids are given. Wired to
 * the tile hooks, which pass the pins that changed.
 */
export function refreshStudios(ids?: readonly string[]): void {
  for (const [id, app] of open) {
    if (!app.rendered) {
      open.delete(id);
      continue;
    }
    if (!ids || ids.includes(id)) app.render();
  }
}

declare const Hooks: any;
