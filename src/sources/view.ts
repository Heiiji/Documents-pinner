/**
 * A pin's source, as the module's surfaces see it: the source a drop or a document makes,
 * the document a pin shows, the pages and the fields a GM may choose between, what a reveal
 * shares, and what the pin is called.
 *
 * IMPURE: it reads the world through `fvtt.ts` and the adapters, and writes nothing. It was
 * `api.ts`'s "Sources" section, and `api.ts` re-exports every name here, so a macro, another
 * module and the rest of the code read them where they always did. Here, the render layer
 * can ask what a pin shows without importing the module's verbs — `ContentResolver` did,
 * and `api` imported `ContentResolver` back.
 *
 * Under the directory's import rule (`sources/index.ts`): nothing a test mocks with a
 * partial factory. So what a reveal shares is read off the source's adapter, the function
 * the grant itself is made by, not through `ownership-sync`.
 */

import { g, notify, resolveUuid } from "../fvtt";
import { describeSource, rememberShown } from "./describe";
import { fieldsFor, rankDefault, type FieldChoice } from "./fields";
import {
  adapterFor,
  adapterForDoc,
  adapterOrJournal,
  isRefusal,
  type PageChoice,
  type Refusal,
} from "./index";
import { packFacts, packLockedHere, packOf, playersCanRead } from "./packs";
import { isPackUuid } from "./uuid";
import { imageSource } from "../data/pin-schema";
import type { DpPinFlags, DpSource } from "../types/dp";

/**
 * A pin source from a sidebar drag payload — or, for a document of a type the module
 * knows but will not pin (an item an actor owns, a token's actor), the notice that says
 * why, so the drop can be refused rather than left to core as if it were not ours.
 *
 * A document of a type some adapter answers for (`sources/index.ts`) becomes a document
 * source, and bare image files an image source. Anything else returns `null`, which lets
 * the drop fall through to whatever core or another module would have done, rather than
 * producing a pin of the wrong thing.
 */
export function dropOutcome(data: any): DpSource | Refusal | null {
  if (!data) return null;

  const named = adapterFor(data.type)?.fromDrop(data);
  if (named) return named;
  // Core's file browser drags a TILE: `{type: "Tile", texture: {src}, fromFilePicker}`
  // (foundry.mjs 14.367, 33809). Reading only a bare `src` or `path` missed it, so an
  // Alt-drop of an image from the browser fell through to core and made a plain tile.
  const path =
    data.src ??
    data.path ??
    (data.type === "Tile" ? data.texture?.src : null) ??
    (typeof data === "string" ? data : null);
  if (typeof path === "string" && path) {
    return imageSource(path);
  }
  return null;
}

/** `dropOutcome`, for a caller that only wants a source: a refused drop is none. */
export function sourceFromDropData(data: any): DpSource | null {
  const outcome = dropOutcome(data);
  return isRefusal(outcome) ? null : outcome;
}

/** A source from a document — the menus, the sheet header — or null for one not pinned. */
export function sourceFromDocument(doc: any): DpSource | null {
  const outcome = adapterFor(doc?.documentName)?.fromDocument(doc) ?? null;
  return isRefusal(outcome) ? null : outcome;
}

/** The adapter for the document a source names, by its uuid or its pack: no load. */
export function adapterOf(source: DpSource) {
  return adapterOrJournal(source.kind === "document" ? describeSource(source).documentName : null);
}

/**
 * The document a pin shows, loaded: the chosen page, else the named document, or `null`
 * for an image source, a deleted target — or a compendium this client's role cannot read,
 * which is never asked for (`packLockedHere`).
 */
export async function resolveSource(pin: DpPinFlags): Promise<any> {
  if (pin.source.kind !== "document") return null;
  if (packLockedHere(pin.source.uuid)) return null;
  const doc = await resolveUuid(pin.source.uuid);
  if (!doc) return null;
  const shown = adapterForDoc(doc).shown(doc, pin.source.pageId);
  // A compendium page's name and type are not in its pack's index; now they are known.
  rememberShown(pin.source, shown);
  return shown;
}

/**
 * The synchronous form, for render paths. Returns `null` rather than awaiting — and
 * always for a compendium source, whatever core's cache happens to hold: see
 * `describeSource`, which this reads.
 */
function resolveSourceSync(pin: DpPinFlags): any {
  if (pin.source.kind !== "document") return null;
  return describeSource(pin.source).shown;
}

/**
 * What the pin shows, for a caller that can wait: a world source at once, a compendium
 * source once its document has loaded.
 */
export async function shownSource(pin: DpPinFlags): Promise<any> {
  if (pin.source.kind !== "document") return null;
  return isPackUuid(pin.source.uuid) ? resolveSource(pin) : resolveSourceSync(pin);
}

/** The parts of a document a GM may choose between: a journal's pages, or none. */
const pagesOf = (named: any): PageChoice[] => adapterForDoc(named).pages(named);

/**
 * The pages a GM may choose between for this pin.
 *
 * Empty when there is no choice to make: an image source, a pin whose uuid already names
 * one page (`doc.pages` is undefined on a JournalEntryPage, so that falls out with no
 * type check), a source that no longer resolves, or a single-page journal, where there is
 * nothing to choose. (The picker's rule differs: it lists such a journal once only when its
 * page shares its name.)
 *
 * Reads the NAMED document rather than `resolveSourceSync`'s: that one already returns
 * the chosen page, which is the wrong document to enumerate siblings of. World sources
 * only — a compendium journal's pages exist only once it has loaded: `pageChoicesFor`.
 */
export function pageChoices(pin: DpPinFlags): PageChoice[] {
  if (pin.source.kind !== "document") return [];
  return pagesOf(describeSource(pin.source).doc);
}

/** `pageChoices`, for any source: a compendium journal is loaded to list its pages. */
export async function pageChoicesFor(pin: DpPinFlags): Promise<PageChoice[]> {
  if (pin.source.kind !== "document") return [];
  if (!isPackUuid(pin.source.uuid)) return pageChoices(pin);
  if (packLockedHere(pin.source.uuid)) return [];
  return pagesOf(await resolveUuid(pin.source.uuid));
}

/** The text fields a GM may choose between for an actor's or an item's card. */
export interface FieldChoices {
  fields: FieldChoice[];
  /** The label of the field the automatic choice shows, or null when none would. */
  automatic: string | null;
}

/**
 * The fields of the document a portrait pin shows, or null for a pin that has none to
 * choose — a journal, an image. A compendium document needs no load: its type is in the
 * pack's index, and its fields are its type's.
 */
export function fieldChoices(pin: DpPinFlags): FieldChoices | null {
  if (pin.source.kind !== "document") return null;
  const summary = describeSource(pin.source);
  const documentName = summary.documentName;
  if (!documentName || adapterOrJournal(documentName).layout !== "portrait") return null;
  const fields = fieldsFor(documentName, summary.doc?.type ?? summary.index?.type, summary.doc);
  const automatic = rankDefault(fields);
  return { fields, automatic: fields.find((field) => field.path === automatic)?.label ?? null };
}

/** What revealing a pin shares, for the Studio to say where the choice is made. */
export type GrantScope =
  | { kind: "page"; page: string; entry: string }
  | { kind: "journal"; entry: string; pages: number }
  | { kind: "pack"; pack: string; entry: string }
  | { kind: "actor"; name: string; level: number }
  | { kind: "item"; name: string; level: number };

/**
 * One page and its journal's listing, a whole journal, or a compendium document — which
 * grants nothing, and says so — or null when there is nothing to say: an image, a
 * document that is gone.
 *
 * Read off the adapter's `grantTargets`, the function the grant itself is made by
 * (`ownership-sync` forwards to it), so the sentence the GM reads and the permission the
 * player receives cannot drift apart.
 */
export function grantScope(pin: DpPinFlags): GrantScope | null {
  if (pin.source.kind !== "document") return null;
  const summary = describeSource(pin.source);
  if (summary.origin === "pack" && summary.pack) {
    return { kind: "pack", pack: summary.pack.title, entry: summary.name };
  }
  const named = summary.doc;
  if (!named) return null;
  const targets = adapterForDoc(named).grantTargets(
    named,
    pin.source.pageId,
    pin.audience.ownershipSync.level
  );
  const [shown, entry] = targets.map((target) => target.doc);
  if (!shown) return null;
  if (summary.documentName === "Actor" || summary.documentName === "Item") {
    const kind = summary.documentName === "Actor" ? ("actor" as const) : ("item" as const);
    return { kind, name: shown.name ?? "", level: targets[0].level };
  }
  if (entry) return { kind: "page", page: shown.name ?? "", entry: entry.name ?? "" };
  return { kind: "journal", entry: shown.name ?? "", pages: shown.pages?.contents?.length ?? 0 };
}

const untitled = (): string => g()?.i18n?.localize?.("DP.pin.untitled") ?? "Pin";

/** The label for a source that has no pin yet — the placement ghost's chip. */
export function labelForSource(source: DpSource): string {
  return describeSource(source).name || untitled();
}

/**
 * What to write on the pin.
 *
 * An explicit label always wins. Otherwise the source's own name is used and kept in
 * step with it, which is what `followName` is for — a GM who renames "Letter" to "The
 * Duke's Letter" should not have to find every pin of it.
 */
export function labelFor(pin: DpPinFlags): string {
  if (pin.display.label) return pin.display.label;
  return describeSource(pin.source).name || untitled();
}

/**
 * Tell the GM, once, when some player cannot open the compendium a pin was just pointed
 * at. Their client shows a placeholder that says why; the GM learns it here, where the
 * choice was made, rather than from the table.
 */
export function warnIfPlayersCannotRead(source: DpSource): void {
  if (source.kind !== "document") return;
  const pack = packOf(source.uuid);
  if (!pack || playersCanRead(pack)) return;
  notify({ key: "DP.notice.packUnreadable", data: { pack: packFacts(pack).title } }, "warn");
}
