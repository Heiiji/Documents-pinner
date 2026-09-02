/**
 * The pin payload: defaults, normalisation and validation.
 *
 * PURE: no Foundry globals. This is the single source of truth for the shape stored at
 * `flags["documents-pinner"].pin` on an anchor TileDocument; `PinData` is a thin
 * Foundry-facing wrapper that delegates here rather than restating the rules, so the
 * two can never disagree about what a valid pin is.
 *
 * One rule separates this from `preset-schema.ts`: **a pin payload can never be
 * rejected.** A preset that fails to parse is simply not offered, but the anchor Tile
 * behind a pin is already on the canvas, and refusing to parse its flags would leave a
 * placeable no GM could fix from the UI. So `validatePin` always returns something
 * renderable, and `errors` means "this pin will draw a placeholder", never "discard it".
 *
 * The defaults below are the ones a GM who never opens Pin Studio gets, so they are
 * chosen to be the good result rather than the neutral one — with the deliberate
 * exception of `audience`, which starts hidden. Placement applies the configured
 * reveal default on top; the stored zero value must be the safe one, because an
 * unparseable flag falling back to "visible to everyone" would leak a document.
 */

import { SCHEMA_VERSION } from "../const";
import { bool, int, num, obj, oneOf, str, stringList, warnUnknownKeys } from "../normalise";
import type {
  DpAudience,
  DpAudienceKind,
  DpDisplay,
  DpEffectRef,
  DpGeometry,
  DpInteraction,
  DpNotice,
  DpPinFlags,
  DpSource,
} from "../types/dp";
import { makeAudience } from "./audience";

export const PIN_SCHEMA_VERSION = SCHEMA_VERSION;

export interface PinValidationResult {
  /** Always usable. Never null — see the note on rejection above. */
  pin: DpPinFlags;
  /** Conditions under which the pin renders a placeholder rather than its source. */
  errors: DpNotice[];
  warnings: DpNotice[];
}

const MODES = ["pin", "prop"] as const;
const SOURCE_KINDS = ["document", "image"] as const;
const MOTIONS = ["loop", "onReveal", "none"] as const;
const AUDIENCE_KINDS = ["hidden", "everyone", "selected", "discovered"] as const;
const OPEN_MODES = ["single", "double", "readInPlace", "never"] as const;

const BAD_ENUM = "DP.pin.warn.badEnum";
const UNKNOWN_KEY = "DP.pin.warn.unknownKey";

/**
 * Keys a previous schema stored and this one does not.
 *
 * Dropped silently rather than reported: a payload written by version 1 is not a
 * stranger's typo, and warning about it on every read until the migration sweeps it
 * would be noise about a decision the module made. Nothing ever read any of them.
 */
const RETIRED = {
  display: ["showLabel", "labelPosition"],
  interaction: ["openPage", "clickThrough"],
} as const;

function withoutRetired(
  input: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out = { ...input };
  for (const key of keys) delete out[key];
  return out;
}

/** Preset ids, matching the rule in `preset-schema.ts`. */
const EFFECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A per-pin parameter override key: a `DpPresetParams` field, optionally inside its
 * group — `blur`, or `tint.amount`. Overrides are stored as a flat dotted map rather
 * than a nested object because a nested one would have to be merged group by group,
 * and a shallow merge of `{ tint: { amount } }` silently drops the sibling colour.
 */
const PARAM_KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)?$/;
const MAX_PARAM_OVERRIDES = 64;

/** Schemes an asset path may carry. Anything else is a paste accident at best. */
const ALLOWED_SCHEME = /^(?:https?):/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MAX_PATH = 1024;

/**
 * The type-size contract.
 *
 * `LINES_PER_SHORT_EDGE` is the legacy derive — ~26 lines of body text down a card's
 * short edge reads as a letter, not a poster — and still decides what a freshly placed
 * prop looks like, through `defaultTypeSize`. The bounds are legibility: below 6 px
 * nothing is text, and above 200 px a single word is a poster. Margins are in em of the
 * type size; six ems of margin on each side is where a card stops having content.
 */
export const LINES_PER_SHORT_EDGE = 26;
export const TYPE_SIZE_MIN = 6;
export const TYPE_SIZE_MAX = 200;
export const MARGIN_MAX_EM = 6;
/** ~23 px at the default type on a 100 px grid, against the legacy 24 px. */
export const DEFAULT_MARGIN_EM = 1.5;

/**
 * The largest PDF page number a pin may name.
 *
 * A ceiling rather than a real limit: no PDF anyone pins to a map has a hundred thousand
 * pages, so a value past this is not a page number at all. It is also what makes the
 * legacy fold below safe — see `LEGACY_PDF_PAGE`.
 */
export const PDF_PAGE_MAX = 99_999;

export function defaultSource(): DpSource {
  return {
    kind: "document",
    uuid: null,
    src: null,
    pageId: null,
    pdfPage: null,
    followName: true,
  };
}

export function defaultDisplay(): DpDisplay {
  return {
    label: "",
    paper: "parchment",
    showTitle: true,
    padding: 0.06,
    typeSize: null,
    margin: null,
    fadeUnderTokens: true,
    fadeUnderTokensAlpha: 0.25,
  };
}

export function defaultGeometry(): DpGeometry {
  return { pin: null, prop: null };
}

export function defaultEffect(): DpEffectRef {
  return { id: "none", intensity: 0.6, speed: 1, seed: 0, motion: "loop", params: {} };
}

export function defaultInteraction(): DpInteraction {
  return { open: "double", tooltip: "" };
}

/**
 * Build a pin from partial overrides. As in `defaultPreset`, each GROUP given must be
 * complete, so a typo cannot quietly reset a sibling field without the compiler
 * noticing.
 */
export function defaultPin(overrides: Partial<DpPinFlags> = {}): DpPinFlags {
  return {
    v: PIN_SCHEMA_VERSION,
    mode: "prop",
    source: defaultSource(),
    display: defaultDisplay(),
    geometry: defaultGeometry(),
    effect: defaultEffect(),
    audience: makeAudience(),
    interaction: defaultInteraction(),
    ...overrides,
  };
}

/**
 * A file path or URL for an image/video source.
 *
 * Control characters are already gone by the time `str` returns; what is left to
 * reject is a scheme that has no business being a texture (`javascript:`, `data:`) and
 * a path long enough that it is not a path. An over-long value is dropped rather than
 * truncated: half a path renders as a broken image with no clue why.
 */
function assetPath(value: unknown, warnings: DpNotice[], path: string): string | null {
  if (typeof value !== "string") return null;
  const clean = str(value, "", MAX_PATH + 1);
  if (!clean) return null;
  if (clean.length > MAX_PATH || (HAS_SCHEME.test(clean) && !ALLOWED_SCHEME.test(clean))) {
    warnings.push({ key: "DP.pin.warn.badPath", data: { path, value: clean.slice(0, 64) } });
    return null;
  }
  return clean;
}

/**
 * A `pageId` that is really a PDF page number.
 *
 * Until schema 4 one field carried both meanings: `resolveSource` read it as a
 * JournalEntryPage id, `ContentResolver.pageOf` read it as a one-based PDF page. A
 * Foundry id is exactly sixteen alphanumeric characters, so a string of one to five
 * digits can never be one — which is what makes the fold safe rather than a guess.
 */
const LEGACY_PDF_PAGE = /^\d{1,5}$/;

/**
 * A one-based page number, floored, or `null`.
 *
 * Not `nullableNum`: that returns a float, and half a page is not a page. Flooring
 * rather than rounding, so 3.9 is page 3 — the page the number is inside.
 */
function pageNumber(value: unknown): number | null {
  const n = nullableNum(value, 1, PDF_PAGE_MAX);
  return n === null ? null : Math.floor(n);
}

function normaliseSource(raw: unknown, warnings: DpNotice[], errors: DpNotice[]): DpSource {
  const d = defaultSource();
  const s = obj(raw);
  warnUnknownKeys(s, Object.keys(d), warnings, "source", UNKNOWN_KEY);

  // Schema 3 and earlier stored a PDF page number in `pageId`. Folded HERE and not in
  // `migrations.ts` for the reason `clickThrough` is folded here: a player's client that
  // loads before the primary GM's sweep must already behave as a migrated one. In the
  // migration, it would read `pageId: "7"`, miss on `doc.pages.get("7")`, fall back to
  // the entry and draw page 1 — while the GM, already swept, saw page 7.
  // Through `pageNumber`, not a raw `Number`: a stored "0" would otherwise be folded as
  // page 0, clamped to 1 on the NEXT read, and the payload would differ from itself
  // between two passes — which costs `planMigration` a second write for no change.
  const legacyPdfPage = LEGACY_PDF_PAGE.test(String(s.pageId ?? "")) ? pageNumber(s.pageId) : null;

  const kind = oneOf(s.kind, SOURCE_KINDS, d.kind, warnings, "source.kind", BAD_ENUM);
  const source: DpSource = {
    kind,
    uuid: typeof s.uuid === "string" ? str(s.uuid, "", 256) || null : null,
    src: assetPath(s.src, warnings, "source.src"),
    pageId:
      legacyPdfPage !== null || typeof s.pageId !== "string" ? null : str(s.pageId, "", 64) || null,
    // An explicit `pdfPage` wins over a folded one, so re-reading an already-folded
    // payload is stable — which is what keeps `planMigration` idempotent.
    pdfPage: pageNumber(s.pdfPage) ?? legacyPdfPage,
    followName: bool(s.followName, d.followName),
  };

  // The anchor survives a source it cannot resolve — it draws a placeholder — but the
  // GM has to be told, because from the map a placeholder looks like a rendering bug.
  if (kind === "document" && !source.uuid) errors.push({ key: "DP.pin.error.missingSource" });
  if (kind === "image" && !source.src) errors.push({ key: "DP.pin.error.missingSource" });

  return source;
}

function normaliseDisplay(raw: unknown, warnings: DpNotice[]): DpDisplay {
  const d = defaultDisplay();
  const s = withoutRetired(obj(raw), RETIRED.display);
  warnUnknownKeys(s, Object.keys(d), warnings, "display", UNKNOWN_KEY);

  return {
    label: str(s.label, d.label),
    paper: str(s.paper, d.paper, 64) || d.paper,
    showTitle: bool(s.showTitle, d.showTitle),
    // Half the short edge is the point at which padding leaves no content area at all.
    padding: num(s.padding, d.padding, 0, 0.5),
    typeSize: nullableNum(s.typeSize, TYPE_SIZE_MIN, TYPE_SIZE_MAX),
    margin: nullableNum(s.margin, 0, MARGIN_MAX_EM),
    fadeUnderTokens: bool(s.fadeUnderTokens, d.fadeUnderTokens),
    fadeUnderTokensAlpha: num(s.fadeUnderTokensAlpha, d.fadeUnderTokensAlpha, 0, 1),
  };
}

/**
 * A number clamped into `[min, max]`, or `null` for anything that is not one.
 *
 * `null` is a real value here, not an absence: it means "derive it", and a string that
 * fails to parse must become that rather than a silent default the GM never chose.
 */
function nullableNum(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * A remembered size, or `null` to derive one.
 *
 * The bounds are the scene-pixel range a placeable can usefully occupy: below one
 * pixel it is unclickable, and a size beyond 64k would blow past MAX_TEXTURE_SIZE on
 * every GPU. A partially-specified size is discarded rather than half-honoured.
 */
function modeSize(raw: unknown): { width: number; height: number } | null {
  const s = obj(raw);
  if (typeof s.width !== "number" || typeof s.height !== "number") return null;
  const width = num(s.width, 0, 1, 65_536);
  const height = num(s.height, 0, 1, 65_536);
  return width && height ? { width, height } : null;
}

function normaliseGeometry(raw: unknown, warnings: DpNotice[]): DpGeometry {
  const s = obj(raw);
  warnUnknownKeys(s, ["pin", "prop"], warnings, "geometry", UNKNOWN_KEY);
  return { pin: modeSize(s.pin), prop: modeSize(s.prop) };
}

/**
 * Per-pin overrides on top of the preset's parameters.
 *
 * Bounded and shape-checked here, then re-validated by `validatePreset` once merged,
 * so a hand-edited flag cannot smuggle a value past the preset's own clamps.
 */
function normaliseParams(raw: unknown, warnings: DpNotice[]): Record<string, unknown> {
  const source = obj(raw);
  const out: Record<string, unknown> = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(source)) {
    const scalar =
      typeof value === "number" || typeof value === "boolean" || typeof value === "string";
    if (!PARAM_KEY.test(key) || !scalar || Object.keys(out).length >= MAX_PARAM_OVERRIDES) {
      dropped++;
      continue;
    }
    out[key] = typeof value === "string" ? str(value, "", 128) : value;
  }

  if (dropped) warnings.push({ key: "DP.pin.warn.droppedParams", data: { count: dropped } });
  return out;
}

function normaliseEffect(raw: unknown, warnings: DpNotice[]): DpEffectRef {
  const d = defaultEffect();
  const s = obj(raw);
  warnUnknownKeys(s, Object.keys(d), warnings, "effect", UNKNOWN_KEY);

  // Read past the id length limit on purpose: truncating to 64 would turn an
  // over-long id into one that passes EFFECT_ID, silently pointing at a preset
  // nobody authored. Let the pattern reject it instead.
  const id = str(s.id, d.id, 128).toLowerCase();
  return {
    id: EFFECT_ID.test(id) ? id : d.id,
    intensity: num(s.intensity, d.intensity, 0, 1),
    // Above 4x an animation reads as a strobe rather than an effect.
    speed: num(s.speed, d.speed, 0, 4),
    // Stored, never derived, so every client's glitch lands on the same pixels.
    seed: int(s.seed, d.seed, 0, 0xffffffff),
    motion: oneOf(s.motion, MOTIONS, d.motion, warnings, "effect.motion", BAD_ENUM),
    params: normaliseParams(s.params, warnings),
  };
}

function normaliseAudience(raw: unknown, warnings: DpNotice[]): DpAudience {
  const d = makeAudience();
  const s = obj(raw);
  warnUnknownKeys(s, Object.keys(d), warnings, "audience", UNKNOWN_KEY);

  const restore = obj(s.restore);
  const restoreKind = s.restore
    ? oneOf(
        restore.kind,
        AUDIENCE_KINDS.filter((k) => k !== "hidden") as Exclude<DpAudienceKind, "hidden">[],
        "everyone",
        warnings,
        "audience.restore.kind",
        BAD_ENUM
      )
    : null;

  const sync = obj(s.ownershipSync);
  return {
    kind: oneOf(s.kind, AUDIENCE_KINDS, d.kind, warnings, "audience.kind", BAD_ENUM),
    users: stringList(s.users),
    discovered: stringList(s.discovered),
    sticky: bool(s.sticky, d.sticky),
    restore: restoreKind ? { kind: restoreKind, users: stringList(restore.users) } : null,
    ownershipSync: {
      enabled: bool(sync.enabled, d.ownershipSync.enabled),
      // Only LIMITED and OBSERVER are offered: LIMITED is the deliberate "tease" and
      // OBSERVER actually opens the page. OWNER is never granted — see DESIGN §4.
      level: sync.level === 1 ? 1 : 2,
    },
  };
}

function normaliseInteraction(raw: unknown, warnings: DpNotice[]): DpInteraction {
  const d = defaultInteraction();
  const raw0 = obj(raw);
  const s = withoutRetired(raw0, RETIRED.interaction);
  warnUnknownKeys(s, Object.keys(d), warnings, "interaction", UNKNOWN_KEY);

  // Version 1's `clickThrough` was indistinguishable from `open: "never"` — both build
  // no hit area — so a pin that had it becomes one, here rather than in the migration:
  // an unmigrated payload on a player's client must already behave as it will after.
  const open =
    raw0.clickThrough === true
      ? "never"
      : oneOf(s.open, OPEN_MODES, d.open, warnings, "interaction.open", BAD_ENUM);

  return {
    open,
    tooltip: str(s.tooltip, d.tooltip),
  };
}

/**
 * Normalise anything found in the pin flag into a usable payload.
 *
 * Accepts a payload from a future version: unknown keys are reported and dropped, so a
 * world opened on an older install degrades to working defaults instead of failing.
 */
export function validatePin(input: unknown): PinValidationResult {
  const errors: DpNotice[] = [];
  const warnings: DpNotice[] = [];
  const raw = obj(input);

  const known: (keyof DpPinFlags)[] = [
    "v",
    "mode",
    "source",
    "display",
    "geometry",
    "effect",
    "audience",
    "interaction",
  ];
  warnUnknownKeys(raw, known, warnings, "", UNKNOWN_KEY);

  const version = Number(raw.v);
  if (Number.isFinite(version) && version > PIN_SCHEMA_VERSION) {
    warnings.push({
      key: "DP.pin.warn.futureVersion",
      data: { found: version, supported: PIN_SCHEMA_VERSION },
    });
  }

  const pin: DpPinFlags = {
    v: PIN_SCHEMA_VERSION,
    mode: oneOf(raw.mode, MODES, "prop", warnings, "mode", BAD_ENUM),
    source: normaliseSource(raw.source, warnings, errors),
    display: normaliseDisplay(raw.display, warnings),
    geometry: normaliseGeometry(raw.geometry, warnings),
    effect: normaliseEffect(raw.effect, warnings),
    audience: normaliseAudience(raw.audience, warnings),
    interaction: normaliseInteraction(raw.interaction, warnings),
  };

  return { pin, errors, warnings };
}

/**
 * A partial pin, for patch-style edits: `{ audience: { kind: "everyone" } }`.
 *
 * Arrays replace rather than merge — a half-merged user list would mean an audience
 * nobody asked for — and so does anything nullable, because "set this back to null"
 * has to be expressible.
 */
export type PinPatch = {
  [K in keyof DpPinFlags]?: DpPinFlags[K] extends unknown[]
    ? DpPinFlags[K]
    : DpPinFlags[K] extends object
      ? { [P in keyof DpPinFlags[K]]?: DpPinFlags[K][P] }
      : DpPinFlags[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * Apply a patch and re-validate.
 *
 * Re-validating is not belt-and-braces: a patch arrives from a form, a keybinding or
 * another module's API call, and the merged result is what gets written to the world.
 * Clamping only on the way in would let a bad patch persist a value the schema says
 * is impossible.
 */
export function mergePin(current: DpPinFlags, patch: PinPatch): PinValidationResult {
  return validatePin(deepMerge(current, patch));
}

/**
 * The size a mode takes when nothing has been remembered for it.
 *
 * A pin is one grid square, matching a Map Note's footprint so the two read as peers
 * on the same map. A prop is a portrait sheet four squares wide — the shape of nearly
 * every letter, warrant and handbill a GM pins. Fitting the height to the content is an
 * action the GM takes (`api.fitToContent`), not something placement does on its own.
 *
 * Pure and shared, because the store, the placement ghost and the mode switch must all
 * arrive at the same number or a pin changes size when you look at it twice.
 */
export function naturalSize(
  mode: DpPinFlags["mode"],
  gridSize: number
): { width: number; height: number } {
  const grid = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 100;
  if (mode === "pin") return { width: grid, height: grid };
  return { width: grid * 4, height: Math.round(grid * 4 * 1.414) };
}

/**
 * The legacy type size: a fixed fraction of the card's short edge.
 *
 * This is what every prop was drawn at before type sizes were stored, and it is still
 * what a `null` type size means. Deliberately not rounded to whole pixels: rounding
 * makes the size only ALMOST proportional to the card, and "almost" is what made type
 * visibly drift as a prop was resized. Fractional font sizes are exact in both CSS and
 * an SVG foreignObject.
 */
export function baseFontSize(width: number, height: number): number {
  const short = Math.max(1, Math.min(width, height));
  return Math.max(8, short / LINES_PER_SHORT_EDGE);
}

export interface CardMetrics {
  /** Type size in card pixels. */
  fontPx: number;
  /** Inner padding in card pixels. */
  padPx: number;
}

/**
 * The two numbers a card is laid out with, from a display and the box it is going into.
 *
 * The single choke point between the stored fields and every renderer. A stored value
 * wins; a `null` derives exactly what the pre-2 schema derived, so an unmigrated
 * payload renders byte-for-byte as it did — on a player client that loaded before the
 * GM's migration ran, or on a scene imported from a pack a year from now.
 */
export function cardMetrics(
  display: DpDisplay,
  size: { width: number; height: number }
): CardMetrics {
  const fontPx = display.typeSize ?? baseFontSize(size.width, size.height);
  const padPx =
    display.margin !== null
      ? Math.round(display.margin * fontPx)
      : Math.round(Math.min(size.width, size.height) * display.padding);
  return { fontPx, padPx };
}

/**
 * The type size a NEW prop gets: what a natural-size prop derived before type sizes
 * were stored, so a freshly placed prop looks exactly as it always has.
 */
export function defaultTypeSize(gridSize: number): number {
  const natural = naturalSize("prop", gridSize);
  return baseFontSize(natural.width, natural.height);
}

/**
 * Replace derived metrics with the numbers that reproduce them at `size`.
 *
 * The migration, the mode switch and the Studio all call this at the moment a prop's
 * proportional look is about to become a stored one: the pixels on screen do not
 * change, only what the next resize does. Stored numbers are left alone; a payload
 * with both stored is returned as-is, so this is idempotent and cheap to call twice.
 */
export function freezeMetrics(
  pin: DpPinFlags,
  size: { width: number; height: number }
): DpPinFlags {
  if (pin.display.typeSize !== null && pin.display.margin !== null) return pin;
  const { fontPx, padPx } = cardMetrics(pin.display, size);
  const typeSize = pin.display.typeSize ?? num(fontPx, fontPx, TYPE_SIZE_MIN, TYPE_SIZE_MAX);
  const margin =
    pin.display.margin ?? num(Number((padPx / typeSize).toFixed(4)), 0, 0, MARGIN_MAX_EM);
  return { ...pin, display: { ...pin.display, typeSize, margin } };
}

/** Whether a payload describes a pin that can actually resolve its source. */
export function hasResolvableSource(pin: DpPinFlags): boolean {
  return pin.source.kind === "document" ? !!pin.source.uuid : !!pin.source.src;
}
