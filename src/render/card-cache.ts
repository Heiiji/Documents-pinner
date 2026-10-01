/**
 * What a card is made of, kept between resolves (DESIGN A29).
 *
 * IMPURE: two module-level shelves, filled by `ContentResolver` and emptied by the source
 * hooks `main.ts` wires in.
 *
 * Resolving a card enriches a document — `enrichHTML`, then the sanitiser's parse, scrub
 * and re-parse — and then mounts it in a hidden probe for one forced layout. The DOM tier's
 * key carries the LOD rung and the effects level, because the dressing depends on both,
 * so every rung crossed, every focus, every trip off screen and back and every level flip
 * did all of that again for a card whose words had not changed. Fifty props on a map paid
 * it fifty times after a zoom. The words and their height depend on far less than the
 * dressing does, so they are kept here, and a rung change costs a string and an
 * `innerHTML`.
 *
 * Two shelves, split along what each depends on:
 *
 * - **Bodies** — what the source and the viewer decide: the document shown (a whole
 *   journal's first shown page included, which depends on page order and ownership), the
 *   text field an actor's card shows, the viewer's ownership (secrets), and everything
 *   `enrichHTML` folds in for that viewer. A PDF's body is its page drawn at one long edge,
 *   so `toDataURL` runs once per edge instead of once per resolve.
 * - **Measurements** — the height a body needs at a width, a type size, a margin, a face,
 *   a stock and a title. Not the dressing: an effect's frame is drawn on `::after`, its
 *   overlay is absolutely positioned and its motion only translates, so nothing a preset
 *   sets moves a line (`styles/fx/effects.css`, `card.css`).
 *
 * What is NOT kept, because each would be a wrong card served from memory: a placeholder,
 * a source that could not be found, an enrichment that threw and fell back to the raw
 * text, a rejected resolve, and a measurement that gave up on a face or a picture.
 *
 * Kept per client and per user by construction — the module renders nothing for anyone
 * else (`enrich.ts`, rule 1) — and the viewer's ownership is in every body key besides.
 * A change to THIS user's role or permissions clears everything (`clearResolved`), as does
 * the canvas going away.
 */

/** A card's body: what is drawn inside the sheet, before any dressing. */
export interface CardBody {
  /** Enriched and scrubbed markup, or a PDF page's `<img>`. */
  html: string;
  /** The portrait above the name, built and scrubbed, or "". */
  figureHtml: string;
  /** What kind of content it was, for the content hash. */
  kind: string;
  /** Whether this user owns the source — what decided its secrets. */
  isOwner: boolean;
  /** `ContentResolver`'s content hash, computed once from the fields above. */
  contentHash: string;
  /** A PDF page's drawn size, in pixels. */
  page?: { width: number; height: number };
}

/** What a computation hands the shelf: the value, and whether it may be kept. */
export interface Computed<T> {
  value: T;
  keep: boolean;
  /** What keeping it costs, in bytes. */
  bytes?: number;
}

interface Slot<T> {
  /** The document the entry was drawn from, which `forgetSource` matches on. */
  uuid: string;
  promise: Promise<T>;
  bytes: number;
}

/**
 * A bounded, least-recently-used map of promises.
 *
 * The PROMISE is what is shared, so two resolves of one card in the same frame — the DOM
 * tier and the reader, say — enrich it once. A slot is in the map from the moment its work
 * starts, and its result is kept only if the slot is still the current one when the work
 * ends: a slot forgotten while in flight hands its value to the callers already waiting and
 * keeps nothing, so an edit made mid-enrichment can never be overwritten by the text from
 * before it.
 */
class Shelf<T> {
  readonly #slots = new Map<string, Slot<T>>();
  #bytes = 0;

  constructor(
    private readonly limit: number,
    private readonly budget: number
  ) {}

  take(key: string, uuid: string, compute: () => Promise<Computed<T>>): Promise<T> {
    const hit = this.#slots.get(key);
    if (hit) {
      // Most recently used goes last, so eviction takes the oldest.
      this.#slots.delete(key);
      this.#slots.set(key, hit);
      return hit.promise;
    }

    // In the map BEFORE the work starts, so a computation that throws synchronously
    // still finds its own slot to remove — rather than leaving a rejection cached.
    const slot = { uuid, bytes: 0 } as Slot<T>;
    this.#slots.set(key, slot);
    slot.promise = this.#fill(key, slot, compute);
    this.#trim();
    return slot.promise;
  }

  async #fill(key: string, slot: Slot<T>, compute: () => Promise<Computed<T>>): Promise<T> {
    let result: Computed<T>;
    try {
      result = await compute();
    } catch (error) {
      this.#remove(key, slot);
      throw error;
    }
    if (this.#slots.get(key) !== slot) return result.value;
    const bytes = Math.max(0, result.bytes ?? 0);
    // One entry larger than the whole budget would evict everything else and then itself.
    if (!result.keep || bytes > this.budget) {
      this.#remove(key, slot);
      return result.value;
    }
    slot.bytes = bytes;
    this.#bytes += bytes;
    this.#trim();
    return result.value;
  }

  /** Drop every entry drawn from a document `matches` names. */
  forget(matches: (uuid: string) => boolean): void {
    for (const [key, slot] of [...this.#slots]) {
      if (matches(slot.uuid)) this.#remove(key, slot);
    }
  }

  clear(): void {
    this.#slots.clear();
    this.#bytes = 0;
  }

  get size(): number {
    return this.#slots.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  #remove(key: string, slot: Slot<T>): void {
    if (this.#slots.get(key) !== slot) return;
    this.#slots.delete(key);
    this.#bytes -= slot.bytes;
  }

  #trim(): void {
    for (const [key, slot] of this.#slots) {
      if (this.#slots.size <= this.limit && this.#bytes <= this.budget) return;
      this.#remove(key, slot);
    }
  }
}

/**
 * How many bodies are kept, and how many bytes of them.
 *
 * Both, because they fail differently: a scene of fifty short letters is fifty small
 * strings, and one pinned PDF is a data URL of a few megabytes per edge — a page pasted
 * into a journal as a data image is the same. Counted as UTF-16, which is what a string
 * costs in the heap.
 */
export const BODY_LIMIT = 200;
export const BODY_BUDGET = 48 * 1024 * 1024;

/** How many measurements are kept. Each is a number; the bound is for the keys. */
export const MEASURE_LIMIT = 500;

const bodies = new Shelf<CardBody | null>(BODY_LIMIT, BODY_BUDGET);
const heights = new Shelf<number | null>(MEASURE_LIMIT, Number.POSITIVE_INFINITY);

/** A body from the shelf, or computed and — when it says it may be — kept. */
export function cachedBody(
  key: string,
  uuid: string,
  compute: () => Promise<Computed<CardBody | null>>
): Promise<CardBody | null> {
  return bodies.take(key, uuid, compute);
}

/** A measurement from the shelf, or measured and — when it completed — kept. */
export function cachedHeight(
  key: string,
  uuid: string,
  compute: () => Promise<Computed<number | null>>
): Promise<number | null> {
  return heights.take(key, uuid, compute);
}

/** What a string costs to keep: UTF-16, two bytes a code unit. */
export function stringBytes(...parts: string[]): number {
  return parts.reduce((sum, part) => sum + part.length * 2, 0);
}

/**
 * The key of a text body: the document shown, the field shown of it, the viewer's
 * ownership, and the raw content's hash.
 *
 * `uuid` is the SHOWN document's: a chosen page's own, or the journal's for a pin on a
 * whole journal. The raw content's hash is the guard under the invalidation: the text a
 * card is enriched from is cheap to read and hash, so an edit that reached no hook — a
 * sibling page's permission written by the module's own grant, which moves a whole
 * journal's first shown page — still misses here rather than serving the old words.
 */
export function bodyKey(parts: {
  uuid: string;
  field: string | null | undefined;
  isOwner: boolean;
  rawHash: string;
}): string {
  return [
    "text",
    parts.uuid,
    parts.field ?? "",
    parts.isOwner ? "owner" : "viewer",
    parts.rawHash,
  ].join("|");
}

/**
 * The key of a PDF body: the file, the page and the long edge it was drawn at. Not the
 * viewer — a PDF page has no secrets — but the shown document's uuid, so an edit to the
 * page that names the file forgets it.
 */
export function pdfKey(parts: { uuid: string; src: string; page: number; edge: number }): string {
  return ["pdf", parts.uuid, parts.src, parts.page, parts.edge].join("|");
}

/**
 * The key of a measurement: the body, and everything around the body that moves a line.
 *
 * The title last: it is the one free text here, so nothing after it can be confused with
 * it. Empty when the card does not show one, since the card then has no `<h1>` at all.
 */
export function measureKey(parts: {
  body: string;
  contentHash: string;
  paper: string;
  layout: string | undefined;
  font: string | null;
  fontPx: number;
  padPx: number;
  width: number;
  title: string;
}): string {
  return [
    parts.body,
    parts.contentHash,
    parts.paper,
    parts.layout ?? "",
    parts.font ?? "",
    parts.fontPx,
    parts.padPx,
    parts.width,
    parts.title,
  ].join("|");
}

/**
 * Whether an entry drawn from `kept` is about the document `edited`: the same one, one of
 * its parts, or the document it is part of.
 *
 * Both ways, and with the separator: a journal's ownership edit changes what its pages'
 * owners see, and a page's edit changes a whole journal's first page. `JournalEntry.ab` is
 * not part of `JournalEntry.a`, which a bare prefix would say it is.
 */
export function concerns(kept: string, edited: string): boolean {
  if (!kept || !edited) return false;
  return kept === edited || kept.startsWith(`${edited}.`) || edited.startsWith(`${kept}.`);
}

/**
 * Forget every body and measurement drawn from this document, its parts, or the document
 * it is part of. The source hooks call it for every edit, before they decide whether the
 * edit redraws anything: an actor's hit points draw nothing today, but its inline rolls
 * read them on the next resolve.
 */
export function forgetSource(uuid: string): void {
  if (typeof uuid !== "string" || !uuid) return;
  const matches = (kept: string) => concerns(kept, uuid);
  bodies.forget(matches);
  heights.forget(matches);
}

/** Forget everything: the canvas went away, or this user's role or permissions changed. */
export function clearResolved(): void {
  bodies.clear();
  heights.clear();
}

/** How full the shelves are. A test seam. */
export function cardCacheStats(): { bodies: number; bodyBytes: number; heights: number } {
  return { bodies: bodies.size, bodyBytes: bodies.bytes, heights: heights.size };
}
