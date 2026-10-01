/**
 * The Pinboard — the surface that answers "the whole scene".
 *
 * IMPURE, and the list logic is NOT here: it lives in `pinboard-model.ts`, which is
 * pure and tested. The rows and the markup are `pinboard-markup.ts`; this file holds the
 * application, its state and its events.
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

import { MODULE_ID } from "../const";
import { confirmDialog, cv, g, notify, ns, playerIds } from "../fvtt";
import { logger } from "../log";
import { t } from "../i18n";
import * as api from "../api";
import * as store from "../data/PinStore";
import { wouldReveal } from "../data/audience";
import { readPin } from "../data/PinData";
import { isTextEntry } from "../ui/cheatsheet";
import { closeCheatSheet, toggleCheatSheet } from "./CheatSheet";
import { docOf, focusSelectorIn } from "./focus-restore";
import { consume, guardActivationKeys } from "./keys";
import {
  dropIndex,
  filterRows,
  focusIndex,
  nextToReveal,
  planReorder,
  rangeSelect,
  toggleSelection,
  type PinboardFilter,
  type PinboardQuery,
  type PinboardRow,
} from "./pinboard-model";
import {
  boardMarkup,
  placeMenu,
  rowsFor,
  type MenuKind,
  type MenuPlacement,
} from "./pinboard-markup";

// The rows and the markup live in `pinboard-markup.ts`; the tests read them here.
export {
  boardHelp,
  boardMarkup,
  placeMenu,
  rowsFor,
  type MenuKind,
  type MenuPlacement,
} from "./pinboard-markup";

const log = logger("board");

/**
 * How long a requested render waits for its window's frame before it runs anyway — the
 * overlay's floor (`OverlayRoot.write`), for the same reason: a window that is not
 * painting fires no frame at all.
 */
export const RENDER_FLOOR_MS = 250;

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
        // The target names the window the sheet goes up in: a detached board's own.
        cheatSheet(_event: Event, target: HTMLElement) {
          toggleCheatSheet("board", target);
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
    /** The button that gets the focus back once its menu has closed. */
    menuReturnTo: { id: string; kind: MenuKind } | null = null;
    /** The scene the rows were last drawn from, so a scene change starts clean. */
    renderedSceneId: string | null = null;
    /** What the last Reveal next did, for the footer's status line. */
    status = "";
    /** The rows the last render drew, or null until a render reads them (`rows`). */
    #rows: PinboardRow[] | null = null;
    /** A render asked for and not yet run, shared by everything that asks before its frame. */
    #pending: Promise<void> | null = null;
    /** Whether that render still has work to do: a render that began since did it. */
    #wanted = false;
    /** Ends the render asked for without running it, for a board that is closing. */
    #settle: (() => void) | null = null;

    get scene(): any {
      return cv()?.scene ?? g()?.scenes?.current ?? null;
    }

    /**
     * The rows on the board: the ones the last render drew, read once per render (A29).
     *
     * `rowsFor` reads every pin, its source and each player's access, and a render called
     * it twice — once for the visible rows, once for the markup — and every arrow key a
     * third time. The render that begins clears it and reads it afresh, so the visible rows,
     * the markup and the keyboard until the next render all go by the same rows: the arrows
     * move through the list the GM is looking at. A decision made after a write reads the
     * pins as they are now instead (`rowsFor` itself), since the drawn rows are a frame
     * behind it until the render it asked for has run.
     */
    get rows(): PinboardRow[] {
      return (this.#rows ??= rowsFor(this.scene));
    }

    get visibleRows(): PinboardRow[] {
      return filterRows(this.rows, this.query);
    }

    /**
     * Render once the board's window next paints, however many ask before then (A29).
     *
     * A change the board made was drawn twice: once by the verb that made it and again by
     * the tile hook every client runs (`refreshPinboard`) — and a scene write of many pins,
     * or a source edit, once per hook more. Core queues renders but does not merge them
     * (its render semaphore), and every render rebuilds every row and fires every module's
     * render hooks. Everything that redraws the board because the pins changed asks here
     * instead, and the frame renders once with whatever is true by then: a status line or a
     * focus a verb set before asking is read by that render, so it rides along.
     *
     * The frame is the board's own window's — a detached board's popup keeps painting
     * while the main window is hidden. With no frame to wait for, a microtask. A render
     * that begins in the meantime (an arrow key, a search) reads everything the request was
     * for, and the frame then has nothing left to do. Resolves once the render has run.
     *
     * A frame is not a promise, so it is raced against a floor (`RENDER_FLOOR_MS`), as the
     * overlay's writes are: a window that stops painting — a minimised popup, a hidden tab —
     * fires no frame, and a popup closed by a re-attach takes the one it was asked for with
     * it. The request was shared by everything that asked after it, so one lost frame left
     * the board drawing nothing but arrow keys and searches for the rest of the session,
     * reopened or not. Whichever comes first runs, once; closing the board settles it.
     */
    requestRender(): Promise<void> {
      this.#wanted = true;
      if (this.#pending) return this.#pending;
      const view = docOf(this.element)?.defaultView;
      let frame = 0;
      let floor: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const pending = new Promise<void>((resolve) => {
        const settle = (): boolean => {
          if (settled) return false;
          settled = true;
          if (frame) view?.cancelAnimationFrame?.(frame);
          clearTimeout(floor);
          if (this.#pending === pending) {
            this.#pending = null;
            this.#settle = null;
          }
          return true;
        };
        const run = () => {
          if (!settle()) return;
          if (!this.#wanted) return resolve();
          this.#wanted = false;
          // Caught: nothing awaits a frame, and a render core refused must not surface as
          // an uncaught rejection in the middle of a session.
          Promise.resolve()
            .then(() => this.render())
            .catch((error: unknown) => log.warn("the board could not be redrawn", error))
            .finally(resolve);
        };
        this.#settle = () => {
          if (settle()) resolve();
        };
        if (typeof view?.requestAnimationFrame === "function") {
          frame = view.requestAnimationFrame(run);
          floor = setTimeout(run, RENDER_FLOOR_MS);
        } else queueMicrotask(run);
      });
      this.#pending = pending;
      return pending;
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

      // This render reads the pins afresh, once, and draws what it read; a render asked
      // for and still waiting on its frame has nothing left to do (`requestRender`).
      this.#rows = null;
      this.#wanted = false;
      const rows = this.rows;

      // Without this no row is ever tabbable — `rowMarkup` emits `tabindex="0"` only for
      // `focusedId` — so `P` opened the board with nothing focused and every one of the
      // ten advertised shortcuts was unreachable.
      //
      // Re-seeded whenever the focused row is not among the VISIBLE ones, not merely when
      // it is null: a search that excludes it leaves no row tabbable at all, and then
      // ArrowDown out of the search box has nothing to land on — which is exactly the
      // case that branch exists for.
      const visible = filterRows(rows, this.query);
      if (!this.focusedId || !visible.some((row) => row.id === this.focusedId)) {
        this.focusedId = visible[0]?.id ?? null;
      }

      const wrapper = (docOf(this.element) ?? document).createElement("div");
      wrapper.innerHTML = boardMarkup(
        rows,
        this.query,
        this.selected,
        this.focusedId,
        this.scene?.name ?? "",
        this.menu,
        this.status
      );
      return wrapper.firstElementChild ?? wrapper;
    }

    /**
     * The keys of a board that is gone are nobody's: its sheet goes with it. Core calls this
     * after the window has closed and does not await it, so nothing here may throw into it.
     */
    _onClose(options: unknown) {
      try {
        super._onClose?.(options);
      } finally {
        closeCheatSheet("board", false);
        // A render asked for a board that is gone has nothing to draw, and must not be the
        // request every later one is handed when the board opens again (`requestRender`).
        this.#wanted = false;
        this.#settle?.();
      }
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // The board's own document: a detached board's focus is in its window, not the
      // main one, and read from the main one it was lost on every render.
      const focused = (docOf(content)?.activeElement ?? null) as HTMLElement | null;
      // Preserve the caret: re-rendering on every keystroke would otherwise send the
      // cursor to the start of the search box and make typing a word impossible.
      const active = content.querySelector<HTMLInputElement>(".dp-board__search");
      const caret = active && active === focused ? active.selectionStart : null;
      // `#select` re-renders, and `replaceChildren` then destroyed the focus the click
      // had just established — so a GM could focus a row but never keep it.
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
      // The window's own element, header included, once: Space on a focused button here
      // must press the button and nothing else.
      guardActivationKeys(this.element ?? content);

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
      // A frame of the board's own window, which for a detached board is its popup.
      const view = docOf(root)?.defaultView;
      if (!deferred) focus();
      else if (view?.requestAnimationFrame) view.requestAnimationFrame(focus);
      else requestAnimationFrame(focus);
    }

    #wire(root: HTMLElement) {
      // A word still being composed — a dead key's accent, an IME's syllables — is not a
      // search yet: a render mid-composition rebuilt the field under it and dropped what
      // was being composed, so "é" or "日本" could not be typed at all. The search runs
      // when the composition ends, and once: a browser that follows `compositionend` with
      // a plain `input` finds the search already done.
      const search = (event: Event) => {
        const input = event.target as HTMLInputElement;
        if (input?.dataset?.action !== "search") return;
        if ((event as InputEvent).isComposing || input.value === this.query.search) return;
        this.query = { ...this.query, search: input.value };
        this.render();
      };
      root.addEventListener("input", search);
      root.addEventListener("compositionend", search);

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
          event.preventDefault();
          const change = api.chipClick(doc, chip.dataset.dpUser ?? "", {
            solo: (event as MouseEvent).shiftKey,
            wasOn: chip.getAttribute("aria-checked") === "true",
          });
          // The chip keeps the focus through it: the render finds it again by its player.
          void change?.then(() => this.requestRender());
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

    /** Close the row menu, remembering whose button gets the focus back. */
    closeMenu() {
      if (!this.menu) return;
      this.menuReturnTo = { id: this.menu.id, kind: this.menu.kind ?? "actions" };
      this.menu = null;
    }

    /**
     * The keyboard surface.
     *
     * Deliberately single letters with no modifier: a GM operating this while talking
     * cannot hold a chord. Nothing here is destructive, so a mistyped key costs one
     * keystroke to undo.
     *
     * Every key the board handles is `consume`d: prevented AND stopped. Core's keyboard
     * listens on the window and ignores `defaultPrevented`, and a focused row is not a
     * field to it, so a key the board only prevented went on to core's bindings — Space
     * revealed the pin and paused the game, an arrow moved the row and panned the map
     * (A29). A key the board does not handle goes on untouched, and so does an Escape
     * with nothing here to clear: that one is core's, and closes the window.
     */
    #onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const board = event.currentTarget as HTMLElement;

      // The sheet goes first, before the menu, the search and the selection — and core's
      // own Escape, which would close this board, or the window behind, after the sheet.
      if (event.key === "Escape" && closeCheatSheet()) return consume(event);

      // While the row menu is open it owns Escape and the arrows.
      if (this.menu) {
        if (event.key === "Escape") {
          this.closeMenu();
          this.render();
          return consume(event);
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const items = [...board.querySelectorAll<HTMLElement>(".dp-menu button")];
          const at = items.indexOf(docOf(board)?.activeElement as HTMLElement);
          const next = focusIndex(items.length, at, event.key === "ArrowDown" ? 1 : -1);
          items[next]?.focus();
          // The effect menu scrolls; the item the arrows reached must be in view.
          items[next]?.scrollIntoView?.({ block: "nearest" });
          return consume(event);
        }
      }
      // A field's text, and a BUTTON as well, because Space and the single letters are
      // real keystrokes for one: Space on a focused button activates it, and stealing
      // that would make the row controls unusable from the keyboard.
      const typing = isTextEntry(target) || target?.tagName === "BUTTON";

      if (event.key === "Escape") {
        if (this.query.search) this.query = { ...this.query, search: "" };
        else if (this.selected.length) this.selected = [];
        else return;
        this.render();
        return consume(event);
      }
      if (event.key === "/" && !typing) {
        board.querySelector<HTMLInputElement>(".dp-board__search")?.focus();
        return consume(event);
      }
      // Shift+/ on most layouts, so it cannot be mistaken for the search's `/`.
      // Any button but a text field: focus comes back to the `?` button when the sheet
      // closes, and from there `?` has to open it again.
      if (event.key === "?" && !isTextEntry(target)) {
        toggleCheatSheet("board", board);
        return consume(event);
      }
      // ArrowDown out of the search box is what makes "type four letters, then drive the
      // list" work — without it the search box is a one-way trip.
      if (typing && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const row = board.querySelector<HTMLElement>('.dp-row[tabindex="0"]');
        if (row) {
          row.focus({ preventScroll: true });
          return consume(event);
        }
      }
      if (typing) return;

      // Reveal next: the script's play button, with no row needed under the cursor. A
      // held key repeats, and a repeat is not a GM asking for the next clue — holding N
      // would reveal the scene. Stopped, so a global binding the GM set to the same key
      // cannot reveal a second pin from the same keystroke.
      if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        consume(event);
        if (!event.repeat) this.runRevealNext();
        return;
      }

      const visible = this.visibleRows;
      const current = visible.findIndex((r) => r.id === this.focusedId);

      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.altKey) {
        // Reorder from the keyboard: the reveal order is a script, and a script is
        // edited without reaching for the mouse.
        if (this.focusedId) void this.#move(this.focusedId, event.key === "ArrowDown" ? 1 : -1);
        return consume(event);
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
        return consume(event);
      }

      // The row's verbs. A verb key is the board's even when the row's pin has just gone
      // (deleted elsewhere, the list not yet redrawn): Space must not fall through to
      // core's pause for want of a pin.
      const doc = this.focusedId ? this.docFor(this.focusedId) : null;

      // Open the document on every screen in this pin's audience, right now. Not the same
      // as revealing: it pushes the sheet up rather than making the pin visible. The one
      // verb here that reaches the players' screens and cannot be taken back, so it is
      // the one that needs Shift: a bare letter in a list is what a GM types expecting to
      // jump to a row, and "s" for "Seal" used to put a document in front of the table.
      if (event.key.toLowerCase() === "s") {
        if (!event.shiftKey) return;
        consume(event);
        if (doc) void api.showToAudience(doc);
        return;
      }

      // Reveal & spotlight. Checked before Space itself, which took Shift+Space as the eye
      // and hid a revealed pin. The Shift is still down while it pings — which is why the
      // verb states `pull` rather than letting core read it off the keyboard.
      if (event.key === " " && event.shiftKey) {
        consume(event);
        if (!doc) return;
        void api
          .spotlight(doc)
          .then(() => this.requestRender())
          .catch((error) => {
            log.warn("spotlight failed", error);
            notify({ key: "DP.notice.spotlightFailed" }, "error");
          });
        return;
      }

      // A verb that writes asks for its render (`requestRender`): the tile hook its write
      // fires asks too, and the two are one render. The focus stays on the row meanwhile.
      const actions: Record<string, () => void> = {
        " ": () => void api.toggleVisibility(doc)?.then(() => this.requestRender()),
        Enter: () => Hooks.call(`${MODULE_ID}.openStudio`, doc),
        l: () => void api.locate(doc),
        o: () => void api.openLocally(doc),
        f: () => api.flash(doc),
        m: () => void api.toggleMode(doc)?.then(() => this.requestRender()),
      };
      const action = actions[event.key] ?? actions[event.key.toLowerCase()];
      if (!action) return;
      consume(event);
      if (doc) action();
    }

    /**
     * Reveal next, from N or the footer, then move the list on to what follows it.
     *
     * The focus goes to the row that is now next, so the GM's next N and the row under
     * their eyes are the same one; with nothing left it stays where it was. Chosen from
     * the pins as the reveal left them, not from the rows drawn before it. The status and
     * the focus are set before the render is asked for, which reads both when it runs.
     */
    async revealNext() {
      const { doc, left } = await api.revealNext(this.scene, this.query);
      if (!doc) return;
      const pin = readPin(doc);
      this.status = t("DP.board.statusRevealed", {
        name: pin ? api.labelFor(pin) : "",
        count: left,
      });
      this.focusedId = nextToReveal(rowsFor(this.scene), this.query).next?.id ?? this.focusedId;
      await this.requestRender();
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
      await api.reorder(this.scene, updates);
      await this.requestRender();
    }

    /**
     * Move a row one step in the full list. The sort values written are planned from the
     * pins as they are, which a reorder still waiting on its render has already changed.
     */
    #move(id: string, delta: number) {
      const rows = rowsFor(this.scene);
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
        // Planned from the pins as they are, as the keyboard's reorder is (`#move`).
        const rows = rowsFor(this.scene);
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
  // After the verb: its write's tile hook asks for the same render (`requestRender`).
  await this.requestRender();
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
 *
 * A reveal that fails is said: the GM pressed the scene's biggest button with the table
 * watching, and a rejection in the console is not an answer.
 */
async function onRevealAll(this: any) {
  try {
    const docs = store.all(this.scene);
    const players = playerIds();
    const count = docs.filter((doc: any) => {
      const pin = readPin(doc);
      return !!pin && wouldReveal(pin.audience, doc.hidden === true, players);
    }).length;

    if (
      count > 1 &&
      !(await confirmDialog("DP.board.revealAllTitle", "DP.board.revealAllBody", { count }))
    ) {
      return;
    }
    await applyVisibility(this, docs, true);
  } catch (error) {
    log.warn("reveal all failed", error);
    notify({ key: "DP.board.revealAllFailed" }, "error");
  }
}

/**
 * Only the pins the gesture changes, in one scene write, each to the audience it remembers
 * (`api.setVisibilityMany`). "Reveal all" over a scene where most pins already show wrote
 * every one of them anyway, and re-synced every one's ownership after.
 */
async function applyVisibility(app: any, docs: any[], reveal: boolean) {
  if (await api.setVisibilityMany(app.scene, docs, reveal)) await app.requestRender();
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

  if (
    !(await confirmDialog("DP.board.deleteTitle", "DP.board.deleteBody", { count: docs.length }))
  ) {
    return;
  }

  // Every grant released, then ONE scene write: not `api.deletePin` per row.
  await api.deletePins(app.scene, docs);

  app.selected = app.selected.filter((id: string) => !docs.some((doc) => doc.id === id));
  await app.requestRender();
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
  instance.render({ force: true });
  return instance;
}

/**
 * Re-render the open Pinboard, if any. Wired to the document hooks in `main.ts`.
 *
 * On the board's next frame (`requestRender`): a scene write fires a hook per pin, a source
 * edit one per document, and the verb that made the change asks too — one render for all.
 */
export function refreshPinboard(): void {
  if (instance?.rendered) void instance.requestRender();
}

declare const Hooks: any;
