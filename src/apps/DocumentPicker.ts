/**
 * Choosing what to pin.
 *
 * IMPURE. A flat, searchable list of every journal and page in the world, plus a route
 * into the file browser for a map scrap that has no journal behind it.
 *
 * Deliberately not a tree. A GM reaching for this knows the name of the thing they
 * want and does not want to remember which journal they filed it in — so pages are
 * listed alongside entries with their parent shown as context, and one search box
 * covers both. Choosing does not open a dialog: it arms the placement ghost and gets
 * out of the way, because the questions that remain are all about the map.
 */

import { g, ns } from "../fvtt";
import { t } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import { fold } from "./pinboard-model";
import { arm } from "./PlacementGhost";
import * as api from "../api";
import type { DpSource } from "../types/dp";

let PickerClass: any = null;
let instance: any = null;

export interface PickerEntry {
  uuid: string;
  name: string;
  context: string;
  kind: "entry" | "page";
  /** Page type — `text`, `image`, `pdf`, `video` — shown so a GM can tell them apart. */
  pageType: string | null;
}

/**
 * Every pinnable document, entries and pages alike.
 *
 * Entries whose only page shares their name are listed once: a single-page journal is
 * one thing to a GM, and showing it twice makes the list look broken.
 */
export function pickerEntries(): PickerEntry[] {
  const out: PickerEntry[] = [];

  for (const entry of g()?.journal?.contents ?? []) {
    const pages = entry.pages?.contents ?? [];
    out.push({
      uuid: entry.uuid,
      name: entry.name ?? "",
      context: "",
      kind: "entry",
      pageType: null,
    });

    if (pages.length === 1 && pages[0].name === entry.name) continue;
    for (const page of pages) {
      out.push({
        uuid: page.uuid,
        name: page.name ?? "",
        context: entry.name ?? "",
        kind: "page",
        pageType: page.type ?? null,
      });
    }
  }
  return out;
}

/** Search both the name and the parent journal, accent- and case-insensitively. */
export function filterEntries(entries: readonly PickerEntry[], search: string): PickerEntry[] {
  const needle = fold(search.trim());
  if (!needle) return [...entries];
  return entries.filter((e) => fold(e.name).includes(needle) || fold(e.context).includes(needle));
}

function entryMarkup(entry: PickerEntry, index: number, active: boolean): string {
  const icon = entry.kind === "entry" ? "fa-book" : "fa-file-lines";
  return (
    `<li class="dp-picker__item" role="option" id="dp-picker-opt-${index}"` +
    ` data-dp-uuid="${escapeAttr(entry.uuid)}" aria-selected="${active}">` +
    `<i class="fa-solid ${icon}" aria-hidden="true"></i>` +
    `<span class="dp-picker__name">${escapeHtml(entry.name)}</span>` +
    (entry.context ? `<span class="dp-picker__context">${escapeHtml(entry.context)}</span>` : "") +
    (entry.pageType ? `<span class="dp-picker__type">${escapeHtml(entry.pageType)}</span>` : "") +
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
  activeIndex = 0
): string {
  const active = Math.max(0, Math.min(entries.length - 1, activeIndex));
  const list = entries.length
    ? entries.map((entry, index) => entryMarkup(entry, index, index === active)).join("")
    : `<li class="dp-picker__empty">${escapeHtml(t("DP.picker.none"))}</li>`;

  return [
    `<div class="dp-picker">`,
    `<input type="search" class="dp-picker__search" data-action="search" autofocus`,
    ` role="combobox" aria-expanded="true" aria-controls="dp-picker-list" aria-autocomplete="list"`,
    entries.length ? ` aria-activedescendant="dp-picker-opt-${active}"` : "",
    ` value="${escapeAttr(search)}" placeholder="${escapeAttr(t("DP.picker.search"))}"`,
    ` aria-label="${escapeAttr(t("DP.picker.search"))}">`,
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
      actions: { browse: onBrowse },
    };

    search = "";
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

    async _renderHTML() {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pickerMarkup(
        filterEntries(pickerEntries(), this.search),
        this.search,
        this.activeIndex
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
        if (item?.dataset.dpUuid) this.#choose(item.dataset.dpUuid);
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
              this.#choose(active.dataset.dpUuid);
            }
            return;
          }
        }
      });
    }

    #choose(uuid: string) {
      const source: DpSource = {
        kind: "document",
        uuid,
        src: null,
        pageId: null,
        followName: true,
      };
      this.close();

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

/** The file-browser route, for a map scrap with no journal behind it. */
async function onBrowse(this: any) {
  const FilePicker = ns("applications.apps.FilePicker.implementation");
  if (!FilePicker) return;

  const picker = new FilePicker({
    type: "imagevideo",
    callback: (path: string) => {
      this.close();
      const source: DpSource = {
        kind: "image",
        uuid: null,
        src: path,
        pageId: null,
        followName: false,
      };
      if (this.adopt) {
        void adoptWith(this.adopt, source);
        this.adopt = null;
        return;
      }
      arm(source);
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
}

export function openPicker(options: PickerOptions = {}): any {
  const Picker = definePicker();
  if (!Picker) return null;
  instance ??= new Picker();
  instance.adopt = options.adopt ?? null;
  instance.render(true);
  return instance;
}
