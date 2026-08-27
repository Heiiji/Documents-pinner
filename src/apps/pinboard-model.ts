/**
 * The Pinboard's list logic.
 *
 * PURE: filtering, searching, range selection and reordering, with no DOM and no
 * Foundry. The Pinboard is the surface a GM drives during play with one hand and half
 * their attention, so its behaviour is exactly the kind that has to be right without
 * being manually re-tested every session.
 *
 * The one rule everything here serves: **row order IS reveal order.** A hand-sorted
 * Pinboard is a lightweight scene script — "the letter, then the rune, then the
 * ransom note" — so reordering persists to `sort`, filtering never reorders, and a
 * range selection follows what the GM can see rather than the underlying list.
 */

import type { DpMode } from "../types/dp";
import type { ChipUser } from "./chips";

export type PinboardFilter = "all" | "visible" | "hidden" | "props" | "pins";

export interface PinboardRow {
  id: string;
  name: string;
  /** "Journal › Page", shown on hover so the list can stay one line per pin. */
  breadcrumb: string;
  mode: DpMode;
  /** Whether anyone at all can currently see it. Not the core `hidden` field alone. */
  visible: boolean;
  effectId: string;
  effectLabel: string;
  sort: number;
  elevation: number;
  locked: boolean;
  /** Null when the source is gone — the row still exists, which is the point. */
  thumbnail: string | null;
  users: ChipUser[];
}

export interface PinboardQuery {
  filter: PinboardFilter;
  search: string;
  /** Restrict to one scene level. `null` shows every level. */
  level: number | null;
}

/**
 * Fold case and diacritics so a French GM typing "epee" finds "Épée".
 *
 * Search that only matches the exact accents is search that fails precisely when
 * someone is in a hurry, which is the only time this box gets used.
 */
export function fold(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function matchesFilter(row: PinboardRow, filter: PinboardFilter): boolean {
  switch (filter) {
    case "visible":
      return row.visible;
    case "hidden":
      return !row.visible;
    case "props":
      return row.mode === "prop";
    case "pins":
      return row.mode === "pin";
    case "all":
    default:
      return true;
  }
}

/** Filtering never reorders: the list a GM reads is always the order they arranged. */
export function filterRows(rows: readonly PinboardRow[], query: PinboardQuery): PinboardRow[] {
  const needle = fold(query.search.trim());

  return rows.filter((row) => {
    if (!matchesFilter(row, query.filter)) return false;
    if (query.level !== null && row.elevation !== query.level) return false;
    if (!needle) return true;
    return fold(row.name).includes(needle) || fold(row.breadcrumb).includes(needle);
  });
}

/**
 * The ids covered by a shift-range selection.
 *
 * Computed over the VISIBLE rows, not the full list: a GM who filtered to "hidden" and
 * shift-selected from the first to the last expects the eight hidden pins, not the
 * twelve rows that happen to lie between them underneath the filter.
 */
export function rangeSelect(
  visible: readonly PinboardRow[],
  fromId: string,
  toId: string
): string[] {
  const from = visible.findIndex((r) => r.id === fromId);
  const to = visible.findIndex((r) => r.id === toId);
  if (from < 0 || to < 0) return from < 0 && to < 0 ? [] : [fromId || toId];

  const [start, end] = from <= to ? [from, to] : [to, from];
  return visible.slice(start, end + 1).map((r) => r.id);
}

export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

export interface SortUpdate {
  id: string;
  sort: number;
}

/**
 * Move one row and return the `sort` values that actually changed.
 *
 * Sorts are rewritten as evenly-spaced multiples rather than squeezed between their
 * neighbours: repeated midpoint insertion converges on equal values, and two pins
 * sharing a sort makes the reveal order silently depend on document id.
 *
 * Only changed rows are returned, so a drag that lands where it started writes nothing.
 */
export function planReorder(
  rows: readonly PinboardRow[],
  movedId: string,
  targetIndex: number
): SortUpdate[] {
  const from = rows.findIndex((r) => r.id === movedId);
  if (from < 0) return [];

  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, targetIndex)), 0, moved);

  const updates: SortUpdate[] = [];
  next.forEach((row, index) => {
    const sort = index * 10;
    if (row.sort !== sort) updates.push({ id: row.id, sort });
  });
  return updates;
}

export interface PinboardCounts {
  total: number;
  visible: number;
  hidden: number;
  props: number;
  pins: number;
  /** Rows where at least one player sees the pin but cannot open the document. */
  mismatched: number;
}

/** Footer counts, so the scene's state is legible without reading every row. */
export function summarise(rows: readonly PinboardRow[]): PinboardCounts {
  return {
    total: rows.length,
    visible: rows.filter((r) => r.visible).length,
    hidden: rows.filter((r) => !r.visible).length,
    props: rows.filter((r) => r.mode === "prop").length,
    pins: rows.filter((r) => r.mode === "pin").length,
    mismatched: rows.filter((r) => r.users.some((u) => u.canSee !== u.canOpen)).length,
  };
}

/** Every distinct elevation in use, so the level filter only offers real levels. */
export function levelsIn(rows: readonly PinboardRow[]): number[] {
  return [...new Set(rows.map((r) => r.elevation))].sort((a, b) => a - b);
}

/**
 * Where the keyboard goes next.
 *
 * Clamped rather than wrapping: in a list a GM is stepping through under pressure,
 * wrapping from the last row back to the first reads as "nothing happened" and costs
 * them the position they had.
 */
export function focusIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}
