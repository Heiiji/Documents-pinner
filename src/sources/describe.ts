/**
 * What a pin's source is, as one answer.
 *
 * IMPURE, and the ONE interpreter of `fromUuidSync`. Sixteen places used to ask it
 * directly and read what came back — a label here, an icon there, whether it is a PDF in
 * four places — and for a world journal that was a Document every time. For a compendium
 * document it is not. Core hands back the pack's index entry (a plain object with an
 * `_id`, a `uuid` and a `name`, and no `pages`, no `documentName`, no methods), or the
 * Document itself for five minutes after anything loaded it, or a throw for a page whose
 * journal is not cached. The same pin then had one label, icon and card before its card
 * was drawn, another for five minutes after, and the first again later.
 *
 * So a compendium source is described from its uuid and its pack's index ONLY: this file
 * never asks `fromUuidSync` about one, and no cache can flip an answer. What the index
 * cannot say — the name and type of a page inside a pack journal — is learned when the
 * page is actually loaded (`rememberShown`, called by `api.resolveSource`), and once
 * known is kept: unknown becomes known, never the other way.
 *
 * O(1): a string split and two `Map` reads. `pdfSourceForPin` runs on a drag preview's
 * refresh, so nothing here iterates players, packs or pages, and who can read a pack is
 * asked of `packs.ts` by the callers that need it.
 *
 * The journal-specific half is a set of named functions (`journalFacts`, `journalPdf`)
 * so that a later registry of per-type adapters can move them as they are.
 */

import { resolveUuidSync } from "../fvtt";
import { pdfSourceOf } from "../render/PdfPage";
import type { DpPinFlags, DpSource } from "../types/dp";
import { packFacts, packOf, type PackFacts } from "./packs";
import { isPackUuid, parseSourceUuid } from "./uuid";

export type SourceOrigin = "world" | "pack" | "image" | "missing";

export interface SourceSummary {
  origin: SourceOrigin;
  /** Of the document the uuid NAMES: `JournalEntry` or `JournalEntryPage`, or null. */
  documentName: string | null;
  uuid: string | null;
  /** The pack, as facts; whether a user can read it is `packs.packReadableBy`'s to say. */
  pack: PackFacts | null;
  /** World only: the named Document. Never an index entry, never a cached pack document. */
  doc: any | null;
  /** World only: what the card shows — the chosen page, else the named document. */
  shown: any | null;
  /** Pack only: the index entry of the top-level document, if this client has it. */
  index: Record<string, unknown> | null;
  /** The name of what the card shows; "" when it cannot be known. */
  name: string;
  /** "Journal › Page" for a world page, "Pack › Journal" for a compendium document. */
  breadcrumb: string;
  /** A Font Awesome class for the kind of thing it is. */
  icon: string;
  /** A picture that tells it from its neighbours, or null. */
  thumbnail: string | null;
  /**
   * The PDF this pin draws as a texture, or null — the one answer the four PDF paths
   * share: `drawsAsDom`, `PropManager`'s draw, the Studio's Appearance tab and the
   * migration's `drawnAsCard`. Never a compendium page's: its document arrives
   * asynchronously, so it is always drawn as a card, on every client, every time.
   */
  pdfSrc: string | null;
  /** What the card shows is one journal page, rather than a whole journal. */
  isPage: boolean;
}

/** What the card shows, as far as the facts go: a Document, or what a load recorded. */
interface ShownFacts {
  name?: unknown;
  documentName?: unknown;
  type?: unknown;
  src?: unknown;
  parent?: { name?: unknown } | null;
}

/** Name, type and picture of a compendium source's shown document, once loaded. */
const remembered = new Map<string, ShownFacts>();
const keyOf = (source: DpSource) => `${source.uuid ?? ""}#${source.pageId ?? ""}`;

/**
 * Record what an asynchronous load of a compendium source showed, so its label, icon and
 * breadcrumb can name the page from then on. World sources are read live and need none.
 */
export function rememberShown(source: DpSource, shown: any): void {
  if (source.kind !== "document" || !isPackUuid(source.uuid) || !shown) return;
  remembered.set(keyOf(source), {
    name: typeof shown.name === "string" ? shown.name : "",
    documentName: typeof shown.documentName === "string" ? shown.documentName : null,
    type: typeof shown.type === "string" ? shown.type : null,
    src: typeof shown.src === "string" ? shown.src : null,
  });
}

export function describeSource(source: DpSource): SourceSummary {
  if (source.kind === "image") return imageSummary(source.src);
  if (isPackUuid(source.uuid)) return packSummary(source);
  return worldSummary(source);
}

/** The PDF a pin draws as a texture, or null. See `SourceSummary.pdfSrc`. */
export function pdfSourceForPin(pin: DpPinFlags): string | null {
  if (pin.source.kind !== "document" || isPackUuid(pin.source.uuid)) return null;
  return describeSource(pin.source).pdfSrc;
}

// ---------------------------------------------------------------------------
// The journal half
// ---------------------------------------------------------------------------

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
export function journalFacts(
  shown: ShownFacts
): Pick<SourceSummary, "name" | "breadcrumb" | "icon" | "thumbnail" | "isPage"> {
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

/** The PDF a WORLD journal page draws as a texture. */
export function journalPdf(shown: any): string | null {
  return pdfSourceOf(shown);
}

// ---------------------------------------------------------------------------
// By origin
// ---------------------------------------------------------------------------

function worldSummary(source: DpSource): SourceSummary {
  const named = resolveUuidSync(source.uuid);
  const shown =
    named && source.pageId && named.pages?.get ? (named.pages.get(source.pageId) ?? named) : named;
  if (!shown) return missingSummary(source.uuid, null);
  return {
    origin: "world",
    documentName: typeof named.documentName === "string" ? named.documentName : null,
    uuid: source.uuid,
    pack: null,
    doc: named,
    shown,
    index: null,
    ...journalFacts(shown),
    pdfSrc: journalPdf(shown),
  };
}

function packSummary(source: DpSource): SourceSummary {
  const parsed = parseSourceUuid(source.uuid);
  const pack = packOf(source.uuid);
  if (!parsed || !pack) return missingSummary(source.uuid, pack ? packFacts(pack) : null);

  const facts = packFacts(pack);
  const index = pack.index?.get?.(parsed.rootId) ?? null;
  const entry = typeof index?.name === "string" ? index.name : "";
  const documentName = parsed.documentName ?? facts.documentName;
  // Until a load says otherwise, a page is named by its journal: the index lists entries.
  const shown = remembered.get(keyOf(source)) ?? {
    name: entry,
    documentName: source.pageId ? "JournalEntryPage" : documentName,
  };
  return {
    origin: "pack",
    documentName,
    uuid: source.uuid,
    pack: facts,
    doc: null,
    shown: null,
    index,
    ...journalFacts(shown),
    breadcrumb: entry ? `${facts.title} › ${entry}` : facts.title,
    pdfSrc: null,
  };
}

function imageSummary(src: string | null): SourceSummary {
  return {
    origin: "image",
    documentName: null,
    uuid: null,
    pack: null,
    doc: null,
    shown: null,
    index: null,
    name: fileName(src),
    breadcrumb: "",
    icon: "fa-image",
    thumbnail: src || null,
    pdfSrc: null,
    isPage: false,
  };
}

function missingSummary(uuid: string | null, pack: PackFacts | null): SourceSummary {
  return {
    origin: "missing",
    documentName: null,
    uuid,
    pack,
    doc: null,
    shown: null,
    index: null,
    name: "",
    breadcrumb: "",
    icon: "fa-circle-question",
    thumbnail: null,
    pdfSrc: null,
    isPage: false,
  };
}

/** An image's file name without its extension: what a GM called it on disk. */
function fileName(src: string | null): string {
  if (!src) return "";
  const last = src.split("/").pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    /* a stray % in a file name: show it as it is */
  }
  return name.replace(/\.[a-z0-9]+$/i, "");
}
