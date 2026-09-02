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
  /**
   * Which page of a pinned `JournalEntry` is shown and opened, by its `_id`.
   *
   * Null means the entry's first page, which is what the module has always drawn.
   * Never a number: until schema 4 this field was ALSO read as a one-based PDF page,
   * and one field cannot answer "page 4 of the journal, whose page 4 is a PDF, at its
   * page 7". `pdfPage` answers the second half.
   */
  pageId: string | null;
  /**
   * Which page of a PDF is drawn, one-based, as pdf.js counts.
   *
   * Null means the first page. Independent of `pageId` because the two describe
   * different documents: `pageId` picks a page OF a journal, `pdfPage` picks a page
   * INSIDE the PDF that page turned out to be.
   */
  pdfPage: number | null;
  /** Keep the label in step with the source document's name. */
  followName: boolean;
}

export interface DpDisplay {
  /** Empty string means "use the source document's name". */
  label: string;
  /** Asset key for the card backing (parchment, vellum, plain…). */
  paper: string;
  showTitle: boolean;
  /**
   * Legacy: inner padding as a fraction of the card's short edge, 0–0.5.
   *
   * Read only while `margin` is null, and never written by this version. It stays in
   * the schema so a payload from before type sizes existed neither warns nor changes.
   */
  padding: number;
  /**
   * Type size in SCENE pixels, independent of the tile's size.
   *
   * This is what makes a prop a window onto its document rather than a zoom of it:
   * the tile decides how much of the page shows, the type size decides how large the
   * words are. `null` means "derive the legacy proportional size from the tile" — see
   * `cardMetrics` — which is exactly what every prop did before this field existed.
   */
  typeSize: number | null;
  /**
   * Inner margin in em of the type size, 0–6.
   *
   * Em rather than a fraction of the short edge, or growing a tile to show more lines
   * would also grow the margins — the opposite of a window. `null` derives from the
   * legacy `padding` fraction.
   */
  margin: number | null;
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

/**
 * Remembered size per mode, so switching pin <-> prop is lossless.
 *
 * `null` means "derive it": a prop fits its content, a pin takes the grid size. A GM
 * who hand-resized either mode gets that size back when they switch away and return,
 * which is what makes the switch a view change rather than an edit.
 */
export interface DpGeometry {
  pin: { width: number; height: number } | null;
  prop: { width: number; height: number } | null;
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
  /** `never` also lets pointer events fall through: no hit area is built at all. */
  open: "single" | "double" | "readInPlace" | "never";
  tooltip: string;
}

/** The full `flags["documents-pinner"].pin` payload on an anchor TileDocument. */
export interface DpPinFlags {
  v: number;
  mode: DpMode;
  source: DpSource;
  display: DpDisplay;
  geometry: DpGeometry;
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
