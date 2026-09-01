/**
 * From a pin to a card.
 *
 * IMPURE. Resolves the source, pulls out whatever text or image it holds, enriches it
 * FOR THIS CLIENT'S USER, and returns the finished card markup plus everything the
 * cache needs to key on.
 *
 * The only place that knows how the different page types differ. A journal page can be
 * text, an image, a PDF or a video, and each needs a different card — but every one of
 * them goes through the same single enrichment call site, so the security properties
 * hold regardless of which branch was taken.
 *
 * A source that no longer exists produces a PLACEHOLDER card, never an exception and
 * never an empty one. The anchor outlives its source on purpose: deleting a pin because
 * its journal was deleted would be destructive and unrecoverable, and a blank rectangle
 * on the map is indistinguishable from a rendering bug.
 */

import { g } from "../fvtt";
import { t } from "../i18n";
import { escapeHtml } from "../html";
import * as api from "../api";
import { cardHtml } from "./CardTemplate";
import { dressing } from "../effects/EffectRegistry";
import { currentLevel } from "../effects/level";
import { findPreset } from "../effects/preset-library";
import type { LodTier } from "../canvas/lod";
import { enrichFor } from "./enrich";
import { pdfSourceOf, renderPdfPage } from "./PdfPage";
import { hashContent } from "./TextureCache";
import { cardMetrics } from "../data/pin-schema";
import type { DpPinFlags } from "../types/dp";

export interface ResolvedCard {
  html: string;
  title: string;
  /** Whether this user could open the source at all, for the reader tier. */
  readable: boolean;
  /** Changes whenever the rendered content would change. Part of the cache key. */
  contentHash: string;
  missing: boolean;
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
      const first = source.pages?.contents?.[0];
      return first ? rawContentOf(first) : { text: "", kind: "empty" };
    }
    default:
      return { text: source.text?.content ?? "", kind: type };
  }
}

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
  // The library, not just the shipped ten. `getCorePreset` searches CORE_PRESETS only,
  // so a pin assigned a user preset got no effect at all, a raw id where its label should
  // be, and no reveal animation — the entire Preset Studio produced artefacts the module
  // could not use, while the README promised "author, export and share your own".
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
  const common = {
    showTitle: pin.display.showTitle,
    paper: pin.display.paper,
    fontPx,
    padPx,
    effectId: pin.effect.id,
    effectStyle: dressed?.style,
    effectAttrs: dressed?.attrs,
  };

  if (pin.source.kind === "image") {
    const src = pin.source.src ?? "";
    const title = api.labelFor(pin);
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
    };
  }

  const source = await api.resolveSource(pin);
  if (!source) return placeholder(common);

  // A PDF is drawn, not enriched: pdf.js paints the page and the card carries the image.
  // This is also the one source type that can reach the canvas tier — see `PdfPage.ts`.
  const pdfSrc = pdfSourceOf(source);
  if (pdfSrc) {
    const longEdge = Math.max(size.width, size.height) * (options.tier === "L2a" ? 1 : 2);
    const rendered = await renderPdfPage(pdfSrc, pageOf(pin), Math.round(longEdge));
    if (rendered) {
      const title = pin.display.label || source.name || "";
      return {
        html: cardHtml({
          ...common,
          title,
          bodyHtml: `<img class="dp-card__page" src="${escapeHtml(rendered.canvas.toDataURL("image/png"))}" alt="">`,
          showTitle: pin.display.showTitle && !!pin.display.label,
        }),
        title,
        readable: source.testUserPermission?.(g()?.user, "OBSERVER") === true,
        contentHash: hashContent(
          `pdf|${pdfSrc}|${pageOf(pin)}|${rendered.width}x${rendered.height}`
        ),
        missing: false,
      };
    }
  }

  const { text, kind } = rawContentOf(source);
  const { html, isOwner } = await enrichFor(source, text);
  const title = pin.display.label || source.name || "";

  return {
    html: cardHtml({ ...common, title, bodyHtml: html }),
    title,
    readable: source.testUserPermission?.(g()?.user, "OBSERVER") === true,
    // `isOwner` is in the hash because it changes what the HTML contains: a GM and a
    // player must never share a cache entry, and this is the second guard on that
    // after the user id already in the key.
    contentHash: hashContent(`${kind}|${isOwner}|${html}`),
    missing: false,
  };
}

/** Which page of a multi-page PDF this pin shows. One-based, as pdf.js counts. */
function pageOf(pin: DpPinFlags): number {
  const raw = Number(pin.source.pageId);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

function placeholder(common: any): ResolvedCard {
  const title = t("DP.card.missing");
  return {
    html: cardHtml({ ...common, title, bodyHtml: "", missing: true, showTitle: false }),
    title,
    readable: false,
    contentHash: hashContent("missing"),
    missing: true,
  };
}
