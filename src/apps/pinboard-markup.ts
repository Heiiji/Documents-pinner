/**
 * The Pinboard's markup, and the rows it is drawn from: the filter bar, the rows, the two
 * row menus and where they sit, the bulk bar, Reveal next, and the shortcut line.
 *
 * IMPURE in what it reads, never in what it does: `rowsFor` reads the scene's pins and
 * what each source is, and the markup reads the preset library for its swatches; nothing
 * here writes or listens. The list logic — filters, search, order, Reveal next's choice —
 * is `pinboard-model.ts`, which is pure. `Pinboard` re-exports `rowsFor`, `boardMarkup`,
 * `placeMenu`, `boardHelp` and the menu types, which the tests read there.
 */

import { PLACEHOLDER_TEXTURE } from "../const";
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import * as store from "../data/PinStore";
import { readPin } from "../data/PinData";
import { describeSource, type SourceSummary } from "../sources/describe";
import { adapterOrJournal } from "../sources/index";
import { allPresets, findPreset, presetName } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { modifierGlyphs, platform } from "../ui/modifiers";
import { chipsMarkup } from "./chips";
import { chipUsersFor } from "./PinHUD";
import {
  filterRows,
  levelsIn,
  nextToReveal,
  summarise,
  type PinboardFilter,
  type PinboardQuery,
  type PinboardRow,
} from "./pinboard-model";

const FILTERS: { id: PinboardFilter; key: string; icon?: string }[] = [
  { id: "all", key: "DP.board.filterAll" },
  { id: "visible", key: "DP.board.filterVisible" },
  { id: "hidden", key: "DP.board.filterHidden" },
  { id: "props", key: "DP.board.filterProps" },
  { id: "pins", key: "DP.board.filterPins" },
  { id: "mismatch", key: "DP.board.filterMismatch", icon: "fa-key" },
];

/**
 * Build the row model for a scene. The only place documents become plain data.
 *
 * On top of `api.rowFacts`, the facts Reveal next chooses by, so the row the board shows
 * as next and the row the verb reveals cannot disagree. The chips are built once and
 * handed in as the facts' users.
 */
export function rowsFor(scene: any): PinboardRow[] {
  return store.all(scene).flatMap((doc: any) => {
    const pin = readPin(doc);
    const users = chipUsersFor(doc);
    const facts = api.rowFacts(doc, users);
    if (!pin || !facts) return [];
    const summary = describeSource(pin.source);
    // The library, not just the shipped ten, or a user preset shows as a raw id.
    const preset = findPreset(pin.effect.id);

    return {
      ...facts,
      effectId: pin.effect.id,
      effectLabel: preset ? presetName(preset) : pin.effect.id,
      sort: doc.sort ?? 0,
      locked: doc.locked === true,
      thumbnail: thumbnailFor(doc, summary),
      icon: summary.icon,
      canShow: adapterOrJournal(summary.documentName).canShow,
      users,
    };
  });
}

/**
 * A picture that tells this row from the next, or null.
 *
 * The tile's texture only when it is not the placeholder every document pin shares: the
 * thumbnail column used to show the same book on every journal row, which is a column
 * of pixels that says nothing. An image source or an image page shows its image.
 */
function thumbnailFor(doc: any, summary: SourceSummary): string | null {
  const texture = doc.texture?.src ?? null;
  if (texture && texture !== PLACEHOLDER_TEXTURE) return texture;
  return summary.thumbnail;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/**
 * One row, as a grid row of cells.
 *
 * A `listbox` of `option`s used to hold the chips, the effect and two buttons, and an
 * option may not contain anything interactive: a screen reader flattens it to one string
 * and every control inside becomes unreachable. A multi-select `grid` allows both — the
 * row keeps its selection and its roving focus, and each cell may hold a control.
 */
function rowMarkup(
  row: PinboardRow,
  selected: boolean,
  focused: boolean,
  menu: MenuPlacement | null = null
): string {
  const thumb = row.thumbnail
    ? `<img class="dp-row__thumb" src="${escapeAttr(row.thumbnail)}" alt="" loading="lazy">`
    : `<span class="dp-row__thumb dp-row__thumb--icon" aria-hidden="true">` +
      `<i class="fa-solid ${escapeAttr(row.icon ?? "fa-file")}"></i></span>`;
  const cell = (content: string) => `<span class="dp-row__cell" role="gridcell">${content}</span>`;
  const open = (kind: MenuKind) => menu?.id === row.id && (menu.kind ?? "actions") === kind;

  return [
    `<li class="dp-row" role="row" data-dp-id="${escapeAttr(row.id)}"`,
    ` aria-selected="${selected}" tabindex="${focused ? 0 : -1}"`,
    ` data-dp-visible="${row.visible}" data-dp-mode="${row.mode}">`,
    cell(`<span class="dp-row__grip" data-dp-grip draggable="true" aria-hidden="true">⋮⋮</span>`),
    cell(thumb),
    cell(
      `<span class="dp-row__name" data-tooltip-text="${escapeAttr(row.breadcrumb || row.name)}">` +
        `${escapeHtml(row.name)}</span>`
    ),
    cell(`<span class="dp-row__mode">${escapeHtml(t(`DP.board.mode.${row.mode}`))}</span>`),
    cell(chipsMarkup(row.users, { t: tn, size: "sm" })),
    // A menu of the whole library, not a button that stepped through it one save at a
    // time: reaching the tenth preset cost nine writes, and on a revealed prop the table
    // watched every one of them go past.
    cell(
      `<button type="button" class="dp-row__fx" data-action="effectMenu"` +
        ` aria-haspopup="menu" aria-expanded="${open("effect")}"` +
        ` data-tooltip-text="${escapeAttr(t("DP.board.effect"))}">` +
        `${escapeHtml(row.effectLabel)}</button>`
    ),
    cell(
      `<button type="button" class="dp-row__icon" data-action="locate"` +
        ` data-tooltip-text="${escapeAttr(t("DP.board.locate"))}"` +
        ` aria-label="${escapeAttr(t("DP.board.locate"))}">` +
        `<i class="fa-solid fa-crosshairs" aria-hidden="true"></i></button>`
    ),
    cell(
      `<button type="button" class="dp-row__icon" data-action="rowMenu"` +
        ` aria-haspopup="menu" aria-expanded="${open("actions")}"` +
        ` data-tooltip-text="${escapeAttr(t("DP.board.more"))}"` +
        ` aria-label="${escapeAttr(t("DP.board.more"))}">` +
        `<i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>`
    ),
    `</li>`,
  ].join("");
}

/**
 * The shortcut line, in the keyboard's own names.
 *
 * It used to print ⌥, ⇧ and ⌃ to everyone — keys a Windows keyboard does not have, and
 * on a Mac "⌃-click" is a right-click. The handlers accept ⌘ beside Ctrl, so a Mac is
 * told ⌘.
 */
export function boardHelp(glyphs = modifierGlyphs(platform())): string {
  return t("DP.board.help", { alt: glyphs.alt, shift: glyphs.shift, ctrl: glyphs.ctrl });
}

function filterBarMarkup(rows: PinboardRow[], query: PinboardQuery): string {
  const counts = summarise(rows);
  const countFor = (id: PinboardFilter) =>
    id === "all"
      ? counts.total
      : id === "visible"
        ? counts.visible
        : id === "hidden"
          ? counts.hidden
          : id === "props"
            ? counts.props
            : id === "pins"
              ? counts.pins
              : counts.mismatched;

  const chips = FILTERS.map(
    (f) =>
      `<button type="button" class="dp-board__filter" data-action="setFilter"` +
      ` data-dp-filter="${f.id}" aria-pressed="${query.filter === f.id}">` +
      (f.icon ? `<i class="fa-solid ${f.icon}" aria-hidden="true"></i> ` : "") +
      `${escapeHtml(t(f.key))} <span class="dp-board__count">${countFor(f.id)}</span></button>`
  ).join("");

  const levels = levelsIn(rows);
  const levelPicker =
    levels.length > 1
      ? `<select class="dp-board__level" data-action="setLevel" aria-label="${escapeAttr(t("DP.board.level"))}">` +
        `<option value="">${escapeHtml(t("DP.board.allLevels"))}</option>` +
        levels
          .map(
            (l) =>
              `<option value="${l}"${query.level === l ? " selected" : ""}>` +
              `${escapeHtml(t("DP.board.levelN", { level: l }))}</option>`
          )
          .join("") +
        `</select>`
      : "";

  return `<div class="dp-board__filters" role="group">${chips}${levelPicker}</div>`;
}

/** Which of a row's two menus is open. */
export type MenuKind = "actions" | "effect";

/**
 * Where a row menu sits, relative to the board, so the list's clipping cannot cut it.
 *
 * `top` opens it downward from the button; `bottom` opens it upward, for a row near the
 * foot of the list, where a menu opened downward ran off the window and was clipped.
 * `maxHeight` is the room it has, so a long menu scrolls rather than overflowing.
 */
export interface MenuPlacement {
  id: string;
  kind?: MenuKind;
  top?: number;
  bottom?: number;
  right: number;
  maxHeight?: number;
}

/** The placement for a menu under — or, with no room there, over — its button. */
export function placeMenu(
  id: string,
  kind: MenuKind,
  board: { top: number; bottom: number; right: number },
  button: { top: number; bottom: number; right: number },
  wanted = kind === "effect" ? 320 : 220
): MenuPlacement {
  const below = board.bottom - button.bottom;
  const above = button.top - board.top;
  const right = board.right - button.right;
  if (below >= wanted || below >= above) {
    return { id, kind, top: button.bottom - board.top, right, maxHeight: Math.max(80, below - 8) };
  }
  return { id, kind, bottom: board.bottom - button.top, right, maxHeight: Math.max(80, above - 8) };
}

function menuStyle(at: MenuPlacement): string {
  const edge =
    at.bottom !== undefined
      ? `bottom:${Math.round(at.bottom)}px`
      : `top:${Math.round(at.top ?? 0)}px`;
  const cap = at.maxHeight ? `;max-block-size:${Math.round(at.maxHeight)}px` : "";
  return `${edge};right:${Math.round(at.right)}px${cap}`;
}

/**
 * The effect menu: the whole library, each preset drawn as itself, the current one
 * checked. The same swatches as the HUD's gallery, so a GM picks by look rather than by
 * name.
 */
function effectMenuMarkup(row: PinboardRow, at: MenuPlacement): string {
  const items = allPresets()
    .map(
      (preset) =>
        `<button type="button" role="menuitemradio" data-action="menuAct" data-dp-act="effect"` +
        ` data-dp-preset="${escapeAttr(preset.id)}" aria-checked="${preset.id === row.effectId}">` +
        `<span class="dp-menu__swatch dp-card" aria-hidden="true"` +
        ` style="${escapeAttr(swatchStyle(preset))}"></span>` +
        `${escapeHtml(presetName(preset))}</button>`
    )
    .join("");
  return (
    `<div class="dp-menu dp-menu--effects" role="menu" data-dp-id="${escapeAttr(row.id)}"` +
    ` aria-label="${escapeAttr(t("DP.board.effect"))}" style="${menuStyle(at)}">${items}</div>`
  );
}

/**
 * The row menu: every verb the row has, in one place, because the "…" button used to
 * open the Studio, which is what Enter already did — a control that lied about what it
 * was. Anchored to the board rather than inside the row, whose paint containment would
 * clip it.
 */
function menuMarkup(row: PinboardRow, at: MenuPlacement): string {
  if (at.kind === "effect") return effectMenuMarkup(row, at);
  const item = (act: string, key: string, danger = false) =>
    `<button type="button" role="menuitem" data-action="menuAct" data-dp-act="${act}"` +
    `${danger ? ' class="dp-danger"' : ""}>${escapeHtml(t(key))}</button>`;
  return (
    `<div class="dp-menu" role="menu" data-dp-id="${escapeAttr(row.id)}"` +
    ` style="${menuStyle(at)}">` +
    item("visibility", row.visible ? "DP.hud.hide" : "DP.hud.reveal") +
    item("spotlight", "DP.board.menuSpotlight") +
    // Not offered where core cannot show it — an actor, an item. `Shift+S` and the API,
    // which cannot hide a choice, say so instead.
    (row.canShow === false ? "" : item("show", "DP.board.menuShow")) +
    item("shape", "DP.board.menuShape") +
    (row.mode === "prop" ? item("fit", "DP.board.menuFit") : "") +
    item("locate", "DP.board.locate") +
    item("studio", "DP.board.menuStudio") +
    item("delete", "DP.board.deleteSelected", true) +
    `</div>`
  );
}

/**
 * The footer's Reveal next, naming what it will reveal.
 *
 * "Reveal next: The Ledger" rather than a bare verb, because the GM presses it with the
 * table watching and must know which clue goes out before it does. With nothing left it
 * says so in its own label, disabled — a tooltip on a disabled button never shows — and
 * tells "nothing hidden" from "nothing hidden in this view", where the filter is hiding
 * the rest of the script.
 */
function revealNextMarkup(rows: PinboardRow[], query: PinboardQuery): string {
  const { next } = nextToReveal(rows, query);
  if (!next) {
    const key = rows.some((row) => row.hidden)
      ? "DP.board.revealNextNoneInView"
      : "DP.board.revealNextNone";
    return (
      `<button type="button" class="dp-board__next" data-action="revealNext" disabled>` +
      `${escapeHtml(t(key))}</button>`
    );
  }
  return (
    `<button type="button" class="dp-board__next" data-action="revealNext"` +
    ` aria-keyshortcuts="N" data-tooltip-text="${escapeAttr(t("DP.board.revealNextHint"))}">` +
    `${escapeHtml(t("DP.board.revealNext", { name: next.name }))}</button>`
  );
}

export function boardMarkup(
  rows: PinboardRow[],
  query: PinboardQuery,
  selected: readonly string[],
  focusedId: string | null,
  sceneName: string,
  menu: MenuPlacement | null = null,
  status = ""
): string {
  const visible = filterRows(rows, query);
  const counts = summarise(rows);

  // An empty scene says what to do, not just that there is nothing: the gesture that
  // places a pin is Alt-drag from the sidebar, which nothing on screen suggests.
  // A row with one cell, like every other row of the grid.
  const empty = rows.length
    ? `<li class="dp-board__empty" role="row"><span role="gridcell">` +
      `${escapeHtml(t("DP.board.noMatches"))}</span></li>`
    : `<li class="dp-board__empty" role="row"><span role="gridcell">` +
      `<p>${escapeHtml(t("DP.board.noPins"))}</p>` +
      `<p class="dp-board__empty-hint">${escapeHtml(t("DP.board.emptyHint"))}</p>` +
      `<button type="button" data-action="place">${escapeHtml(t("DP.board.place"))}</button>` +
      `</span></li>`;
  const list = visible.length
    ? visible
        .map((row) => rowMarkup(row, selected.includes(row.id), row.id === focusedId, menu))
        .join("")
    : empty;

  // Always rendered, with nothing selected as a state of its own: a bar that appears on
  // the first shift-click steals a row's height from the list at the moment the GM is
  // aiming at it. Stable layout beats an entrance.
  const none = selected.length ? "" : " disabled";
  const bulk =
    `<div class="dp-board__bulk" role="group" aria-label="${escapeAttr(t("DP.board.bulk"))}">` +
    `<span class="dp-board__selected">${escapeHtml(t("DP.board.selectedN", { count: selected.length }))}</span>` +
    `<button type="button" data-action="bulkReveal"${none}>${escapeHtml(t("DP.board.revealSelected"))}</button>` +
    `<button type="button" data-action="bulkHide"${none}>${escapeHtml(t("DP.board.hideSelected"))}</button>` +
    `<button type="button" class="dp-danger" data-action="bulkDelete"${none}>${escapeHtml(t("DP.board.deleteSelected"))}</button>` +
    // The scene's, not the selection's, so never disabled by an empty one — only by a
    // scene with nothing hidden, where it has nothing to do. It sat in the footer one
    // button from "Hide all", which is the one pair on this board where a slip cannot be
    // taken back; here it is apart from both, and it asks first. Named in full, because
    // the group around it is named for the selection it does not act on.
    `<button type="button" class="dp-board__reveal-all" data-action="revealAll"` +
    `${rows.some((row) => row.hidden) ? "" : " disabled"}` +
    ` aria-label="${escapeAttr(t("DP.board.revealAllHint"))}"` +
    ` data-tooltip-text="${escapeAttr(t("DP.board.revealAllHint"))}">` +
    `${escapeHtml(t("DP.board.revealAll"))}</button>` +
    `</div>`;

  const menuRow = menu ? rows.find((row) => row.id === menu.id) : null;

  return [
    `<div class="dp-board">`,
    `<header class="dp-board__head">`,
    `<h2 class="dp-board__scene">${escapeHtml(sceneName)}</h2>`,
    `<input type="search" class="dp-board__search" data-action="search"`,
    ` value="${escapeAttr(query.search)}" placeholder="${escapeAttr(t("DP.board.search"))}"`,
    ` aria-label="${escapeAttr(t("DP.board.search"))}">`,
    `<button type="button" class="dp-board__keys" data-action="cheatSheet" aria-haspopup="dialog"`,
    ` aria-label="${escapeAttr(t("DP.cheat.open"))}" data-tooltip-text="${escapeAttr(t("DP.cheat.open"))}">`,
    `<i class="fa-solid fa-question" aria-hidden="true"></i></button>`,
    `</header>`,
    filterBarMarkup(rows, query),
    `<ul class="dp-board__list" role="grid" aria-multiselectable="true"`,
    ` aria-label="${escapeAttr(t("DP.board.list"))}">${list}</ul>`,
    bulk,
    `<footer class="dp-board__foot">`,
    `<button type="button" data-action="place">${escapeHtml(t("DP.board.place"))}</button>`,
    revealNextMarkup(rows, query),
    `<button type="button" data-action="hideAll">${escapeHtml(t("DP.board.hideAll"))}</button>`,
    // What the last Reveal next did, where the GM's eyes already are.
    `<span class="dp-board__status" role="status">${escapeHtml(status)}</span>`,
    `<span class="dp-board__totals" aria-live="polite">`,
    escapeHtml(t("DP.board.totals", { visible: counts.visible, total: counts.total })),
    counts.mismatched
      ? ` <span class="dp-board__warn" data-tooltip-text="${escapeAttr(t("DP.board.mismatchHint"))}">` +
        `<i class="fa-solid fa-key" aria-hidden="true"></i> ${counts.mismatched}` +
        `<span class="dp-visually-hidden"> ${escapeHtml(t("DP.board.mismatchHint"))}</span></span>`
      : "",
    `</span>`,
    `</footer>`,
    `<p class="dp-board__help">${escapeHtml(boardHelp())}</p>`,
    menuRow && menu ? menuMarkup(menuRow, menu) : "",
    `</div>`,
  ].join("");
}
