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
 * What depends on the kind of document — a journal's crumb and page icons, its PDF — is
 * the adapter's to say (`sources/index.ts`): this file finds the document, and asks.
 */

import { resolveUuidSync } from "../fvtt";
import type { DpPinFlags, DpSource } from "../types/dp";
import { adapterForDoc, type ShownFacts } from "./index";
import { packFacts, packOf, type PackFacts } from "./packs";
import { isPackUuid, parseSourceUuid } from "./uuid";

export type SourceOrigin = "world" | "pack" | "image" | "missing";

export interface SourceSummary {
  origin: SourceOrigin;
  /** Of the document the uuid NAMES: `JournalEntry`, `JournalEntryPage`, `Actor`, `Item`, or null. */
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
   * The PDF this pin draws as a texture, or null — the one answer every PDF path shares,
   * through `pdfSourceForPin` and `isPdfPin`: `drawsAsDom`, `PropManager`'s draw, the
   * Studio's PDF page field, Appearance tab and fog note, and the migration's
   * `drawnAsCard`. Never a compendium page's: its document arrives asynchronously, so it
   * is always drawn as a card, on every client, every time.
   */
  pdfSrc: string | null;
  /** What the card shows is one journal page, rather than a whole journal. */
  isPage: boolean;
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
  // The token's art too, which the pack's index does not carry: an actor whose own image is
  // a default is pictured by it, on its card and — once loaded — in the Pinboard.
  const token = shown.prototypeToken?.texture?.src;
  remembered.set(keyOf(source), {
    name: typeof shown.name === "string" ? shown.name : "",
    documentName: typeof shown.documentName === "string" ? shown.documentName : null,
    type: typeof shown.type === "string" ? shown.type : null,
    src: typeof shown.src === "string" ? shown.src : null,
    img: typeof shown.img === "string" ? shown.img : null,
    prototypeToken: typeof token === "string" ? { texture: { src: token } } : null,
  });
}

export function describeSource(source: DpSource): SourceSummary {
  if (source.kind === "image") return imageSummary(source.src);
  if (isPackUuid(source.uuid)) return packSummary(source);
  return worldSummary(source);
}

/**
 * Whether a pin is a PDF drawn as a texture: painted by pdf.js straight into the scene, so
 * it has no card, no paper and no CSS, is lit and fogged like the map, and no setting
 * sends it to the DOM tier. See `SourceSummary.pdfSrc`.
 */
export function isPdfPin(pin: DpPinFlags): boolean {
  return pdfSourceForPin(pin) !== null;
}

/**
 * Which page of its PDF a pin shows, one-based as pdf.js counts: `source.pdfPage`, never
 * `pageId`, which names a journal's page. The normaliser already floors and clamps it;
 * this holds for a payload that has not been through it.
 */
export function pdfPageOf(pin: DpPinFlags): number {
  const raw = Number(pin?.source?.pdfPage);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/** The PDF a pin draws as a texture, or null. See `SourceSummary.pdfSrc`. */
export function pdfSourceForPin(pin: DpPinFlags): string | null {
  if (pin.source.kind !== "document" || isPackUuid(pin.source.uuid)) return null;
  // The summary's own answer, without building the summary: this is the drag preview's.
  const named = resolveUuidSync(pin.source.uuid);
  const adapter = adapterForDoc(named);
  return adapter.pdf(adapter.shown(named, pin.source.pageId));
}

// ---------------------------------------------------------------------------
// By origin
// ---------------------------------------------------------------------------

function worldSummary(source: DpSource): SourceSummary {
  const named = resolveUuidSync(source.uuid);
  const adapter = adapterForDoc(named);
  const shown = adapter.shown(named, source.pageId);
  if (!shown) return missingSummary(source.uuid, null);
  return {
    origin: "world",
    documentName: typeof named.documentName === "string" ? named.documentName : null,
    uuid: source.uuid,
    pack: null,
    doc: named,
    shown,
    index: null,
    ...adapter.describe(shown),
    pdfSrc: adapter.pdf(shown),
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
  // An actor's or an item's entry also carries its picture and its type.
  const shown = remembered.get(keyOf(source)) ?? {
    name: entry,
    documentName: source.pageId ? "JournalEntryPage" : documentName,
    img: index?.img,
    type: index?.type,
  };
  return {
    origin: "pack",
    documentName,
    uuid: source.uuid,
    pack: facts,
    doc: null,
    shown: null,
    index,
    ...adapterForDoc(shown).describe(shown),
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
