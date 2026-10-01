/**
 * Choosing what to pin.
 *
 * IMPURE. A flat, searchable list of every journal, page, actor and item in the world,
 * then those of every compendium once the search has two letters, with chips to show one
 * kind alone, plus a route into the file browser for a map scrap that has no journal
 * behind it. The search itself is `sources/search.ts`; this file is the window.
 *
 * Deliberately not a tree. A GM reaching for this knows the name of the thing they
 * want and does not want to remember which journal they filed it in — so pages are
 * listed alongside entries with their parent shown as context, and one search box
 * covers both. Choosing does not open a dialog: it arms the placement ghost and gets
 * out of the way, because the questions that remain are all about the map.
 */

import { ns } from "../fvtt";
import { t, tOr } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import { arm } from "./PlacementGhost";
import * as api from "../api";
import { importForPin } from "../sources/import";
import { documentSource, imageSource } from "../data/pin-schema";
import {
  filterEntries,
  packEntries,
  PINNABLE,
  worldEntries,
  type PickerEntry,
  type Pinnable,
} from "../sources/search";
import type { DpSource } from "../types/dp";

let PickerClass: any = null;
let instance: any = null;

/** The chips above the list: every kind at once, or one. Images stay the Browse button. */
type PickerKind = "all" | Pinnable;
const KINDS: { kind: PickerKind; key: string }[] = [
  { kind: "all", key: "DP.picker.kindAll" },
  { kind: "JournalEntry", key: "DP.picker.kindJournals" },
  { kind: "Actor", key: "DP.picker.kindActors" },
  { kind: "Item", key: "DP.picker.kindItems" },
];

/** What one chip lets through. */
const kindsOf = (kind: PickerKind): readonly Pinnable[] => (kind === "all" ? PINNABLE : [kind]);

/** A row's icon: a compendium's, or the kind of document it is. */
function iconOf(entry: PickerEntry): string {
  if (entry.origin === "pack") return "fa-book-atlas";
  if (entry.documentName === "Actor") return "fa-user";
  if (entry.documentName === "Item") return "fa-suitcase";
  return entry.kind === "entry" ? "fa-book" : "fa-file-lines";
}

function entryMarkup(entry: PickerEntry, index: number, active: boolean, busy: boolean): string {
  const icon = iconOf(entry);
  const locked = entry.pack?.locked === true;
  return (
    `<li class="dp-picker__item${locked ? " dp-picker__item--locked" : ""}` +
    `${busy ? " dp-picker__item--importing" : ""}" role="option"` +
    ` id="dp-picker-opt-${index}" data-dp-uuid="${escapeAttr(entry.uuid)}"` +
    (busy ? ` aria-busy="true"` : "") +
    (locked
      ? ` data-dp-import="true" aria-description="${escapeAttr(t("DP.picker.lockedHint"))}"` +
        ` data-tooltip-text="${escapeAttr(t("DP.picker.lockedHint"))}"`
      : "") +
    ` aria-selected="${active}">` +
    `<i class="fa-solid ${icon}" aria-hidden="true"></i>` +
    `<span class="dp-picker__name">${escapeHtml(entry.name)}</span>` +
    (entry.context ? `<span class="dp-picker__context">${escapeHtml(entry.context)}</span>` : "") +
    (entry.pageType
      ? `<span class="dp-picker__type">` +
        `${escapeHtml(tOr(`DP.pageType.${entry.pageType}`, entry.pageType))}</span>`
      : "") +
    (locked
      ? `<span class="dp-picker__import">${escapeHtml(t("DP.picker.importPin"))}</span>`
      : "") +
    `</li>`
  );
}

/**
 * A combobox, not a list of tab stops: the focus never leaves the search box, and the
 * arrows move an active row that Enter takes. Typing must stay live while navigating,
 * which is why this is not the Pinboard's roving tabindex — there the rows are the
 * surface, here the search box is.
 */
export function pickerMarkup(
  entries: readonly PickerEntry[],
  search: string,
  activeIndex = 0,
  more = 0,
  importing: string | null = null,
  kind: PickerKind = "all"
): string {
  const active = Math.max(0, Math.min(entries.length - 1, activeIndex));
  const list =
    (entries.length
      ? entries
          .map((entry, index) =>
            entryMarkup(entry, index, index === active, entry.uuid === importing)
          )
          .join("")
      : `<li class="dp-picker__empty">${escapeHtml(t("DP.picker.none"))}</li>`) +
    (more
      ? `<li class="dp-picker__more" role="presentation">` +
        `${escapeHtml(t("DP.picker.more", { count: more }))}</li>`
      : "");

  return [
    `<div class="dp-picker">`,
    `<input type="search" class="dp-picker__search" data-action="search" autofocus`,
    ` role="combobox" aria-expanded="true" aria-controls="dp-picker-list" aria-autocomplete="list"`,
    entries.length ? ` aria-activedescendant="dp-picker-opt-${active}"` : "",
    ` value="${escapeAttr(search)}" placeholder="${escapeAttr(t("DP.picker.search"))}"`,
    ` aria-label="${escapeAttr(t("DP.picker.search"))}">`,
    `<div class="dp-picker__kinds" role="group" aria-label="${escapeAttr(t("DP.picker.kinds"))}">`,
    ...KINDS.map(
      (chip) =>
        `<button type="button" class="dp-picker__kind" data-action="kind"` +
        ` data-dp-kind="${chip.kind}" aria-pressed="${chip.kind === kind}">` +
        `${escapeHtml(t(chip.key))}</button>`
    ),
    `</div>`,
    `<ul class="dp-picker__list" id="dp-picker-list" role="listbox" aria-label="${escapeAttr(t("DP.picker.list"))}">`,
    list,
    `</ul>`,
    `<footer class="dp-picker__foot">`,
    `<button type="button" data-action="browse">`,
    `<i class="fa-solid fa-folder-open" aria-hidden="true"></i> ${escapeHtml(t("DP.picker.browse"))}`,
    `</button>`,
    `<span class="dp-picker__hint">${escapeHtml(t("DP.picker.hint"))}</span>`,
    `</footer>`,
    `</div>`,
  ].join("");
}

export function definePicker(): any {
  if (PickerClass) return PickerClass;

  const ApplicationV2 = ns("applications.api.ApplicationV2");
  if (!ApplicationV2) return null;

  PickerClass = class DocumentPicker extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "dp-document-picker",
      classes: ["dp-scope", "dp-picker-app"],
      tag: "section",
      window: { title: "DP.picker.title", icon: "fa-solid fa-thumbtack", resizable: true },
      position: { width: 460, height: 520 },
      actions: { browse: onBrowse, kind: onKind },
    };

    search = "";
    /** Which chip is on: every kind of document, or journals, actors or items alone. */
    kind: PickerKind = "all";
    /** The row the arrows have moved to, which Enter takes. Reset by typing. */
    activeIndex = 0;
    /**
     * A tile or note this picker is choosing a source FOR, rather than placing a new pin.
     *
     * The Tile config's "this is a pin" checkbox used to call a bare `openPicker()`,
     * which armed the ghost and placed a NEW pin somewhere else entirely — leaving the
     * tile being configured untouched and the GM with two objects. `adoptTile` was the
     * correct verb, already written and tested, and had no caller anywhere.
     */
    adopt: any = null;
    onChoose: ((source: DpSource) => void) | null = null;

    async _renderHTML() {
      // World rows first, then the compendiums': a GM's own world is what they reach for
      // most, and a rulebook's hundred matches must not bury it. A pack whose index arrives
      // later searches again, if this picker is still open to show it.
      const kinds = kindsOf(this.kind);
      const { entries, more } = packEntries(
        this.search,
        () => {
          if (this.rendered) void this.render();
        },
        kinds
      );
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pickerMarkup(
        [...filterEntries(worldEntries(kinds), this.search), ...entries],
        this.search,
        this.activeIndex,
        more,
        this.importing,
        this.kind
      );
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      const caret =
        content.querySelector(".dp-picker__search") === document.activeElement
          ? (document.activeElement as HTMLInputElement).selectionStart
          : null;

      content.replaceChildren(result);
      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      this.#wire(result);

      const search = content.querySelector<HTMLInputElement>(".dp-picker__search");
      if (caret !== null) {
        search?.focus();
        search?.setSelectionRange(caret, caret);
      } else {
        search?.focus();
      }
      // Keep the active row in view as the arrows move it.
      content
        .querySelector<HTMLElement>('.dp-picker__item[aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest" });
    }

    #wire(root: HTMLElement) {
      root.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input?.dataset?.action !== "search") return;
        this.search = input.value;
        this.activeIndex = 0;
        this.render();
      });

      root.addEventListener("click", (event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>(".dp-picker__item");
        if (item?.dataset.dpUuid) void this.#choose(item);
      });

      // The keyboard contract, all from the search box: the arrows move the active
      // row (clamped — a list with a top and a bottom should feel like one), Home and
      // End jump, PageUp and PageDown step by ten, Enter takes the active row (the
      // first by default, so "type four letters, press Enter" still holds), and Escape
      // clears the search before it closes. A resting pointer never moves the active
      // row: `:hover` is a wash, the marker is the keyboard's.
      root.addEventListener("keydown", (event) => {
        const items = root.querySelectorAll<HTMLElement>(".dp-picker__item");
        const count = items.length;
        const move = (delta: number) => {
          if (!count) return;
          this.activeIndex = Math.max(0, Math.min(count - 1, this.activeIndex + delta));
          event.preventDefault();
          this.render();
        };
        switch (event.key) {
          case "ArrowDown":
            return move(1);
          case "ArrowUp":
            return move(-1);
          case "PageDown":
            return move(10);
          case "PageUp":
            return move(-10);
          case "Home":
            return move(-count);
          case "End":
            return move(count);
          case "Escape":
            if (this.search) {
              event.preventDefault();
              this.search = "";
              this.activeIndex = 0;
              this.render();
            }
            return;
          case "Enter": {
            const active = items[Math.max(0, Math.min(count - 1, this.activeIndex))];
            if (active?.dataset.dpUuid) {
              event.preventDefault();
              void this.#choose(active);
            }
            return;
          }
        }
      });
    }

    /**
     * The compendium uuid being imported, or null. A second Enter while it runs would
     * import twice; the row says it is busy, so a slow server is not a click that did
     * nothing.
     */
    importing: string | null = null;

    /**
     * Take a row. A compendium some player's role cannot read is IMPORTED first, and the
     * world copy is what is placed, adopted or retargeted to — a pin the whole table can
     * be given. A failed import has said so and takes nothing; a picker closed while the
     * copy was being made takes nothing either.
     */
    async #choose(item: HTMLElement) {
      const uuid = item.dataset.dpUuid;
      if (!uuid) return;
      if (item.dataset.dpImport !== "true") {
        this.close();
        this.take(documentSource(uuid));
        return;
      }
      if (this.importing) return;
      this.importing = uuid;
      void this.render();
      const copy = await importForPin(uuid).finally(() => {
        this.importing = null;
      });
      if (!this.rendered) return;
      if (!copy) {
        void this.render();
        return;
      }
      this.close();
      this.take(copy);
    }

    /**
     * What happens to the chosen source.
     *
     * `onChoose` wins over `adopt`, and both are cleared the moment they fire. The
     * picker is a single reused instance, so an intent left behind is an intent that
     * runs on the NEXT open — which is the bug `adopt` was already nulled to prevent.
     */
    take(source: DpSource) {
      if (this.onChoose) {
        const take = this.onChoose;
        this.onChoose = null;
        take(source);
        return;
      }
      if (this.adopt) {
        void adoptWith(this.adopt, source);
        this.adopt = null;
        return;
      }
      arm(source);
    }
  };

  return PickerClass;
}

/** A chip: show one kind of document, or every kind, and start again at the first row. */
function onKind(this: any, _event: Event, target: HTMLElement) {
  const kind = target?.dataset?.dpKind;
  if (!KINDS.some((chip) => chip.kind === kind)) return;
  this.kind = kind;
  this.activeIndex = 0;
  this.render();
}

/** The file-browser route, for a map scrap with no journal behind it. */
async function onBrowse(this: any) {
  const FilePicker = ns("applications.apps.FilePicker.implementation");
  if (!FilePicker) return;

  const picker = new FilePicker({
    type: "imagevideo",
    callback: (path: string) => {
      this.close();
      this.take(imageSource(path));
    },
  });
  picker.render(true);
}

/** Attach the chosen source to the placeable that opened the picker. */
async function adoptWith(target: any, source: DpSource): Promise<void> {
  if (target.documentName === "Note") await api.adoptNote(target, source);
  else await api.adoptTile(target, source);
}

export interface PickerOptions {
  /** Adopt this placeable instead of placing a new pin. */
  adopt?: any;
  /** Open on this search, as `/pin` does when only a compendium the players cannot read matches. */
  search?: string;
  /**
   * Take the chosen source instead of adopting or arming the ghost.
   *
   * The picker's job is "let the GM name a document"; what happens next belongs to the
   * caller. A second `{ retarget: doc }` field beside `adopt` would give one reused
   * instance two mutually exclusive intents to keep straight, which is the bug `adopt`
   * is already nulled after firing to avoid.
   */
  onChoose?: ((source: DpSource) => void) | null;
}

export function openPicker(options: PickerOptions = {}): any {
  const Picker = definePicker();
  if (!Picker) return null;
  instance ??= new Picker();
  instance.adopt = options.adopt ?? null;
  instance.onChoose = options.onChoose ?? null;
  if (options.search !== undefined) {
    instance.search = options.search;
    instance.activeIndex = 0;
  }
  instance.render(true);
  return instance;
}
