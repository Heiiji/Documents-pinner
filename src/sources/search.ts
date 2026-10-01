/**
 * Finding a document to pin, by name: the world's journals, actors and items, then the
 * compendiums'.
 *
 * IMPURE, read-only. The picker's rows and `/pin`'s first match are both made here, so
 * the order a GM sees in the list is the order the chat command takes them in: journals,
 * then actors, then items, then compendiums.
 *
 * Deliberately not a tree. A GM reaching for this knows the name of the thing they want
 * and does not want to remember which journal they filed it in — so a journal's pages are
 * listed beside it with the journal shown as context, an actor or an item with its type.
 * Only top-level documents are listed: an item an actor owns, a token's actor, belongs
 * to its owner and cannot be pinned on its own (DESIGN A28, D3).
 */

import { cfg, g, packs, worldCollection } from "../fvtt";
import { fold } from "../normalise";
import { packFacts, playersCanRead } from "./packs";

/** The kinds of document the picker and `/pin` find, in the order they are listed. */
export const PINNABLE = ["JournalEntry", "Actor", "Item"] as const;
export type Pinnable = (typeof PINNABLE)[number];

export interface PickerEntry {
  uuid: string;
  name: string;
  context: string;
  kind: "entry" | "page";
  /** Page type — `text`, `image`, `pdf`, `video` — shown so a GM can tell them apart. */
  pageType: string | null;
  /** A world document, or one in a compendium pack. */
  origin: "world" | "pack";
  /** The kind of document: a journal (or one of its pages), an actor, an item. */
  documentName: Pinnable;
  /** The pack a compendium row is from, and whether some player's role cannot read it. */
  pack?: { id: string; title: string; locked: boolean };
}

/**
 * Every world journal and page.
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
      origin: "world",
      documentName: "JournalEntry",
    });

    if (pages.length === 1 && pages[0].name === entry.name) continue;
    for (const page of pages) {
      out.push({
        uuid: page.uuid,
        name: page.name ?? "",
        context: entry.name ?? "",
        kind: "page",
        pageType: page.type ?? null,
        origin: "world",
        documentName: "JournalEntry",
      });
    }
  }
  return out;
}

/** A system subtype as the system names it — "Non-player character" — else as it is. */
function typeLabel(documentName: string, type: unknown): string {
  if (typeof type !== "string" || !type) return "";
  const key = cfg()?.[documentName]?.typeLabels?.[type];
  const label = typeof key === "string" && key ? g()?.i18n?.localize?.(key) : null;
  return typeof label === "string" && label ? label : type;
}

/** The world's actors or items, each with its type as context. */
function worldDocuments(documentName: "Actor" | "Item"): PickerEntry[] {
  return (worldCollection(documentName)?.contents ?? []).map((doc: any) => ({
    uuid: doc.uuid,
    name: doc.name ?? "",
    context: typeLabel(documentName, doc.type),
    kind: "entry" as const,
    pageType: null,
    origin: "world" as const,
    documentName,
  }));
}

/** Every pinnable world document of these kinds, journals first, then actors, then items. */
export function worldEntries(kinds: readonly Pinnable[] = PINNABLE): PickerEntry[] {
  return [
    ...(kinds.includes("JournalEntry") ? pickerEntries() : []),
    ...(kinds.includes("Actor") ? worldDocuments("Actor") : []),
    ...(kinds.includes("Item") ? worldDocuments("Item") : []),
  ];
}

/** Search both the name and the context, accent- and case-insensitively. */
export function filterEntries(entries: readonly PickerEntry[], search: string): PickerEntry[] {
  const needle = fold(search.trim());
  if (!needle) return [...entries];
  return entries.filter((e) => fold(e.name).includes(needle) || fold(e.context).includes(needle));
}

/**
 * The first world document whose name contains the query, in the picker's order:
 * journals and their pages, then actors, then items. `/pin`'s own rule, which matches
 * the name only and ignores case, as it always has.
 */
export function firstWorldMatch(query: string): string | null {
  const needle = query.toLowerCase();
  const journals = (g()?.journal?.contents ?? []).flatMap((entry: any) => [
    entry,
    ...(entry.pages?.contents ?? []),
  ]);
  const candidates = [
    ...journals,
    ...(worldCollection("Actor")?.contents ?? []),
    ...(worldCollection("Item")?.contents ?? []),
  ];
  const found = candidates.find((doc: any) => doc?.name?.toLowerCase().includes(needle));
  return typeof found?.uuid === "string" ? found.uuid : null;
}

/** A compendium is searched only from this many folded characters. */
const PACK_QUERY_MIN = 2;
/** At most this many compendium rows; the rest are counted, and the GM keeps typing. */
const PACK_ROWS_MAX = 50;

/**
 * An index entry's folded name, and the name it was folded from, for as long as core
 * keeps that entry. The name is checked on every read: a document renamed in an unlocked
 * compendium may be merged INTO its existing entry rather than replace it (RECALLED:
 * `indexDocument` merges), and a cache keyed on the entry alone would go on matching the
 * old name until a reload.
 */
const foldedNames = new WeakMap<object, { name: string; folded: string }>();
/** Packs whose empty index this session has already asked core to load. */
const indexAsked = new WeakSet<object>();

function foldedName(entry: any): string {
  const name = String(entry?.name ?? "");
  const cached = foldedNames.get(entry);
  if (cached?.name === name) return cached.folded;
  const folded = fold(name);
  if (entry && typeof entry === "object") foldedNames.set(entry, { name, folded });
  return folded;
}

/**
 * The documents of every compendium of these kinds whose name, or whose pack's title,
 * contains the search — read from the index core already holds, never per keystroke from
 * the server.
 *
 * Only from two folded characters: one letter matches most of a rulebook. Packs in title
 * order, entries in index order, at most `PACK_ROWS_MAX`, the rest counted in `more`.
 * Top-level documents only, which is all an index lists: a page of a compendium journal
 * is chosen afterwards, in Pin Studio.
 *
 * A pack whose index is empty and not yet loaded is asked to load once per session, and
 * `onIndexed` runs when it has — for the caller to search again if it still can.
 */
export function packEntries(
  search: string,
  onIndexed?: () => void,
  kinds: readonly Pinnable[] = ["JournalEntry"]
): { entries: PickerEntry[]; more: number } {
  const needle = fold(search.trim());
  const entries: PickerEntry[] = [];
  let more = 0;
  if (needle.length < PACK_QUERY_MIN) return { entries, more };

  const searched = packs()
    .map((pack: any) => ({ pack, facts: packFacts(pack) }))
    .filter(({ facts }) => (kinds as readonly string[]).includes(facts.documentName))
    .sort((a, b) => a.facts.title.localeCompare(b.facts.title));

  for (const { pack, facts } of searched) {
    const index = pack.index;
    if (!index?.size) {
      if (!pack.indexed && typeof pack.getIndex === "function" && !indexAsked.has(pack)) {
        indexAsked.add(pack);
        void Promise.resolve()
          .then(() => pack.getIndex())
          .then(
            () => onIndexed?.(),
            () => {}
          );
      }
      continue;
    }

    const titleMatches = fold(facts.title).includes(needle);
    let locked: boolean | null = null;
    for (const entry of index.values?.() ?? index.contents ?? []) {
      if (!titleMatches && !foldedName(entry).includes(needle)) continue;
      const uuid = entry?.uuid ?? pack.getUuid?.(entry?._id);
      if (typeof uuid !== "string" || !uuid) continue;
      if (entries.length >= PACK_ROWS_MAX) {
        more++;
        continue;
      }
      locked ??= !playersCanRead(pack);
      entries.push({
        uuid,
        name: String(entry.name ?? ""),
        context: facts.title,
        kind: "entry",
        pageType: null,
        origin: "pack",
        documentName: facts.documentName as Pinnable,
        pack: { id: facts.id, title: facts.title, locked },
      });
    }
  }
  return { entries, more };
}
