/**
 * Types for OUR data. Foundry's own surface is left loose on purpose: the module's
 * bugs live in the pin payload and the ownership ledger, so those are typed exactly.
 */

export type DpMode = "pin" | "prop";

export type DpAudienceKind = "hidden" | "everyone" | "selected" | "discovered";

export interface DpSource {
  /** A world/compendium document, or a bare image or video file. */
  kind: "document" | "image";
  /** UUID when `kind === "document"`. */
  uuid: string | null;
  /** File path when `kind === "image"`. */
  src: string | null;
  /** Optional page within a JournalEntry. */
  pageId: string | null;
  /** Keep the label in step with the source document's name. */
  followName: boolean;
}

export interface DpDisplay {
  /** Empty string means "use the source document's name". */
  label: string;
  showLabel: boolean;
  labelPosition: "above" | "below" | "inside" | "none";
  /** Asset key for the card backing (parchment, vellum, plain…). */
  paper: string;
  showTitle: boolean;
  /** Inner padding as a fraction of the card's short edge, 0–0.5. */
  padding: number;
  fadeUnderTokens: boolean;
  /** Alpha the prop fades to when a token overlaps it, 0–1. */
  fadeUnderTokensAlpha: number;
}

export interface DpOwnershipSync {
  enabled: boolean;
  /** LIMITED (1) is the deliberate "tease"; OBSERVER (2) actually opens. */
  level: 1 | 2;
}

export interface DpAudience {
  kind: DpAudienceKind;
  /** User ids, for `kind === "selected"`. */
  users: string[];
  /** User ids who have already discovered it, for `kind === "discovered"`. */
  discovered: string[];
  /** Whether a discovery, once made, persists. */
  sticky: boolean;
  /** What the eye toggle restores when un-hiding. */
  restore: { kind: Exclude<DpAudienceKind, "hidden">; users: string[] } | null;
  ownershipSync: DpOwnershipSync;
}

export interface DpEffectRef {
  id: string;
  /** 0–1. */
  intensity: number;
  /** Animation rate multiplier. */
  speed: number;
  /** Stored, never derived, so every client glitches identically. */
  seed: number;
  motion: "loop" | "onReveal" | "none";
  /** Per-pin parameter overrides on top of the preset. */
  params: Record<string, unknown>;
}

export interface DpInteraction {
  open: "single" | "double" | "readInPlace" | "never";
  /** Open the specific page rather than the whole entry. */
  openPage: boolean;
  /** Let pointer events fall through to the canvas when `open === "never"`. */
  clickThrough: boolean;
  tooltip: string;
}

/** The full `flags["documents-pinner"].pin` payload on an anchor TileDocument. */
export interface DpPinFlags {
  v: number;
  mode: DpMode;
  source: DpSource;
  display: DpDisplay;
  effect: DpEffectRef;
  audience: DpAudience;
  interaction: DpInteraction;
}

/**
 * The `flags["documents-pinner"].grants` ledger on a SOURCE document.
 *
 * Keys throughout are ownership keys: either the literal `"default"` or a user id.
 */
export interface DpGrantLedger {
  v: number;
  /** Ownership as it was before we touched anything. `null` = the key was absent. */
  baseline: Record<string, number | null>;
  /** The value we actually wrote, so we can detect a later manual edit. */
  granted: Record<string, number>;
  /** key → { anchorUuid: requestedLevel }. A key is released when this empties. */
  holders: Record<string, Record<string, number>>;
  /** Keys where a GM edit overrode us; surfaced as a badge, never silently reverted. */
  overridden: string[];
}

/** An i18n key plus format data, returned instead of prose by pure modules. */
export interface DpNotice {
  key: string;
  data?: Record<string, unknown>;
}
