/**
 * Module-wide constants.
 *
 * This module must never touch Foundry globals (`game`, `foundry`, `ui`, `CONST`,
 * `canvas`) at import time — only inside function bodies — so that the pure logic
 * importing it stays unit-testable under Node/vitest.
 */

export const MODULE_ID = "documents-pinner";

/**
 * Version of the `flags[MODULE_ID].pin` payload. Bump when the shape changes.
 *
 * 2: the type size and margin are stored per pin (a prop is a window, not a zoom), and
 *    four fields nothing read are gone — `display.showLabel`, `display.labelPosition`,
 *    `interaction.openPage`, `interaction.clickThrough` (folded into `open: "never"`).
 */
export const SCHEMA_VERSION = 2;

/** Version of the `flags[MODULE_ID].grants` ownership ledger. */
export const LEDGER_VERSION = 1;

/** Flag keys, always addressed through these constants — never as string literals. */
export const FLAGS = {
  /** Per-anchor pin configuration. Lives on the anchor TileDocument. */
  PIN: "pin",
  /** Reversible ownership ledger. Lives on the *source* document. */
  GRANTS: "grants",
} as const;

/**
 * Marks a document update as originating from this module, so our own hooks can
 * early-return and never feed back into themselves.
 */
export const INTERNAL_OPTION = "documentsPinnerInternal";

/** Ownership levels, mirroring CONST.DOCUMENT_OWNERSHIP_LEVELS without importing it. */
export const OWNERSHIP = {
  INHERIT: -1,
  NONE: 0,
  LIMITED: 1,
  OBSERVER: 2,
  OWNER: 3,
} as const;

/** The ownership record key meaning "every user without an explicit entry". */
export const DEFAULT_KEY = "default";

/**
 * Foundry's deletion operator for a record key.
 *
 * NOTE: v14.349 deprecated the special `-=` / `==` operation keys in favour of
 * `DataFieldOperator` values. `-=` still works in v14 but will be removed; it is
 * isolated here so the migration is a one-line change.
 */
export const DELETE_PREFIX = "-=";

/** Apparent-width thresholds (CSS px) that drive the level-of-detail ladder. */
export const LOD = {
  /** Below this, render a flat tinted silhouette with no effect. */
  SILHOUETTE: 48,
  /** Below this, render at reduced texture resolution and half effect intensity. */
  COARSE: 320,
  /** At or above this, the focused DOM reader is allowed to open. */
  READER: 480,
} as const;

/** Texture resolution tiers, snapped to powers of two so a slow zoom cannot thrash. */
export const RES_TIERS = [256, 512, 1024, 2048] as const;

/**
 * The texture EVERY anchor is created with, whatever its mode.
 *
 * Not cosmetic. Core does not add a tile with no valid texture to `canvas.primary`, so
 * an anchor written with `texture: { src: null }` has no `mesh` — and with no mesh
 * there is nothing for the rasteriser to bind its result to, which is a prop that
 * silently never appears no matter how well the rest of the pipeline works. A pin shows
 * this as its icon; a prop shows it for the moment before its own texture is drawn.
 */
export const PLACEHOLDER_TEXTURE = "icons/svg/book.svg";

export const DEFAULTS = {
  /** GPU texture budget in bytes before the LRU starts demoting props. */
  vramBudget: 256 * 1024 * 1024,
  /** Milliseconds to wait after the stage transform settles before recomputing LOD. */
  lodDebounce: 100,
  /** Milliseconds to coalesce source-document edits before re-rasterising. */
  editDebounce: 250,
  /** Ownership level granted when reveal syncs ownership. */
  ownershipLevel: OWNERSHIP.OBSERVER,
} as const;
