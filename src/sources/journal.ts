/**
 * Journals and their pages, as a source.
 *
 * IMPURE only where it opens a sheet. Everything here is what the module did for a
 * journal before sources had adapters, moved rather than rewritten: the card a page
 * becomes, the page a pin on a whole journal shows, the grant that lands on a page and
 * the LIMITED that lands on its journal beside it, and the sheet a page opens inside.
 *
 * A journal page can be text, an image, a PDF or a video, and each makes a different
 * card — but every one of them goes through the same single enrichment call site in
 * `ContentResolver`, so the security properties hold whichever branch was taken.
 */

import { OWNERSHIP } from "../const";
import { escapeHtml } from "../html";
import { t } from "../i18n";
import { pdfSourceOf } from "../render/PdfPage";
import type { DpSource } from "../types/dp";
import type { GrantTarget, PageChoice, ShownFacts, SourceAdapter, SourceFacts } from "./index";

/** "Journal › Page" for a page, the shown document's own name otherwise. */
function journalCrumb(shown: ShownFacts): string {
  const name = typeof shown.name === "string" ? shown.name : "";
  const parent = shown.parent?.name;
  if (shown.documentName === "JournalEntryPage" && typeof parent === "string" && parent) {
    return `${parent} › ${name}`;
  }
  return name;
}

/** What kind of journal document it is, as an icon. */
function journalIcon(shown: ShownFacts): string {
  if (shown.documentName !== "JournalEntryPage") return "fa-book";
  switch (shown.type) {
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

/** The name, the crumb, the icon and the picture of what a journal source shows. */
export function journalFacts(shown: ShownFacts): SourceFacts {
  const isPage = shown.documentName === "JournalEntryPage";
  return {
    name: typeof shown.name === "string" ? shown.name : "",
    breadcrumb: journalCrumb(shown),
    icon: journalIcon(shown),
    thumbnail:
      isPage && shown.type === "image" && typeof shown.src === "string" && shown.src
        ? shown.src
        : null,
    isPage,
  };
}

/** The chosen page of a journal, else the document itself. */
function journalShown(named: any, pageId: string | null): any {
  return named && pageId && named.pages?.get ? (named.pages.get(pageId) ?? named) : named;
}

/**
 * The raw text a source contributes, by page type.
 *
 * An image or video page contributes an `<img>`; the inliner turns it into bytes
 * later. A PDF contributes its name only — a PDF cannot be rasterised into a card, and
 * pretending otherwise would produce a blank sheet with no explanation.
 */
function rawContentOf(source: any): { text: string; kind: string } {
  if (!source) return { text: "", kind: "missing" };

  const type = source.type ?? (source.pages ? "entry" : "text");
  switch (type) {
    case "text":
      return { text: source.text?.content ?? "", kind: "text" };
    case "image":
      return {
        text: source.src ? `<img src="${escapeHtml(source.src)}" alt="">` : "",
        kind: "image",
      };
    case "video":
      // A single frame at best; the design excludes animated content in a prop.
      return {
        text: source.src ? `<img src="${escapeHtml(source.src)}" alt="">` : "",
        kind: "video",
      };
    case "pdf":
      // The card body is a placeholder only until the page image arrives; `resolveCard`
      // replaces it for a source this client can actually draw. A PDF the module cannot
      // open — no pdf.js, a missing file — keeps saying so rather than showing a blank.
      return { text: `<p>${escapeHtml(t("DP.card.pdf"))}</p>`, kind: "pdf" };
    case "entry": {
      // A whole journal shows its first page, which is what a GM means by pinning one.
      const first = firstShownPage(source);
      return first ? rawContentOf(first) : { text: "", kind: "empty" };
    }
    default:
      return { text: source.text?.content ?? "", kind: type };
  }
}

/** A journal's pages in the order its own sheet lists them: by `sort`, not by creation. */
function sortedPages(entry: any): any[] {
  return [...(entry?.pages?.contents ?? [])].sort(
    (a: any, b: any) => (Number(a?.sort) || 0) - (Number(b?.sort) || 0)
  );
}

/**
 * A page whose OWN ownership keeps it from the players: a default set — not inherited from
 * the journal — below OBSERVER, at which a text page is not even listed (DESIGN §4).
 */
function hiddenFromPlayers(page: any): boolean {
  const level = page?.ownership?.default;
  return typeof level === "number" && level !== OWNERSHIP.INHERIT && level < OWNERSHIP.OBSERVER;
}

/**
 * The page a pin on a whole journal shows: the first by `sort` that its own ownership does
 * not hide from the players — or none, and the card is empty.
 *
 * It was `pages.contents[0]`, the first page CREATED: a location journal whose "GM notes"
 * came before its reordered "Handout" put the notes on the map for every player, secret
 * sections aside, and a card that differed from the page the journal opens on. The SAME page
 * on every client, the GM's included, so the GM sees what the table sees — never one chosen
 * by the viewer's own permission: a revealed pin reads without any (DESIGN §3.1), and a page
 * inheriting NONE from its journal would blank every prop with ownership sync off.
 */
function firstShownPage(entry: any): any | null {
  return sortedPages(entry).find((page) => !hiddenFromPlayers(page)) ?? null;
}

/** The pages of a journal, or none when there is no choice to make. */
function journalPages(named: any): PageChoice[] {
  const pages = sortedPages(named);
  if (pages.length < 2) return [];
  return pages.map((page: any) => ({
    id: page.id,
    name: page.name ?? "",
    type: page.type ?? "text",
  }));
}

/**
 * Where one anchor's grant lands, and at what level.
 *
 * The document the pin SHOWS gets the level its audience asks for. When that is a page,
 * its journal gets LIMITED beside it: enough for the journal to be listed in the player's
 * sidebar and for its sheet to open on the page — which a grant on the page alone does
 * not do (DESIGN A22) — and not enough to open any page that inherits from it, because
 * at LIMITED a text page is not even listed (DESIGN §4).
 *
 * It used to be the level on the journal, whatever page the pin showed. Every page with
 * `default: -1` inherits, so revealing page 3 of "Chapter 3 — GM notes" put the whole
 * chapter in every player's sidebar, and the sidebar access outlives the pin by design.
 *
 * A chosen page that no longer exists grants nothing. The card falls back to the
 * journal's first page, but a page the GM picked and then deleted is not a request to
 * share the whole journal.
 */
function journalGrantTargets(named: any, pageId: string | null, level: number): GrantTarget[] {
  if (!named) return [];
  let shown = named;
  if (pageId && named.pages?.get) {
    shown = named.pages.get(pageId);
    if (!shown) return [];
  }
  const entry = shown.documentName === "JournalEntryPage" ? shown.parent : null;
  if (!entry) return [{ doc: shown, level }];
  return [
    { doc: shown, level },
    { doc: entry, level: Math.min(level, OWNERSHIP.LIMITED) },
  ];
}

/**
 * Every document a grant for this source can sit on: its journal and each of its pages.
 *
 * A pin's grants never leave that family — choosing another page moves them between its
 * members — so this is the whole set a stale grant can be found in without walking the
 * world. Changing the pin's DOCUMENT is the one move that leaves it, and `syncAnchor`
 * takes the old uuid for exactly that.
 */
function journalFamily(doc: any): any[] {
  if (!doc) return [];
  const entry = doc.documentName === "JournalEntryPage" ? (doc.parent ?? null) : doc;
  if (!entry) return [doc];
  return [entry, ...(entry.pages?.contents ?? [])];
}

/**
 * Open the journal's sheet. A page opens inside its parent's sheet, which is where its
 * navigation lives. This branch takes BOTH page cases: a pin whose uuid names a page, and
 * a pin on an entry with a page chosen — `resolveSource` has already resolved the second
 * to the page.
 */
function openJournal(source: any): void {
  if (source.documentName === "JournalEntryPage" && source.parent?.sheet) {
    source.parent.sheet.render({ force: true, pageId: source.id });
    return;
  }
  // So anything reaching here is an entry with no page chosen, or one whose chosen page
  // has been deleted. Passing the stored id on would ask the sheet for a page that is
  // not there; the entry opens where it opens.
  source.sheet.render({ force: true });
}

const documentSource = (uuid: string, pageId: string | null = null): DpSource => ({
  kind: "document",
  uuid,
  src: null,
  pageId,
  pdfPage: null,
  followName: true,
});

export const journalAdapter: SourceAdapter = {
  names: ["JournalEntry", "JournalEntryPage"],
  layout: "page",
  // OBSERVER is the level at which a text page actually opens; LIMITED is the tease.
  openLevel: "OBSERVER",
  maxGrant: 2,
  syncOnCreate: true,
  canShow: true,

  fromDrop(data) {
    if (!data?.uuid) return null;
    if (data.type === "JournalEntryPage") return documentSource(data.uuid);
    if (data.type === "JournalEntry") {
      return documentSource(data.uuid, typeof data.pageId === "string" ? data.pageId : null);
    }
    return null;
  },
  fromDocument(doc) {
    return doc?.uuid ? documentSource(doc.uuid) : null;
  },
  // A page is embedded in its journal and is a source all the same; every journal edit
  // may change a card, as it always could.
  isSource: () => true,
  redrawsOn: () => true,
  shown: journalShown,
  describe: journalFacts,
  pdf: pdfSourceOf,
  rawContent: rawContentOf,
  pages: journalPages,
  grantTargets: journalGrantTargets,
  family: journalFamily,
  open: openJournal,
};
