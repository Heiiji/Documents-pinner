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
 * - **No confirmation on reveal or hide.** Both are one keystroke to undo, and a
 *   dialog in the middle of a reveal is worse than the mistake it prevents. Delete —
 *   the only irreversible action — does confirm.
 * - **Bulk is first-class.** Shift-range-select then one action, because "as the
 *   ritual completes, all three glyphs light up" is one moment, not three.
 * - **Row order is reveal order**, hand-sortable and persisted, which quietly turns
 *   the list into a scene script.
 */

import { MODULE_ID } from "../const";
import { cv, g, internal, ns } from "../fvtt";
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import * as store from "../data/PinStore";
import { readPin } from "../data/PinData";
import { releaseAnchor, syncAnchor } from "../data/ownership-sync";
import { allPresets, findPreset } from "../effects/preset-library";
import { chipsMarkup } from "./chips";
import { chipUsersFor } from "./PinHUD";
import {
  dropIndex,
  filterRows,
  focusIndex,
  levelsIn,
  planReorder,
  rangeSelect,
  summarise,
  toggleSelection,
  type PinboardFilter,
  type PinboardQuery,
  type PinboardRow,
} from "./pinboard-model";

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

const FILTERS: { id: PinboardFilter; key: string }[] = [
  { id: "all", key: "DP.board.filterAll" },
  { id: "visible", key: "DP.board.filterVisible" },
  { id: "hidden", key: "DP.board.filterHidden" },
  { id: "props", key: "DP.board.filterProps" },
  { id: "pins", key: "DP.board.filterPins" },
  { id: "mismatch", key: "DP.board.filterMismatch" },
];

/** Build the row model for a scene. The only place documents become plain data. */
export function rowsFor(scene: any): PinboardRow[] {
  return store.all(scene).map((doc: any) => {
    const pin = readPin(doc)!;
    const source = api.resolveSourceSync(pin);
    // The library, not just the shipped ten, or a user preset shows as a raw id.
    const preset = findPreset(pin.effect.id);
    const users = chipUsersFor(doc);

    return {
      id: doc.id,
      name: api.labelFor(pin),
      breadcrumb: breadcrumbFor(source),
      mode: pin.mode,
      visible: pin.audience.kind !== "hidden" && !doc.hidden,
      effectId: pin.effect.id,
      effectLabel: preset ? t(preset.label) : pin.effect.id,
      sort: doc.sort ?? 0,
      elevation: doc.elevation ?? 0,
      locked: doc.locked === true,
      thumbnail: doc.texture?.src ?? null,
      users,
    };
  });
}

function breadcrumbFor(source: any): string {
  if (!source) return "";
  if (source.documentName === "JournalEntryPage" && source.parent?.name) {
    return `${source.parent.name} › ${source.name}`;
  }
  return source.name ?? "";
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function rowMarkup(row: PinboardRow, selected: boolean, focused: boolean): string {
  const thumb = row.thumbnail
    ? `<img class="dp-row__thumb" src="${escapeAttr(row.thumbnail)}" alt="" loading="lazy">`
    : `<span class="dp-row__thumb dp-row__thumb--missing" aria-hidden="true">?</span>`;

  return [
    `<li class="dp-row" role="option" data-dp-id="${escapeAttr(row.id)}"`,
    ` aria-selected="${selected}" tabindex="${focused ? 0 : -1}"`,
    ` data-dp-visible="${row.visible}" data-dp-mode="${row.mode}">`,
    `<span class="dp-row__grip" data-dp-grip draggable="true" aria-hidden="true">⋮⋮</span>`,
    thumb,
    `<span class="dp-row__name" title="${escapeAttr(row.breadcrumb || row.name)}">`,
    escapeHtml(row.name),
    `</span>`,
    `<span class="dp-row__mode">${escapeHtml(t(`DP.board.mode.${row.mode}`))}</span>`,
    chipsMarkup(row.users, { t: tn, size: "sm" }),
    `<button type="button" class="dp-row__fx" data-action="cycleEffect"`,
    ` title="${escapeAttr(t("DP.board.effect"))}">${escapeHtml(row.effectLabel)}</button>`,
    `<button type="button" class="dp-row__icon" data-action="locate"`,
    ` title="${escapeAttr(t("DP.board.locate"))}" aria-label="${escapeAttr(t("DP.board.locate"))}">`,
    `<i class="fa-solid fa-crosshairs" aria-hidden="true"></i></button>`,
    `<button type="button" class="dp-row__icon" data-action="rowMenu"`,
    ` title="${escapeAttr(t("DP.board.more"))}" aria-label="${escapeAttr(t("DP.board.more"))}">`,
    `<i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>`,
    `</li>`,
  ].join("");
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

/** Where the row menu sits, relative to the board, so the list's clipping cannot cut it. */
export interface MenuPlacement {
  id: string;
  top: number;
  right: number;
}

/**
 * The row menu: every verb the row has, in one place, because the "…" button used to
 * open the Studio, which is what Enter already did — a control that lied about what it
 * was. Anchored to the board rather than inside the row, whose paint containment would
 * clip it.
 */
function menuMarkup(row: PinboardRow, at: MenuPlacement): string {
  const item = (act: string, key: string, danger = false) =>
    `<button type="button" role="menuitem" data-action="menuAct" data-dp-act="${act}"` +
    `${danger ? ' class="dp-danger"' : ""}>${escapeHtml(t(key))}</button>`;
  return (
    `<div class="dp-menu" role="menu" data-dp-id="${escapeAttr(row.id)}"` +
    ` style="top:${Math.round(at.top)}px;right:${Math.round(at.right)}px">` +
    item("visibility", row.visible ? "DP.hud.hide" : "DP.hud.reveal") +
    item("show", "DP.board.menuShow") +
    item("shape", "DP.board.menuShape") +
    (row.mode === "prop" ? item("fit", "DP.board.menuFit") : "") +
    item("locate", "DP.board.locate") +
    item("studio", "DP.board.menuStudio") +
    item("delete", "DP.board.deleteSelected", true) +
    `</div>`
  );
}

export function boardMarkup(
  rows: PinboardRow[],
  query: PinboardQuery,
  selected: readonly string[],
  focusedId: string | null,
  sceneName: string,
  menu: MenuPlacement | null = null
): string {
  const visible = filterRows(rows, query);
  const counts = summarise(rows);

  // An empty scene says what to do, not just that there is nothing: the gesture that
  // places a pin is Alt-drag from the sidebar, which nothing on screen suggests.
  const empty = rows.length
    ? `<li class="dp-board__empty">${escapeHtml(t("DP.board.noMatches"))}</li>`
    : `<li class="dp-board__empty">` +
      `<p>${escapeHtml(t("DP.board.noPins"))}</p>` +
      `<p class="dp-board__empty-hint">${escapeHtml(t("DP.board.emptyHint"))}</p>` +
      `<button type="button" data-action="place">${escapeHtml(t("DP.board.place"))}</button>` +
      `</li>`;
  const list = visible.length
    ? visible.map((row) => rowMarkup(row, selected.includes(row.id), row.id === focusedId)).join("")
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
    `<ul class="dp-board__list" role="listbox" aria-multiselectable="true"`,
    ` aria-label="${escapeAttr(t("DP.board.list"))}">${list}</ul>`,
    bulk,
    `<footer class="dp-board__foot">`,
    `<button type="button" data-action="place">${escapeHtml(t("DP.board.place"))}</button>`,
    `<button type="button" data-action="revealAll">${escapeHtml(t("DP.board.revealAll"))}</button>`,
    `<button type="button" data-action="hideAll">${escapeHtml(t("DP.board.hideAll"))}</button>`,
    `<span class="dp-board__totals" aria-live="polite">`,
    escapeHtml(t("DP.board.totals", { visible: counts.visible, total: counts.total })),
    counts.mismatched
      ? ` <span class="dp-board__warn" title="${escapeAttr(t("DP.board.mismatchHint"))}">⚿ ${counts.mismatched}</span>`
      : "",
    `</span>`,
    `</footer>`,
    `<p class="dp-board__help">${escapeHtml(t("DP.board.help"))}</p>`,
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
        cycleEffect: onCycleEffect,
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
        revealAll(this: any) {
          return allRows(this, true);
        },
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
    /** The row whose "…" button should get the focus back once its menu has closed. */
    menuReturnTo: string | null = null;

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
        this.menu
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
      const hadRowFocus = !!(document.activeElement as HTMLElement)?.closest?.(".dp-row");
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

      // The menu takes the focus while open and gives it back to its button after.
      if (this.menu) {
        content.querySelector<HTMLElement>(".dp-menu button")?.focus({ preventScroll: true });
        return;
      }
      if (this.menuReturnTo) {
        const id = this.menuReturnTo;
        this.menuReturnTo = null;
        content
          .querySelector<HTMLElement>(`.dp-row[data-dp-id="${CSS.escape(id)}"] [data-action="rowMenu"]`)
          ?.focus({ preventScroll: true });
        return;
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
      this.menuReturnTo = this.menu.id;
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
            ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".dp-menu button"),
          ];
          const at = items.indexOf(document.activeElement as HTMLElement);
          const next = focusIndex(items.length, at, event.key === "ArrowDown" ? 1 : -1);
          items[next]?.focus();
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

      const actions: Record<string, () => void> = {
        " ": () => void api.toggleVisibility(doc)?.then(() => this.render()),
        Enter: () => Hooks.call(`${MODULE_ID}.openStudio`, doc),
        l: () => void api.locate(doc),
        o: () => void api.openLocally(doc),
        f: () => api.flash(doc),
        m: () => void api.toggleMode(doc)?.then(() => this.render()),
        // Open the document on every screen in this pin's audience, right now. Not the
        // same as revealing: it pushes the sheet up rather than making the pin visible.
        s: () => void api.showToAudience(doc),
      };
      const action = actions[event.key] ?? actions[event.key.toLowerCase()];
      if (action) {
        action();
        event.preventDefault();
      }
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
 * Step to the next preset in the library.
 *
 * A cycle rather than a menu: the row already shows which effect is on, and a GM
 * comparing two of them against the same map wants one click per comparison, not a
 * dropdown opened and dismissed each time. Shift steps backwards, so overshooting by
 * one costs one keystroke rather than a full lap.
 */
function onCycleEffect(this: any, event: Event, target: HTMLElement) {
  const doc = this.docFor(rowIdOf(target));
  const pin = readPin(doc);
  if (!pin) return;

  const presets = allPresets();
  const step = (event as MouseEvent).shiftKey ? -1 : 1;
  const current = presets.findIndex((preset) => preset.id === pin.effect.id);
  const next = presets[(current + step + presets.length) % presets.length];

  void api.patch(doc, { effect: { id: next.id } })?.then(() => this.render());
}

/** Open the row's menu beside its button, or close it if it is already open. */
function onRowMenu(this: any, _event: Event, target: HTMLElement) {
  const id = rowIdOf(target);
  if (this.menu?.id === id) {
    this.closeMenu();
    this.render();
    return;
  }
  const board = target.closest<HTMLElement>(".dp-board");
  const at = board?.getBoundingClientRect();
  const button = target.getBoundingClientRect();
  this.menu = {
    id,
    top: at ? button.bottom - at.top : 0,
    right: at ? at.right - button.right : 0,
  };
  this.render();
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
    case "visibility":
      await api.toggleVisibility(doc);
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

async function applyVisibility(app: any, docs: any[], reveal: boolean) {
  if (!docs.length) return;
  await store.batchUpdate(
    app.scene,
    docs.map((doc) => {
      const pin = readPin(doc)!;
      return { doc, patch: { audience: audienceFor(pin.audience, reveal) } };
    })
  );
  // Ownership follows the payload, one source at a time; the queue in ownership-sync
  // keeps two pins of the same journal from racing.
  for (const doc of docs) await syncAnchor(doc);
  app.render();
}

/**
 * The audience a bulk reveal or hide should write.
 *
 * Hiding an ALREADY-hidden pin must leave `restore` alone. Writing it unconditionally
 * stored `{ kind: "hidden" }`, which `normaliseAudience` rewrites to "everyone" — so a
 * pin narrowed to one player, hidden by hand and then caught by "Hide all", later
 * revealed itself to the whole table. That is the exact failure the remembered audience
 * exists to prevent.
 */
function audienceFor(current: any, reveal: boolean) {
  if (reveal) return { ...current, kind: "everyone", users: [], restore: null };
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
