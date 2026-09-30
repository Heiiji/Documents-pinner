/**
 * The Pinboard — the surface that answers "the whole scene".
 *
 * IMPURE, and the list logic is NOT here: it lives in `pinboard-model.ts`, which is
 * pure and tested. This file resolves documents, builds markup and wires events.
 *
 * The whole thing is designed around one situation: a GM is running a session, four
 * people are looking at them, and they need to reveal the right clue without looking
 * away from the table. Everything follows from that.
 *
 * - **One-handed from the keyboard.** Arrow keys move, Space reveals, `/` searches.
 *   No pointer required for anything a GM does mid-scene.
 * - **No confirmation on a row's reveal or hide.** A dialog in the middle of a reveal
 *   is worse than the mistake it prevents. Two actions do ask: Delete, and "Reveal
 *   all" when it would show more than one pin. A reveal is not undone by hiding again —
 *   the table has already read it — and "Reveal all" is the one reveal whose mistake is
 *   a whole scene's worth of spoilers.
 * - **Bulk is first-class.** Shift-range-select then one action, because "as the
 *   ritual completes, all three glyphs light up" is one moment, not three.
 * - **Row order is reveal order**, hand-sortable and persisted, which turns the list
 *   into a scene script — and N plays it: Reveal next shows the first hidden row in
 *   the order, to the players it remembers, and moves the list on.
 */

import { MODULE_ID, PLACEHOLDER_TEXTURE } from "../const";
import { cv, g, internal, notify, ns, playerIds } from "../fvtt";
import { logger } from "../log";
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import * as store from "../data/PinStore";
import { anchorHidden, revealed, sameAudience, wouldReveal } from "../data/audience";
import type { DpAudience } from "../types/dp";
import { readPin } from "../data/PinData";
import { releaseAnchor, syncAnchor } from "../data/ownership-sync";
import { allPresets, findPreset } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { modifierGlyphs, platform } from "../ui/modifiers";
import { chipsMarkup } from "./chips";
import { chipUsersFor } from "./PinHUD";
import { focusSelectorIn } from "./focus-restore";
import {
  dropIndex,
  filterRows,
  focusIndex,
  levelsIn,
  nextToReveal,
  planReorder,
  rangeSelect,
  summarise,
  toggleSelection,
  type PinboardFilter,
  type PinboardQuery,
  type PinboardRow,
} from "./pinboard-model";

const log = logger("board");

let PinboardClass: any = null;
let instance: any = null;

/**
 * The anchor the open Pinboard has focused, or null.
 *
 * The keyboard bindings fall back to it when nothing on the canvas is selected: a GM
 * driving the board from the keyboard has a row under the cursor, and "select a pin
 * first" would be wrong advice to them.
 */
export function pinboardFocusedDoc(): any {
  if (!instance?.rendered || !instance.focusedId) return null;
  return instance.docFor(instance.focusedId) ?? null;
}

/**
 * Reveal next through the open Pinboard, if one is open: true when it took the press.
 *
 * The global binding asks it first, so a key pressed with the board open does what N on
 * the board does. The board's own view chooses the row — a GM who filtered it to one
 * level is running that level's script — its status line says what went out, and the
 * focus moves on to what is next.
 */
export function revealNextOnBoard(): boolean {
  if (!instance?.rendered) return false;
  instance.runRevealNext();
  return true;
}

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
    const source = api.resolveSourceSync(pin);
    // The library, not just the shipped ten, or a user preset shows as a raw id.
    const preset = findPreset(pin.effect.id);

    return {
      ...facts,
      effectId: pin.effect.id,
      effectLabel: preset ? t(preset.label) : pin.effect.id,
      sort: doc.sort ?? 0,
      locked: doc.locked === true,
      thumbnail: thumbnailFor(doc, pin, source),
      icon: iconFor(pin, source),
      users,
    };
  });
}

/**
 * A picture that tells this row from the next, or null.
 *
 * The tile's texture only when it is not the placeholder every document pin shares: the
 * thumbnail column used to show the same book on every journal row, which is a column
 * of pixels that says nothing. An image page shows its image.
 */
function thumbnailFor(doc: any, pin: any, source: any): string | null {
  const texture = doc.texture?.src ?? null;
  if (texture && texture !== PLACEHOLDER_TEXTURE) return texture;
  if (pin.source.kind === "image") return pin.source.src ?? null;
  if (source?.documentName === "JournalEntryPage" && source.type === "image" && source.src) {
    return source.src;
  }
  return null;
}

/** What kind of thing the row points at, as an icon, for rows with no picture. */
function iconFor(pin: any, source: any): string {
  if (pin.source.kind === "image") return "fa-image";
  if (!source) return "fa-circle-question";
  if (source.documentName !== "JournalEntryPage") return "fa-book";
  switch (source.type) {
    case "image":
      return "fa-image";
    case "pdf":
      return "fa-file-pdf";
    case "video":
      return "fa-film";
    default:
      return "fa-file-lines";
  }
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
        `${escapeHtml(t(preset.label))}</button>`
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
    item("show", "DP.board.menuShow") +
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
    // The scene's, not the selection's, so never disabled by an empty one. It sat in the
    // footer one button from "Hide all", which is the one pair on this board where a
    // slip cannot be taken back; here it is apart from both, and it asks first.
    `<button type="button" class="dp-board__reveal-all" data-action="revealAll"` +
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

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

export function definePinboard(): any {
  if (PinboardClass) return PinboardClass;

  const ApplicationV2 = ns("applications.api.ApplicationV2");
  if (!ApplicationV2) return null;

  PinboardClass = class Pinboard extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "dp-pinboard",
      classes: ["dp-scope", "dp-board-app"],
      tag: "section",
      window: {
        title: "DP.board.title",
        icon: "fa-solid fa-thumbtack",
        resizable: true,
        contentClasses: ["dp-board-content"],
      },
      position: { width: 720, height: 560 },
      actions: {
        setFilter: onSetFilter,
        locate: onLocate,
        effectMenu: onEffectMenu,
        rowMenu: onRowMenu,
        menuAct: onMenuAct,
        // ApplicationV2 invokes an action as `handler.call(app, event, target)`, so
        // `this` is the application and the first argument is the PointerEvent. These
        // four read the event as the application: two threw, and two — the global ones
        // — failed silently, because `store.all(event)` finds no `tiles` and returns [].
        bulkReveal(this: any) {
          return bulk(this, true);
        },
        bulkHide(this: any) {
          return bulk(this, false);
        },
        bulkDelete: onBulkDelete,
        place: onPlace,
        revealAll: onRevealAll,
        revealNext: onRevealNext,
        hideAll(this: any) {
          return allRows(this, false);
        },
      },
    };

    query: PinboardQuery = { filter: "all", search: "", level: null };
    selected: string[] = [];
    focusedId: string | null = null;
    /** Whether the list has ever held the DOM focus, so only the first render claims it. */
    hasFocusedList = false;
    /** The anchor of a shift-range, kept so a range can be extended repeatedly. */
    rangeAnchor: string | null = null;
    /** The open row menu, if any, and where it sits. */
    menu: MenuPlacement | null = null;
    /** The button that gets the focus back once its menu has closed. */
    menuReturnTo: { id: string; kind: MenuKind } | null = null;
    /** The scene the rows were last drawn from, so a scene change starts clean. */
    renderedSceneId: string | null = null;
    /** What the last Reveal next did, for the footer's status line. */
    status = "";

    get scene(): any {
      return cv()?.scene ?? g()?.scenes?.current ?? null;
    }

    get rows(): PinboardRow[] {
      return rowsFor(this.scene);
    }

    get visibleRows(): PinboardRow[] {
      return filterRows(this.rows, this.query);
    }

    docFor(id: string): any {
      return this.scene?.tiles?.get(id) ?? null;
    }

    async _renderHTML() {
      // A different scene: every id held here names a pin that is not on it. The board
      // used to keep the old scene's rows until something happened to re-render it, and
      // then keep the old selection — "3 selected", and bulk buttons that did nothing.
      const sceneId = this.scene?.id ?? null;
      if (sceneId !== this.renderedSceneId) {
        if (this.renderedSceneId !== null) {
          this.selected = [];
          this.focusedId = null;
          this.rangeAnchor = null;
          this.menu = null;
          this.menuReturnTo = null;
          this.query = { ...this.query, level: null };
          this.status = "";
        }
        this.renderedSceneId = sceneId;
      }

      // Without this no row is ever tabbable — `rowMarkup` emits `tabindex="0"` only for
      // `focusedId` — so `P` opened the board with nothing focused and every one of the
      // ten advertised shortcuts was unreachable.
      //
      // Re-seeded whenever the focused row is not among the VISIBLE ones, not merely when
      // it is null: a search that excludes it leaves no row tabbable at all, and then
      // ArrowDown out of the search box has nothing to land on — which is exactly the
      // case that branch exists for.
      const visible = this.visibleRows;
      if (!this.focusedId || !visible.some((row) => row.id === this.focusedId)) {
        this.focusedId = visible[0]?.id ?? null;
      }

      const wrapper = document.createElement("div");
      wrapper.innerHTML = boardMarkup(
        this.rows,
        this.query,
        this.selected,
        this.focusedId,
        this.scene?.name ?? "",
        this.menu,
        this.status
      );
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Preserve the caret: re-rendering on every keystroke would otherwise send the
      // cursor to the start of the search box and make typing a word impossible.
      const active = content.querySelector<HTMLInputElement>(".dp-board__search");
      const caret = active && active === document.activeElement ? active.selectionStart : null;
      // `#select` re-renders, and `replaceChildren` then destroyed the focus the click
      // had just established — so a GM could focus a row but never keep it.
      const focused = document.activeElement as HTMLElement | null;
      const hadRowFocus = !!focused?.classList?.contains("dp-row") && content.contains(focused);
      // A control — a chip, a filter, a bulk button — is found again by what it is, and
      // one inside a row by its row as well, or a chip click sent the focus to the first
      // row's copy of that player.
      const controlFocus =
        !hadRowFocus && content.contains(focused) ? focusSelectorIn(content) : null;
      const inRow = controlFocus ? focused?.closest?.<HTMLElement>(".dp-row")?.dataset.dpId : null;
      // A re-render replaces the scrolling list wholesale, which starts it at the top.
      const scrollTop = content.querySelector(".dp-board__list")?.scrollTop ?? 0;

      content.replaceChildren(result);
      const list = content.querySelector(".dp-board__list");
      if (list && scrollTop) list.scrollTop = scrollTop;
      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      this.#wire(result);

      if (caret !== null) {
        const search = content.querySelector<HTMLInputElement>(".dp-board__search");
        search?.focus();
        search?.setSelectionRange(caret, caret);
        return;
      }

      // The menu takes the focus while open — on the checked item when it has one, so
      // the effect menu opens on the current effect — and gives it back to its button.
      if (this.menu) {
        const menu = content.querySelector<HTMLElement>(".dp-menu");
        (
          menu?.querySelector<HTMLElement>('[aria-checked="true"]') ??
          menu?.querySelector<HTMLElement>("button")
        )?.focus({ preventScroll: true });
        return;
      }
      if (this.menuReturnTo) {
        const { id, kind } = this.menuReturnTo;
        this.menuReturnTo = null;
        const action = kind === "effect" ? "effectMenu" : "rowMenu";
        content
          .querySelector<HTMLElement>(
            `.dp-row[data-dp-id="${CSS.escape(id)}"] [data-action="${action}"]`
          )
          ?.focus({ preventScroll: true });
        return;
      }

      if (controlFocus) {
        const scope = inRow
          ? content.querySelector<HTMLElement>(`.dp-row[data-dp-id="${CSS.escape(inRow)}"]`)
          : content;
        const target = scope?.querySelector<HTMLElement>(controlFocus);
        if (target) {
          target.focus({ preventScroll: true });
          return;
        }
      }

      // On the first render there is nothing to preserve, so the board opens ready to
      // drive — which is the whole promise of "one-handed from the keyboard".
      if (hadRowFocus || !this.hasFocusedList) {
        this.hasFocusedList = true;
        this.focusRow(content, !hadRowFocus);
      }
    }

    /**
     * Put the DOM focus on whichever row the model says is focused.
     *
     * The first render needs a frame. ApplicationV2 builds the content and only THEN
     * attaches the window to the document, and `focus()` on a detached element is a
     * silent no-op — so the board opened with the row correctly marked `tabindex="0"`
     * and the focus still on `<body>`, which is precisely the state this was written to
     * prevent.
     */
    focusRow(root: ParentNode, deferred = false) {
      const focus = () =>
        root.querySelector<HTMLElement>('.dp-row[tabindex="0"]')?.focus({ preventScroll: true });
      if (deferred) requestAnimationFrame(focus);
      else focus();
    }

    #wire(root: HTMLElement) {
      root.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input?.dataset?.action === "search") {
          this.query = { ...this.query, search: input.value };
          this.render();
        }
      });

      root.addEventListener("change", (event) => {
        const select = event.target as HTMLSelectElement;
        if (select?.dataset?.action === "setLevel") {
          this.query = { ...this.query, level: select.value === "" ? null : Number(select.value) };
          this.render();
        }
      });

      root.addEventListener("click", (event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>(".dp-chip");
        if (chip) {
          const row = chip.closest<HTMLElement>(".dp-row");
          const doc = this.docFor(row?.dataset.dpId ?? "");
          const userId = chip.dataset.dpUser ?? "";
          event.preventDefault();
          const change = (event as MouseEvent).shiftKey
            ? api.soloUser(doc, userId)
            : api.setUserVisible(doc, userId, chip.getAttribute("aria-checked") !== "true");
          void change?.then(() => this.render());
          return;
        }

        const row = (event.target as HTMLElement).closest<HTMLElement>(".dp-row");
        if (row && !(event.target as HTMLElement).closest("button")) {
          this.#select(row.dataset.dpId ?? "", event as MouseEvent);
        }
      });

      root.addEventListener("keydown", (event) => this.#onKey(event));
      this.#wireDrag(root);
    }

    #select(id: string, event: MouseEvent) {
      if (event.shiftKey && this.rangeAnchor) {
        this.selected = rangeSelect(this.visibleRows, this.rangeAnchor, id);
      } else if (event.ctrlKey || event.metaKey) {
        this.selected = toggleSelection(this.selected, id);
        this.rangeAnchor = id;
      } else {
        this.selected = [id];
        this.rangeAnchor = id;
      }
      this.focusedId = id;
      this.render();
    }

    /**
     * The keyboard surface.
     *
     * Deliberately single letters with no modifier: a GM operating this while talking
     * cannot hold a chord. Nothing here is destructive, so a mistyped key costs one
     * keystroke to undo.
     */
    /** Close the row menu, remembering whose button gets the focus back. */
    closeMenu() {
      if (!this.menu) return;
      this.menuReturnTo = { id: this.menu.id, kind: this.menu.kind ?? "actions" };
      this.menu = null;
    }

    #onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;

      // While the row menu is open it owns Escape and the arrows.
      if (this.menu) {
        if (event.key === "Escape") {
          this.closeMenu();
          this.render();
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const items = [
            ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
              ".dp-menu button"
            ),
          ];
          const at = items.indexOf(document.activeElement as HTMLElement);
          const next = focusIndex(items.length, at, event.key === "ArrowDown" ? 1 : -1);
          items[next]?.focus();
          // The effect menu scrolls; the item the arrows reached must be in view.
          items[next]?.scrollIntoView?.({ block: "nearest" });
          event.preventDefault();
          return;
        }
      }
      // BUTTON and contenteditable are here because Space and the single letters are
      // real keystrokes for them: Space on a focused button activates it, and stealing
      // that would make the row controls unusable from the keyboard.
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "BUTTON" ||
        target?.isContentEditable === true;

      if (event.key === "Escape") {
        if (this.query.search) this.query = { ...this.query, search: "" };
        else this.selected = [];
        this.render();
        event.preventDefault();
        return;
      }
      if (event.key === "/" && !typing) {
        (event.currentTarget as HTMLElement)
          .querySelector<HTMLInputElement>(".dp-board__search")
          ?.focus();
        event.preventDefault();
        return;
      }
      // ArrowDown out of the search box is what makes "type four letters, then drive the
      // list" work — without it the search box is a one-way trip.
      if (typing && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const list = event.currentTarget as HTMLElement;
        const row = list.querySelector<HTMLElement>('.dp-row[tabindex="0"]');
        if (row) {
          row.focus({ preventScroll: true });
          event.preventDefault();
          return;
        }
      }
      if (typing) return;

      // Reveal next: the script's play button, with no row needed under the cursor. A
      // held key repeats, and a repeat is not a GM asking for the next clue — holding N
      // would reveal the scene. Stopped here as well as handled, so a global binding the
      // GM set to the same key cannot reveal a second pin from the same keystroke.
      if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) this.runRevealNext();
        return;
      }

      const visible = this.visibleRows;
      const current = visible.findIndex((r) => r.id === this.focusedId);

      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.altKey) {
        // Reorder from the keyboard: the reveal order is a script, and a script is
        // edited without reaching for the mouse.
        if (this.focusedId) void this.#move(this.focusedId, event.key === "ArrowDown" ? 1 : -1);
        event.preventDefault();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const next = focusIndex(visible.length, current, event.key === "ArrowDown" ? 1 : -1);
        if (next >= 0) {
          this.focusedId = visible[next].id;
          if (event.shiftKey && this.rangeAnchor) {
            this.selected = rangeSelect(visible, this.rangeAnchor, this.focusedId);
          } else {
            this.rangeAnchor = this.focusedId;
          }
          // The re-render rebuilds the list; `_replaceHTML` sees that the focus was on a
          // row and puts it back on whichever row is now the focused one.
          this.render();
        }
        event.preventDefault();
        return;
      }

      const doc = this.focusedId ? this.docFor(this.focusedId) : null;
      if (!doc) return;

      // Open the document on every screen in this pin's audience, right now. Not the same
      // as revealing: it pushes the sheet up rather than making the pin visible. The one
      // verb here that reaches the players' screens and cannot be taken back, so it is
      // the one that needs Shift: a bare letter in a list is what a GM types expecting to
      // jump to a row, and "s" for "Seal" used to put a document in front of the table.
      if (event.key.toLowerCase() === "s") {
        if (event.shiftKey) {
          void api.showToAudience(doc);
          event.preventDefault();
        }
        return;
      }

      // Reveal & spotlight. Checked before Space itself, which took Shift+Space as the eye
      // and hid a revealed pin. The Shift is still down while it pings — which is why the
      // verb states `pull` rather than letting core read it off the keyboard.
      if (event.key === " " && event.shiftKey) {
        event.preventDefault();
        void api
          .spotlight(doc)
          .then(() => this.render())
          .catch((error) => {
            log.warn("spotlight failed", error);
            notify({ key: "DP.notice.spotlightFailed" }, "error");
          });
        return;
      }

      const actions: Record<string, () => void> = {
        " ": () => void api.toggleVisibility(doc)?.then(() => this.render()),
        Enter: () => Hooks.call(`${MODULE_ID}.openStudio`, doc),
        l: () => void api.locate(doc),
        o: () => void api.openLocally(doc),
        f: () => api.flash(doc),
        m: () => void api.toggleMode(doc)?.then(() => this.render()),
      };
      const action = actions[event.key] ?? actions[event.key.toLowerCase()];
      if (action) {
        action();
        event.preventDefault();
      }
    }

    /**
     * Reveal next, from N or the footer, then move the list on to what follows it.
     *
     * The focus goes to the row that is now next, so the GM's next N and the row under
     * their eyes are the same one; with nothing left it stays where it was.
     */
    async revealNext() {
      const { doc, left } = await api.revealNext(this.scene, this.query);
      if (!doc) return;
      const pin = readPin(doc);
      this.status = t("DP.board.statusRevealed", {
        name: pin ? api.labelFor(pin) : "",
        count: left,
      });
      this.focusedId = nextToReveal(this.rows, this.query).next?.id ?? this.focusedId;
      this.render();
    }

    /** The fire-and-forget form every surface of the board calls. */
    runRevealNext() {
      void this.revealNext().catch((error: unknown) => {
        log.warn("reveal next failed", error);
        notify({ key: "DP.notice.revealNextFailed" }, "error");
      });
    }

    /** Persist a new position for one row, in one scene write. */
    async #reorder(updates: { id: string; sort: number }[]) {
      if (!updates.length) return;
      await this.scene?.updateEmbeddedDocuments(
        "Tile",
        updates.map((u) => ({ _id: u.id, sort: u.sort })),
        internal()
      );
      this.render();
    }

    /** Move a row one step in the full list. */
    #move(id: string, delta: number) {
      const rows = this.rows;
      const from = rows.findIndex((r) => r.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= rows.length) return Promise.resolve();
      return this.#reorder(planReorder(rows, id, to));
    }

    /**
     * Dragging a grip reorders the reveal order and persists it to `sort`.
     *
     * The row under the pointer shows a line above or below itself, decided by which
     * half the pointer is in — instant, because a drop target that lags the pointer is
     * worse than none — and the drop lands exactly where the line was.
     */
    #wireDrag(root: HTMLElement) {
      let dragging: string | null = null;

      const clearMarks = () => {
        for (const row of root.querySelectorAll<HTMLElement>(".dp-row[data-dp-drop]")) {
          delete row.dataset.dpDrop;
        }
      };

      root.addEventListener("dragstart", (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(".dp-row");
        dragging = row?.dataset.dpId ?? null;
        row?.classList.add("dp-row--dragging");
        event.dataTransfer?.setData("text/plain", dragging ?? "");
      });

      root.addEventListener("dragover", (event) => {
        if (!dragging) return;
        event.preventDefault();
        const row = (event.target as HTMLElement).closest<HTMLElement>(".dp-row");
        if (!row || row.dataset.dpId === dragging) {
          clearMarks();
          return;
        }
        // A read in an event handler, not a frame: one rect per pointer move.
        const rect = row.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        const mark = after ? "after" : "before";
        if (row.dataset.dpDrop === mark) return;
        clearMarks();
        row.dataset.dpDrop = mark;
      });

      root.addEventListener("dragleave", (event) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
          clearMarks();
        }
      });

      root.addEventListener("dragend", () => {
        clearMarks();
        root.querySelector(".dp-row--dragging")?.classList.remove("dp-row--dragging");
        dragging = null;
      });

      root.addEventListener("drop", (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(".dp-row");
        if (!dragging || !row) return;
        event.preventDefault();

        const after = row.dataset.dpDrop === "after";
        clearMarks();
        const rows = this.rows;
        const updates = planReorder(
          rows,
          dragging,
          dropIndex(rows, dragging, row.dataset.dpId ?? "", after)
        );
        dragging = null;
        void this.#reorder(updates);
      });
    }
  };

  return PinboardClass;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function onSetFilter(this: any, _event: Event, target: HTMLElement) {
  this.query = { ...this.query, filter: (target.dataset.dpFilter ?? "all") as PinboardFilter };
  this.render();
}

function onLocate(this: any, _event: Event, target: HTMLElement) {
  void api.locate(this.docFor(rowIdOf(target)));
}

/**
 * Open one of a row's menus beside its button, or close it if it is the one open.
 *
 * The effect used to be a button that stepped to the next preset on every click. Each
 * step was a save, and on a revealed prop the table watched the paper change nine times
 * on the way to the tenth preset. A menu costs one open and one write.
 */
function toggleMenu(app: any, target: HTMLElement, kind: MenuKind) {
  const id = rowIdOf(target);
  if (app.menu?.id === id && (app.menu.kind ?? "actions") === kind) {
    app.closeMenu();
    app.render();
    return;
  }
  const board = target.closest<HTMLElement>(".dp-board");
  const at = board?.getBoundingClientRect();
  const button = target.getBoundingClientRect();
  app.menu = at ? placeMenu(id, kind, at, button) : { id, kind, top: 0, right: 0 };
  app.render();
}

function onRowMenu(this: any, _event: Event, target: HTMLElement) {
  toggleMenu(this, target, "actions");
}

function onEffectMenu(this: any, _event: Event, target: HTMLElement) {
  toggleMenu(this, target, "effect");
}

/** One verb from the row menu, then the menu closes. */
async function onMenuAct(this: any, _event: Event, target: HTMLElement) {
  const act = target.dataset.dpAct;
  const doc = this.menu ? this.docFor(this.menu.id) : null;
  this.closeMenu();
  if (!doc || !act) {
    this.render();
    return;
  }

  switch (act) {
    case "effect":
      if (target.dataset.dpPreset) await api.setEffect(doc, target.dataset.dpPreset);
      break;
    case "visibility":
      await api.toggleVisibility(doc);
      break;
    case "spotlight":
      // A reveal the GM asked for and did not get is said, not left to the console.
      await api.spotlight(doc).catch((error) => {
        log.warn("spotlight failed", error);
        notify({ key: "DP.notice.spotlightFailed" }, "error");
      });
      break;
    case "show":
      await api.showToAudience(doc);
      break;
    case "shape":
      await api.toggleMode(doc);
      break;
    case "fit":
      await api.fitToContent(doc);
      break;
    case "locate":
      await api.locate(doc);
      break;
    case "studio":
      Hooks.call(`${MODULE_ID}.openStudio`, doc);
      break;
    case "delete":
      await deleteRows(this, [doc]);
      return;
  }
  this.render();
}

function rowIdOf(target: HTMLElement): string {
  return target.closest<HTMLElement>(".dp-row")?.dataset.dpId ?? "";
}

/** Bulk reveal and hide, in ONE scene write, so every client sees one change. */
async function bulk(app: any, reveal: boolean) {
  const docs = app.selected.map((id: string) => app.docFor(id)).filter(Boolean);
  await applyVisibility(app, docs, reveal);
}

async function allRows(app: any, reveal: boolean) {
  await applyVisibility(app, store.all(app.scene), reveal);
}

/**
 * "Reveal all", which asks first when it would show more than one pin.
 *
 * Counted when the button is pressed, not on every render, and counted as what the
 * reveal would actually do: a pin already showing is not news, and one whose remembered
 * audience names only players who have left reaches nobody. One pin is what a row's
 * Space does without asking, so one pin does not ask here either.
 *
 * `=== true`, because a dialog closed with its ✕ resolves `null`, and a build with no
 * dialog to ask with refuses rather than acting unasked.
 */
async function onRevealAll(this: any) {
  const docs = store.all(this.scene);
  const players = playerIds();
  const count = docs.filter((doc: any) => {
    const pin = readPin(doc);
    return !!pin && wouldReveal(pin.audience, doc.hidden === true, players);
  }).length;

  if (count > 1) {
    const DialogV2 = ns("applications.api.DialogV2");
    const confirmed = DialogV2?.confirm
      ? await DialogV2.confirm({
          window: { title: t("DP.board.revealAllTitle") },
          content: `<p>${escapeHtml(t("DP.board.revealAllBody", { count }))}</p>`,
        }).catch(() => false)
      : false;
    if (confirmed !== true) return;
  }
  await applyVisibility(this, docs, true);
}

async function applyVisibility(app: any, docs: any[], reveal: boolean) {
  // Only the pins the gesture changes. "Reveal all" over a scene where most pins already
  // show wrote every one of them anyway, and re-synced every one's ownership after.
  const changes = docs.flatMap((doc) => {
    const pin = readPin(doc);
    if (!pin) return [];
    const next = audienceFor(pin.audience, reveal);
    const same = sameAudience(next, pin.audience) && (doc.hidden === true) === anchorHidden(next);
    return same ? [] : [{ doc, patch: { audience: next } }];
  });
  if (!changes.length) return;

  await store.batchUpdate(app.scene, changes);
  // Ownership follows the payload, one source at a time; the queue in ownership-sync
  // keeps two pins of the same journal from racing.
  for (const { doc } of changes) await syncAnchor(doc);
  app.render();
}

/**
 * The audience a bulk reveal or hide should write.
 *
 * A reveal is the eye's own rule, `revealed`: each pin goes back to the audience it
 * remembers. This wrote `everyone` for every pin, so a note narrowed to one player and
 * hidden for a beat was shown to the whole table by the bulk bar or "Reveal all".
 *
 * Hiding an ALREADY-hidden pin must leave `restore` alone. Writing it unconditionally
 * stored `{ kind: "hidden" }`, which `normaliseAudience` rewrites to "everyone" — so a
 * pin narrowed to one player, hidden by hand and then caught by "Hide all", later
 * revealed itself to the whole table. That is the exact failure the remembered audience
 * exists to prevent.
 */
function audienceFor(current: DpAudience, reveal: boolean): DpAudience {
  if (reveal) return revealed(current);
  if (current.kind === "hidden") return { ...current };
  return { ...current, kind: "hidden", restore: { kind: current.kind, users: [...current.users] } };
}

/**
 * Delete is the one action here that asks first.
 *
 * Not because it is dangerous to the scene — an anchor is cheap to place again — but
 * because it is the only one a GM cannot take back with the key they just pressed.
 */
async function onBulkDelete(this: any) {
  const docs = this.selected.map((id: string) => this.docFor(id)).filter(Boolean);
  await deleteRows(this, docs);
}

async function deleteRows(app: any, docs: any[]) {
  if (!docs.length) return;

  const DialogV2 = ns("applications.api.DialogV2");
  const confirmed = DialogV2?.confirm
    ? await DialogV2.confirm({
        window: { title: t("DP.board.deleteTitle") },
        content: `<p>${escapeHtml(t("DP.board.deleteBody", { count: docs.length }))}</p>`,
      }).catch(() => false)
    : false;
  if (!confirmed) return;

  // Release every grant first, then delete in ONE scene write. `api.deletePin` per row is
  // N round trips, which for a dozen selected pins is a visible stagger on every client
  // and N separate undo entries.
  for (const doc of docs) await releaseAnchor(doc);
  await app.scene?.deleteEmbeddedDocuments(
    "Tile",
    docs.map((doc: any) => doc.id),
    internal()
  );

  app.selected = app.selected.filter((id: string) => !docs.some((doc) => doc.id === id));
  app.render();
}

function onRevealNext(this: any) {
  this.runRevealNext();
}

function onPlace(this: any) {
  Hooks.call(`${MODULE_ID}.openPicker`);
}

/** Open the Pinboard, reusing the existing window rather than stacking copies. */
export function openPinboard(): any {
  const Board = definePinboard();
  if (!Board) return null;
  instance ??= new Board();
  instance.render(true);
  return instance;
}

/** Re-render the open Pinboard, if any. Wired to the document hooks in `main.ts`. */
export function refreshPinboard(): void {
  if (instance?.rendered) instance.render();
}

declare const Hooks: any;
