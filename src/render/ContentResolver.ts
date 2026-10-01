/**
 * From a pin to a card.
 *
 * IMPURE. Resolves the source, pulls out whatever text or image it holds, enriches it
 * FOR THIS CLIENT'S USER, and returns the finished card markup plus everything the
 * cache needs to key on.
 *
 * What a source's card holds is its adapter's to say (`sources/index.ts`): a journal page
 * can be text, an image, a PDF or a video, and each needs a different card — but every one
 * of them goes through the same single enrichment call site here, so the security
 * properties hold regardless of which adapter or branch it came from.
 *
 * A source that no longer exists produces a PLACEHOLDER card, never an exception and
 * never an empty one. The anchor outlives its source on purpose: deleting a pin because
 * its journal was deleted would be destructive and unrecoverable, and a blank rectangle
 * on the map is indistinguishable from a rendering bug.
 *
 * A card is three layers, and only the outer one depends on the LOD rung and the effects
 * level (DESIGN A29): the BODY — the words, enriched for this user, or a PDF page drawn —
 * and its MEASURED height are kept in `card-cache.ts`, and the SHELL — the dressing, the
 * metrics and `cardHtml` — is built on every call. So a rung change, a focus or a level
 * flip costs a string, and the reader, the placement ghost and the canvas tier share
 * whatever the DOM tier already enriched. The cache sits below this function on purpose:
 * the suite mocks this module with partial factories in eight files, and every caller's
 * contract — this signature, this result — is unchanged.
 */

import { g, isGM } from "../fvtt";
import { t } from "../i18n";
import { escapeHtml } from "../html";
import { cardHtml, type CardOptions } from "./CardTemplate";
import { dressing } from "../effects/EffectRegistry";
import { currentLevel } from "../effects/level";
import { findPreset } from "../effects/preset-library";
import type { LodTier } from "../canvas/lod";
import { enrichFor, sanitise } from "./enrich";
import { renderPdfPage } from "./PdfPage";
import { hashContent } from "./TextureCache";
import { measureCard } from "./measure";
import {
  bodyKey,
  cachedBody,
  cachedHeight,
  measureKey,
  pdfKey,
  referencedUuids,
  stringBytes,
  type CardBody,
} from "./card-cache";
import { cardMetrics } from "../data/pin-schema";
import { adapterForDoc, canOpenShown, type SourceAdapter } from "../sources/index";
import { pdfPageOf } from "../sources/describe";
import { packLockedHere } from "../sources/packs";
import { isPackUuid, parseSourceUuid } from "../sources/uuid";
import { labelFor, resolveSource } from "../sources/view";
import type { DpPinFlags } from "../types/dp";

export interface ResolvedCard {
  html: string;
  title: string;
  /** Whether this user could open the source at all, for the reader tier. */
  readable: boolean;
  /** Changes whenever the rendered content would change. Part of the cache key. */
  contentHash: string;
  missing: boolean;
  /**
   * Why a placeholder is one: the document is gone, it is in a compendium this client's
   * role cannot read, or it is a world actor or item this player's client does not hold.
   * Absent on a card that drew its source.
   */
  reason?: Reason;
  /**
   * The height at which the whole content fits at this width, type size and margin —
   * what "fit to content" writes — or `null` when it cannot be measured.
   */
  naturalHeight: number | null;
}

type Reason = "missing" | "packLocked" | "unavailable";

export interface ResolveOptions {
  /** Which rung this is being drawn for. Decides the effect's strength. */
  tier?: LodTier;
  /** Whether the result is going into a texture, which cannot animate. */
  baked?: boolean;
}

/** Build the card for a pin, as this client's user would see it. */
export async function resolveCard(
  pin: DpPinFlags,
  size: { width: number; height: number },
  options: ResolveOptions = {}
): Promise<ResolvedCard> {
  // The library, not just the shipped ones. A lookup in CORE_PRESETS alone gave a pin
  // assigned a user preset no effect at all, a raw id where its label should be, and no
  // reveal animation — the entire Preset Studio produced artefacts the module could not
  // use, while the README promised "author, export and share your own".
  const preset = findPreset(pin.effect.id);
  const dressed = preset
    ? dressing({
        preset,
        intensity: pin.effect.intensity,
        seed: pin.effect.seed,
        tier: options.tier ?? "L2b",
        level: currentLevel(),
        baked: options.baked ?? false,
        // The pin's own motion, which nothing used to read.
        speed: pin.effect.speed,
        motion: pin.effect.motion === "none" ? "none" : "loop",
      })
    : null;

  // The box decides how much shows; the metrics decide how large the words are.
  const { fontPx, padPx } = cardMetrics(pin.display, size);
  // The pin's own face wins, then the preset's. Read from the preset rather than from the
  // dressing, which is empty at `off` and at the silhouette rung (DESIGN A26).
  const font = pin.display.font ?? preset?.params.type.family ?? null;
  const common = {
    showTitle: pin.display.showTitle,
    paper: pin.display.paper,
    fontPx,
    padPx,
    effectId: pin.effect.id,
    effectStyle: dressed?.style,
    effectAttrs: dressed?.attrs,
    font,
  };

  if (pin.source.kind === "image") {
    const src = pin.source.src ?? "";
    const title = labelFor(pin);
    return {
      html: cardHtml({
        ...common,
        title,
        bodyHtml: src ? `<img src="${escapeHtml(src)}" alt="">` : "",
        showTitle: pin.display.showTitle && !!pin.display.label,
      }),
      title,
      readable: true,
      contentHash: hashContent(`image|${src}`),
      missing: !src,
      // An unloaded <img> measures 0, which is "unknown" rather than a height.
      naturalHeight: null,
    };
  }

  // Never a blank and never a request the server will refuse: a player whose role cannot
  // read the pack gets a placeholder that says so, and no load is attempted (DESIGN A27).
  if (packLockedHere(pin.source.uuid)) return placeholder(common, "packLocked");
  const source = await resolveSource(pin);
  if (!source) return placeholder(common, unresolved(pin));

  // Dispatched on the document's TYPE first. A journal page's `type` says text, image or
  // PDF; an Actor's or an Item's is a system subtype (`npc`, `weapon`), which read as a
  // page type would fall to the default branch and draw nothing.
  const adapter = adapterForDoc(source);
  // The SHOWN document: a chosen page, else the named document. What the body is keyed
  // on, and what an edit's hook forgets.
  const uuid: string = source.uuid ?? pin.source.uuid ?? "";
  const title = pin.display.label || source.name || "";

  // A PDF is drawn, not enriched: pdf.js paints the page and the card carries the image.
  // This is also the one source type that can reach the canvas tier — see `PdfPage.ts`.
  const pdfSrc = adapter.pdf(source);
  if (pdfSrc) {
    const page = await pdfBody(uuid, pdfSrc, pdfPageOf(pin), pdfEdge(size, options.tier));
    if (page?.page) {
      return {
        html: cardHtml({
          ...common,
          title,
          bodyHtml: page.html,
          showTitle: pin.display.showTitle && !!pin.display.label,
        }),
        title,
        readable: readableBy(source),
        contentHash: page.contentHash,
        missing: false,
        // The page's own aspect is the answer; it is contained, so it never overflows.
        naturalHeight:
          Math.max(1, size.width - 2 * padPx) * (page.page.height / page.page.width) + 2 * padPx,
      };
    }
  }

  const { key, body } = await textBody(uuid, source, adapter, pin);
  const layout = adapter.layout === "portrait" ? ("portrait" as const) : undefined;

  // Measured at the width it will be drawn at, then marked if the box is too short.
  // The mark is a function of the size, and the size is in every cache key already, so
  // the content hash does not carry it.
  const build = (overflow: boolean) =>
    cardHtml({
      ...common,
      title,
      bodyHtml: body.html,
      overflow,
      figureHtml: body.figureHtml,
      layout,
    });
  const naturalHeight = await cachedHeight(
    measureKey({
      body: key,
      contentHash: body.contentHash,
      paper: pin.display.paper,
      layout,
      font,
      fontPx,
      padPx,
      width: size.width,
      title: pin.display.showTitle ? title : "",
    }),
    uuid,
    async () => {
      // Measured UNDRESSED: nothing a preset sets moves a line (see `card-cache.ts`), and
      // a probe with no dressing runs no animation and is the same card at every rung —
      // which is what lets one measurement serve them all.
      const { height, complete } = await measureCard(
        cardHtml({
          ...common,
          effectStyle: undefined,
          effectAttrs: undefined,
          title,
          bodyHtml: body.html,
          figureHtml: body.figureHtml,
          layout,
        }),
        size.width
      );
      return { value: height, keep: complete && height !== null };
    }
  );
  const overflow = naturalHeight !== null && naturalHeight > size.height + 1;

  return {
    html: build(overflow),
    title,
    readable: readableBy(source),
    contentHash: body.contentHash,
    missing: false,
    naturalHeight,
  };
}

/**
 * Whether this user could open the source, read on every call and never kept: the
 * module's own grant changes it, and the source hooks ignore the module's own writes.
 */
function readableBy(source: any): boolean {
  return canOpenShown(source, g()?.user);
}

/**
 * The long edge a PDF page is drawn at, for a card of this size at this rung.
 *
 * Once the card's size at the two coarse rungs, twice it above them. The silhouette rung
 * is the smallest a card is ever drawn, and it was drawn at twice its size with the full
 * rungs. Snapped UP to a power of two, so a resize that stays inside one draws nothing new:
 * pdf.js renders a page once per edge (`PdfPage.ts`), and the card cache keeps its data URL
 * per edge too. Past 4096 the exact edge is kept, as it always was: snapping a page that
 * large up could allocate four times the pixels it asked for.
 */
function pdfEdge(size: { width: number; height: number }, tier: LodTier | undefined): number {
  const scale = tier === "L2a" || tier === "L1" ? 1 : 2;
  const wanted = Math.max(1, Math.round(Math.max(size.width, size.height) * scale));
  if (wanted > PDF_SNAP_LIMIT) return wanted;
  return 2 ** Math.ceil(Math.log2(wanted));
}

const PDF_SNAP_LIMIT = 4096;

/**
 * A PDF page's body: its `<img>`, a data URL of the page pdf.js drew. `toDataURL` encodes
 * the whole canvas as a PNG, synchronously on the main thread, into a string of
 * megabytes — and it ran on every resolve; now once per (file, page, edge). A page that
 * could not be drawn is not kept, and the card falls through to the text that says it is
 * a PDF.
 */
function pdfBody(uuid: string, src: string, page: number, edge: number): Promise<CardBody | null> {
  return cachedBody(pdfKey({ uuid, src, page, edge }), uuid, async () => {
    const rendered = await renderPdfPage(src, page, edge);
    if (!rendered) return { value: null, keep: false };
    const html = `<img class="dp-card__page" src="${escapeHtml(rendered.canvas.toDataURL("image/png"))}" alt="">`;
    return {
      value: {
        html,
        figureHtml: "",
        kind: "pdf",
        isOwner: false,
        contentHash: hashContent(`pdf|${src}|${page}|${rendered.width}x${rendered.height}`),
        page: { width: rendered.width, height: rendered.height },
      },
      keep: true,
      bytes: stringBytes(html),
    };
  });
}

/**
 * The text body: the adapter's raw content, enriched for this user and scrubbed, with its
 * portrait. Keyed by the shown document, the field shown, the viewer's ownership — which
 * decides the secrets — and the raw content's hash (`bodyKey`).
 */
async function textBody(
  uuid: string,
  source: any,
  adapter: SourceAdapter,
  pin: DpPinFlags
): Promise<{ key: string; body: CardBody }> {
  const { text, kind, figure } = adapter.rawContent(source, pin);
  const isOwner = source?.isOwner === true;
  const key = bodyKey({
    uuid,
    field: pin.source.field,
    isOwner,
    rawHash: hashContent(`${kind}|${figure ?? ""}|${text ?? ""}`),
  });
  const body = await cachedBody(key, uuid, async () => {
    const enriched = await enrichFor(source, text);
    // The portrait is ours, built here from a path and escaped, then scrubbed exactly as an
    // image page's own <img> is — a `javascript:` path comes out with no `src` at all. Its
    // box is sized by the stylesheet, so the card measures right before the picture decodes.
    const figureHtml = figure
      ? sanitise(
          `<figure class="dp-card__portrait"><img src="${escapeHtml(figure)}" alt=""></figure>`,
          true
        )
      : "";
    const { html } = enriched;
    return {
      value: {
        html,
        figureHtml,
        kind,
        isOwner: enriched.isOwner,
        // `isOwner` is in the hash because it changes what the HTML contains: a GM and a
        // player must never share a cache entry, and this is the second guard on that
        // after the user id already in the key.
        contentHash: hashContent(
          `${kind}|${enriched.isOwner}|${html}${figureHtml ? `|${figureHtml}` : ""}`
        ),
      },
      // The raw text, scrubbed, is safe to show once and wrong to keep.
      keep: !enriched.fellBack && !!uuid,
      bytes: stringBytes(key, html, figureHtml),
      refs: referencedUuids(html),
    };
  });
  // A text body is never null; the type is the shelf's, which a PDF shares.
  return { key, body: body! };
}

/**
 * Why a document source this client could not find draws a placeholder.
 *
 * "No longer exists" is the truth for the GM, whose client holds every world document. A
 * player's client may not be sent a world actor or item it has no permission to see at all
 * (unmeasured, A28's probe D1), and actor access starts off (A28): telling that player the
 * wanted man was deleted, when he is in the GM's sidebar, is a lie. They are told it is not
 * available to them instead.
 */
function unresolved(pin: DpPinFlags): Reason {
  if (isGM() || isPackUuid(pin.source.uuid)) return "missing";
  const name = parseSourceUuid(pin.source.uuid)?.documentName;
  return name === "Actor" || name === "Item" ? "unavailable" : "missing";
}

const PLACEHOLDER_TITLE: Record<Reason, string> = {
  missing: "DP.card.missing",
  packLocked: "DP.card.packLocked",
  unavailable: "DP.card.unavailable",
};

function placeholder(
  common: Omit<CardOptions, "title" | "bodyHtml">,
  reason: Reason
): ResolvedCard {
  const title = t(PLACEHOLDER_TITLE[reason]);
  return {
    html: cardHtml({ ...common, title, bodyHtml: "", missing: true, showTitle: false }),
    title,
    readable: false,
    contentHash: hashContent(reason),
    missing: true,
    reason,
    naturalHeight: null,
  };
}
