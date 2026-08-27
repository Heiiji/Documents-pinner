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
const LABEL_POSITIONS = ["above", "below", "inside", "none"] as const;
const MOTIONS = ["loop", "onReveal", "none"] as const;
const AUDIENCE_KINDS = ["hidden", "everyone", "selected", "discovered"] as const;
const OPEN_MODES = ["single", "double", "readInPlace", "never"] as const;

const BAD_ENUM = "DP.pin.warn.badEnum";
const UNKNOWN_KEY = "DP.pin.warn.unknownKey";

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

export function defaultSource(): DpSource {
  return { kind: "document", uuid: null, src: null, pageId: null, followName: true };
}

export function defaultDisplay(): DpDisplay {
  return {
    label: "",
    showLabel: true,
    labelPosition: "below",
    paper: "parchment",
    showTitle: true,
    padding: 0.06,
    fadeUnderTokens: true,
    fadeUnderTokensAlpha: 0.25,
  };
}

export function defaultEffect(): DpEffectRef {
  return { id: "none", intensity: 0.6, speed: 1, seed: 0, motion: "loop", params: {} };
}

export function defaultInteraction(): DpInteraction {
  return { open: "double", openPage: true, clickThrough: false, tooltip: "" };
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

function normaliseSource(raw: unknown, warnings: DpNotice[], errors: DpNotice[]): DpSource {
  const d = defaultSource();
  const s = obj(raw);
  warnUnknownKeys(s, Object.keys(d), warnings, "source", UNKNOWN_KEY);

  const kind = oneOf(s.kind, SOURCE_KINDS, d.kind, warnings, "source.kind", BAD_ENUM);
  const source: DpSource = {
    kind,
    uuid: typeof s.uuid === "string" ? str(s.uuid, "", 256) || null : null,
    src: assetPath(s.src, warnings, "source.src"),
    pageId: typeof s.pageId === "string" ? str(s.pageId, "", 64) || null : null,
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
  const s = obj(raw);
  warnUnknownKeys(s, Object.keys(d), warnings, "display", UNKNOWN_KEY);

  return {
    label: str(s.label, d.label),
    showLabel: bool(s.showLabel, d.showLabel),
    labelPosition: oneOf(
      s.labelPosition,
      LABEL_POSITIONS,
      d.labelPosition,
      warnings,
      "display.labelPosition",
      BAD_ENUM
    ),
    paper: str(s.paper, d.paper, 64) || d.paper,
    showTitle: bool(s.showTitle, d.showTitle),
    // Half the short edge is the point at which padding leaves no content area at all.
    padding: num(s.padding, d.padding, 0, 0.5),
    fadeUnderTokens: bool(s.fadeUnderTokens, d.fadeUnderTokens),
    fadeUnderTokensAlpha: num(s.fadeUnderTokensAlpha, d.fadeUnderTokensAlpha, 0, 1),
  };
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
  const s = obj(raw);
  warnUnknownKeys(s, Object.keys(d), warnings, "interaction", UNKNOWN_KEY);

  return {
    open: oneOf(s.open, OPEN_MODES, d.open, warnings, "interaction.open", BAD_ENUM),
    openPage: bool(s.openPage, d.openPage),
    clickThrough: bool(s.clickThrough, d.clickThrough),
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
    effect: normaliseEffect(raw.effect, warnings),
    audience: normaliseAudience(raw.audience, warnings),
    interaction: normaliseInteraction(raw.interaction, warnings),
  };

  return { pin, errors, warnings };
}

/** Whether a payload describes a pin that can actually resolve its source. */
export function hasResolvableSource(pin: DpPinFlags): boolean {
  return pin.source.kind === "document" ? !!pin.source.uuid : !!pin.source.src;
}
