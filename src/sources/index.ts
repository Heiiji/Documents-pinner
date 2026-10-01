/**
 * What a pin can show, one adapter per kind of document.
 *
 * IMPURE only through the adapters it holds. Every question the module asks of a pin's
 * source — what it is called, what its card holds, which sheet opens it and at what level,
 * where a reveal's grant lands, which edits redraw it — used to be answered for a journal,
 * in place, wherever it was asked: `ContentResolver` switched on a journal page's `type`,
 * `ownership-sync` knew a page's parent, `api` knew that a page opens inside its journal's
 * sheet. An Actor's `type` is a system subtype (`npc`, `weapon`), which that switch would
 * have read as an unknown page and drawn as nothing. So the question is now asked of the
 * document's TYPE first, and each type answers for itself.
 *
 * Keyed by `documentName`: journals and their pages, actors, items. A document of no
 * registered type is read as a journal, which is what every source was before adapters
 * existed — a pin an API caller pointed at something else draws exactly as it always did.
 * RollTables, Scenes and Macros stay out (DESIGN §1.1): a table needs OWNER to roll, and
 * the other two have nothing a card could show.
 *
 * The import rule, for this whole directory: `sources/*` imports nothing that a test mocks
 * with a partial factory (`api`, `data/ownership-sync`, `render/ContentResolver`, `apps/*`,
 * `canvas/*`). The arrows point INTO `sources/`, so a module that is mocked in one test can
 * never find a half-built adapter behind it.
 */

import type { DpPinFlags, DpSource } from "../types/dp";
import { actorAdapter } from "./actor";
import { itemAdapter } from "./item";
import { journalAdapter } from "./journal";

/** One document an anchor's grant lands on, and the level it is raised to there. */
export interface GrantTarget {
  doc: any;
  level: number;
}

/** What a source shows, as far as the facts go: a Document, or what a load recorded. */
export interface ShownFacts {
  name?: unknown;
  documentName?: unknown;
  type?: unknown;
  src?: unknown;
  img?: unknown;
  prototypeToken?: { texture?: { src?: unknown } | null } | null;
  parent?: { name?: unknown } | null;
}

/** The part of a source's summary that depends on its kind of document. */
export interface SourceFacts {
  /** The name of what the card shows; "" when it cannot be known. */
  name: string;
  /** "Journal › Page" for a page; the name otherwise. */
  breadcrumb: string;
  /** A Font Awesome class for the kind of thing it is. */
  icon: string;
  /** A picture that tells it from its neighbours, or null. */
  thumbnail: string | null;
  /** What the card shows is one journal page, rather than a whole journal. */
  isPage: boolean;
}

/** A drop or a document of a type the module knows, refused: the notice that says why. */
export interface Refusal {
  refused: string;
}

export const isRefusal = (value: unknown): value is Refusal =>
  typeof (value as Refusal | null)?.refused === "string";

/** What a card's body is made of, before enrichment. */
export interface RawContent {
  /** Markup, enriched for this client's user before it reaches the card. */
  text: string;
  /** What kind of content it was, for the content hash. */
  kind: string;
  /** A picture to set above the name — an actor's portrait, an item's image — or null. */
  figure?: string | null;
}

/** One page a GM may choose between, in the Studio. */
export interface PageChoice {
  id: string;
  name: string;
  type: string;
}

export interface SourceAdapter {
  /** The `documentName`s this adapter answers for. */
  readonly names: readonly string[];
  /**
   * The card's layout, derived from the source rather than stored: a page of text, or a
   * portrait card — a picture above the name, the chosen text below, in the same shell.
   */
  readonly layout: "page" | "portrait";
  /**
   * The permission level the document's own sheet asks of a user before it opens, as
   * core's level name: what an icon pin needs, and what the key glyph compares against.
   */
  readonly openLevel: "LIMITED" | "OBSERVER";
  /** The highest level a reveal may grant on it, whatever the pin's own level says. */
  readonly maxGrant: 1 | 2;
  /** Whether a pin on it starts with ownership sync as the world's setting says, or off. */
  readonly syncOnCreate: boolean;
  /** Whether core's `Journal.show` can put it on a player's screen. */
  readonly canShow: boolean;
  /**
   * A source from a drag payload of one of `names`; a refusal for one this module will not
   * pin (an owned item, a token's actor); null to leave the drop to core.
   */
  fromDrop(data: any): DpSource | Refusal | null;
  /** A source from a document of one of `names` — the menus and the sheet header. */
  fromDocument(doc: any): DpSource | Refusal | null;
  /** Whether this document can be a pin's source at all: a top-level document can. */
  isSource(doc: any): boolean;
  /**
   * Whether an update to this document may change what a pin on it draws. Asked on every
   * update hook, so it must be cheap — an actor's hit points change on every blow in combat.
   */
  redrawsOn(doc: any, change: any): boolean;
  /** What the card shows of the document the uuid names: a chosen part of it, or itself. */
  shown(named: any, pageId: string | null): any;
  /** The kind-specific half of a source's summary. */
  describe(shown: ShownFacts): SourceFacts;
  /** The PDF this document is drawn from as a texture, or null. */
  pdf(shown: any): string | null;
  /** The raw markup the card body is enriched from, and what kind of content it was. */
  rawContent(shown: any, pin: DpPinFlags): RawContent;
  /** The parts of the named document a GM may choose between, or none. */
  pages(named: any): PageChoice[];
  /** Where a reveal's grant lands, at what level. */
  grantTargets(named: any, pageId: string | null, level: number): GrantTarget[];
  /** Every document a grant for this source can sit on. */
  family(doc: any): any[];
  /** Open the document's own sheet on this client. */
  open(shown: any): void;
}

const adapters = new Map<string, SourceAdapter>();

/** Answer for every `documentName` the adapter names. A later registration wins. */
export function register(adapter: SourceAdapter): void {
  for (const name of adapter.names) adapters.set(name, adapter);
}

/** The adapter for a type of document, or null when no adapter answers for it. */
export function adapterFor(documentName: unknown): SourceAdapter | null {
  return typeof documentName === "string" ? (adapters.get(documentName) ?? null) : null;
}

/**
 * The adapter for a type of document, where one answers for it; otherwise the journal's,
 * which is how every source was read before this registry.
 */
export function adapterOrJournal(documentName: unknown): SourceAdapter {
  return adapterFor(documentName) ?? journalAdapter;
}

/** The adapter for a resolved document, by its type. See `adapterOrJournal`. */
export function adapterForDoc(doc: any): SourceAdapter {
  return adapterOrJournal(doc?.documentName);
}

/** Every `documentName` whose edits can change a pin: the update hooks `main.ts` wires. */
export function hookedDocumentNames(): string[] {
  return [...adapters.keys()];
}

register(journalAdapter);
register(actorAdapter);
register(itemAdapter);
