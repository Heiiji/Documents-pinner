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
 * - **Detachable**, so it can live on a second monitor for the whole session.
 */

import { cv, g, internal, ns } from "../fvtt";
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import * as store from "../data/PinStore";
import { readPin } from "../data/PinData";
import { syncAnchor } from "../data/ownership-sync";
import { getCorePreset } from "../effects/presets/core-presets";
import { chipsMarkup } from "./chips";
import { chipUsersFor } from "./PinHUD";
import {
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

const FILTERS: { id: PinboardFilter; key: string }[] = [
  { id: "all", key: "DP.board.filterAll" },
  { id: "visible", key: "DP.board.filterVisible" },
  { id: "hidden", key: "DP.board.filterHidden" },
  { id: "props", key: "DP.board.filterProps" },
  { id: "pins", key: "DP.board.filterPins" },
];

/** Build the row model for a scene. The only place documents become plain data. */
export function rowsFor(scene: any): PinboardRow[] {
  return store.all(scene).map((doc: any) => {
    const pin = readPin(doc)!;
    const source = api.resolveSourceSync(pin);
    const preset = getCorePreset(pin.effect.id);
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
            : counts.pins;

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

export function boardMarkup(
  rows: PinboardRow[],
  query: PinboardQuery,
  selected: readonly string[],
  focusedId: string | null,
  sceneName: string
): string {
  const visible = filterRows(rows, query);
  const counts = summarise(rows);

  const list = visible.length
    ? visible.map((row) => rowMarkup(row, selected.includes(row.id), row.id === focusedId)).join("")
    : `<li class="dp-board__empty">${escapeHtml(t(rows.length ? "DP.board.noMatches" : "DP.board.noPins"))}</li>`;

  const bulk = selected.length
    ? `<div class="dp-board__bulk" role="group" aria-label="${escapeAttr(t("DP.board.bulk"))}">` +
      `<span class="dp-board__selected">${escapeHtml(t("DP.board.selectedN", { count: selected.length }))}</span>` +
      `<button type="button" data-action="bulkReveal">${escapeHtml(t("DP.board.revealSelected"))}</button>` +
      `<button type="button" data-action="bulkHide">${escapeHtml(t("DP.board.hideSelected"))}</button>` +
      `<button type="button" class="dp-danger" data-action="bulkDelete">${escapeHtml(t("DP.board.deleteSelected"))}</button>` +
      `</div>`
    : "";

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
        bulkReveal: (app: any) => bulk(app, true),
        bulkHide: (app: any) => bulk(app, false),
        bulkDelete: onBulkDelete,
        place: onPlace,
        revealAll: (app: any) => allRows(app, true),
        hideAll: (app: any) => allRows(app, false),
      },
    };

    query: PinboardQuery = { filter: "all", search: "", level: null };
    selected: string[] = [];
    focusedId: string | null = null;
    /** The anchor of a shift-range, kept so a range can be extended repeatedly. */
    rangeAnchor: string | null = null;

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
      const wrapper = document.createElement("div");
      wrapper.innerHTML = boardMarkup(
        this.rows,
        this.query,
        this.selected,
        this.focusedId,
        this.scene?.name ?? ""
      );
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Preserve the caret: re-rendering on every keystroke would otherwise send the
      // cursor to the start of the search box and make typing a word impossible.
      const active = content.querySelector<HTMLInputElement>(".dp-board__search");
      const caret = active === document.activeElement ? active.selectionStart : null;

      content.replaceChildren(result);
      this.#wire(content);

      if (caret !== null) {
        const search = content.querySelector<HTMLInputElement>(".dp-board__search");
        search?.focus();
        search?.setSelectionRange(caret, caret);
      }
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
    #onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const typing = target?.tagName === "INPUT" || target?.tagName === "SELECT";

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
      if (typing) return;

      const visible = this.visibleRows;
      const current = visible.findIndex((r) => r.id === this.focusedId);

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const next = focusIndex(visible.length, current, event.key === "ArrowDown" ? 1 : -1);
        if (next >= 0) {
          this.focusedId = visible[next].id;
          if (event.shiftKey && this.rangeAnchor) {
            this.selected = rangeSelect(visible, this.rangeAnchor, this.focusedId);
          } else {
            this.rangeAnchor = this.focusedId;
          }
          this.render();
        }
        event.preventDefault();
        return;
      }

      const doc = this.focusedId ? this.docFor(this.focusedId) : null;
      if (!doc) return;

      const actions: Record<string, () => void> = {
        " ": () => void api.toggleVisibility(doc)?.then(() => this.render()),
        Enter: () => Hooks.call("documents-pinner.openStudio", doc),
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

    /** Dragging a grip reorders the reveal order and persists it to `sort`. */
    #wireDrag(root: HTMLElement) {
      let dragging: string | null = null;

      root.addEventListener("dragstart", (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(".dp-row");
        dragging = row?.dataset.dpId ?? null;
        event.dataTransfer?.setData("text/plain", dragging ?? "");
      });

      root.addEventListener("dragover", (event) => {
        if (dragging) event.preventDefault();
      });

      root.addEventListener("drop", (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(".dp-row");
        if (!dragging || !row) return;
        event.preventDefault();

        const rows = this.rows;
        const targetIndex = rows.findIndex((r) => r.id === row.dataset.dpId);
        const updates = planReorder(rows, dragging, targetIndex);
        dragging = null;
        if (!updates.length) return;

        void this.scene
          ?.updateEmbeddedDocuments(
            "Tile",
            updates.map((u) => ({ _id: u.id, sort: u.sort })),
            internal()
          )
          .then(() => this.render());
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

function onCycleEffect(this: any, _event: Event, target: HTMLElement) {
  Hooks.call("documents-pinner.openStudio", this.docFor(rowIdOf(target)), "appearance");
}

function onRowMenu(this: any, _event: Event, target: HTMLElement) {
  Hooks.call("documents-pinner.openStudio", this.docFor(rowIdOf(target)));
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

function audienceFor(current: any, reveal: boolean) {
  if (reveal) return { ...current, kind: "everyone", users: [], restore: null };
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
  if (!docs.length) return;

  const DialogV2 = ns("applications.api.DialogV2");
  const confirmed = DialogV2?.confirm
    ? await DialogV2.confirm({
        window: { title: t("DP.board.deleteTitle") },
        content: `<p>${escapeHtml(t("DP.board.deleteBody", { count: docs.length }))}</p>`,
      }).catch(() => false)
    : false;
  if (!confirmed) return;

  for (const doc of docs) await api.deletePin(doc);
  this.selected = [];
  this.render();
}

function onPlace(this: any) {
  Hooks.call("documents-pinner.openPicker");
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
