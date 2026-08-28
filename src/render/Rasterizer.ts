/**
 * HTML to texture.
 *
 * IMPURE, and the one genuinely novel piece of the module: enriched HTML wrapped in an
 * SVG `foreignObject`, decoded as an image, drawn to an `OffscreenCanvas`, uploaded as
 * a `PIXI.Texture` and bound to the Tile's own mesh in `canvas.primary` — where it is
 * darkened by scene darkness, lit by torches, masked by fog and occluded by roofs, all
 * for free, because it is genuinely part of the scene rather than floating over it.
 *
 * The pipeline has three silent failure modes, and each is handled explicitly because
 * every one of them looks identical from the outside — a prop that never appears:
 *
 * 1. **WebKit taints the canvas** for any SVG containing a `foreignObject`. Both the
 *    pixel readback and the WebGL upload then throw. Probed once at `ready` and, when
 *    it fails, the whole client falls back to DOM rendering rather than showing
 *    nothing.
 * 2. **Chrome renders nothing without explicit width/height** on both the `<svg>` and
 *    the `<foreignObject>` — see `CardTemplate.svgDocument`.
 * 3. **A layout that produced no pixels** decodes and draws perfectly and is simply
 *    transparent, so the probe counts painted pixels rather than trusting that no
 *    exception means success.
 *
 * Mipmaps are mandatory, not an optimisation: they are what makes the far LOD tier
 * look like a small letter instead of an aliased mess, and the positive mip bias is
 * what gives the out-of-focus preset its blur for free in the fragment shader.
 */

import { MODULE_ID, RES_TIERS } from "../const";
import { logger } from "../log";
import { rendererResolution } from "../fvtt";

const log = logger("render");

export interface RasterResult {
  texture: any;
  width: number;
  height: number;
  /** Bytes of VRAM this texture occupies, for the budget. RGBA8, plus mip levels. */
  bytes: number;
}

/** Whether this client can rasterise at all. `null` until probed. */
let canRasterise: boolean | null = null;
let cardCss: string | null = null;

/**
 * Consecutive failures, and the point at which we stop trying.
 *
 * The error text is not a reliable signal. WebKit says "The operation is insecure",
 * but an ill-formed SVG, a missing 2d context and a decode that never resolves all
 * report something else entirely — and the failure that actually shipped reported none
 * of the three. So the latch counts failures instead of reading them: if this many
 * different cards in a row cannot be drawn, the problem is the client, not the cards.
 */
export const FAILURE_LATCH = 5;
let consecutiveFailures = 0;

/**
 * Probe the pipeline once, on this client.
 *
 * Draws a tiny card and counts painted pixels. Cached, because the answer is a property
 * of the browser and cannot change within a session.
 *
 * **This currently fails in Chromium too, and that is not a bug in the probe.** An SVG
 * image containing a `foreignObject` taints the canvas it is drawn into — in Chromium as
 * well as in WebKit — so the readback throws `SecurityError`, and so does the WebGL
 * upload the real pipeline depends on (`texImage2D: Tainted canvases may not be loaded`).
 * Verified in a live v14 world on Chromium 144: a plain SVG uploads fine, the same SVG
 * with a `foreignObject` does not, and `createImageBitmap` cannot decode an SVG blob at
 * all. There is no workaround along this path.
 *
 * A2 assumed this was a WebKit quirk. It is not: it is what every current browser does,
 * and it means the canvas tier described in DESIGN §6 cannot work as designed anywhere.
 * The DOM tier is therefore the tier that actually runs. See amendment A10.
 */
export async function probeRasterisation(): Promise<boolean> {
  if (canRasterise !== null) return canRasterise;

  try {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">` +
      `<foreignObject x="0" y="0" width="8" height="8">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:8px;height:8px;background:#fff">` +
      `</div></foreignObject></svg>`;

    const image = await decodeSvg(svg);
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);

    // Reading back is not part of the real pipeline, but it fails in exactly the same
    // circumstances the WebGL upload does, and it fails cheaply.
    const pixels = context.getImageData(0, 0, 8, 8).data;
    let painted = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
    canRasterise = painted > 0;
  } catch (error) {
    log.warn(`canvas rendering unavailable, using DOM:`, error);
    canRasterise = false;
  }

  return canRasterise;
}

export function rasterisationAvailable(): boolean | null {
  return canRasterise;
}

/** Force the answer. Used by the setting and by tests. */
export function setRasterisationAvailable(value: boolean | null): void {
  canRasterise = value;
  consecutiveFailures = 0;
}

/** For the Pinboard's diagnostics and for tests. */
export function rasterisationFailures(): number {
  return consecutiveFailures;
}

/**
 * The card stylesheet, fetched once and inlined verbatim into every SVG.
 *
 * Fetched rather than duplicated in JS so the reader tier and the canvas tier are
 * literally the same bytes and cannot drift apart.
 */
export async function loadCardCss(): Promise<string> {
  if (cardCss !== null) return cardCss;
  try {
    const response = await fetch(`modules/${MODULE_ID}/styles/card.css`);
    cardCss = response.ok ? await response.text() : "";
  } catch {
    cardCss = "";
  }
  return cardCss;
}

/**
 * Snap a requested pixel size up to a power-of-two tier.
 *
 * Tiers rather than exact sizes so a slow zoom cannot thrash: without them, every few
 * pixels of scale change would allocate and upload a new texture, and a GM scrolling
 * the wheel would generate dozens.
 */
export function tierFor(pixels: number): number {
  for (const tier of RES_TIERS) if (pixels <= tier) return tier;
  return RES_TIERS[RES_TIERS.length - 1];
}

/**
 * The memory a rasterised texture actually costs, on BOTH sides of the bus.
 *
 * `PIXI.Texture.from(canvas)` keeps the `OffscreenCanvas` alive as the base texture's
 * resource, so every prop carries its RGBA8 backing store in system memory for as long as
 * the texture exists — roughly doubling the real cost of a prop. Counting only the GPU
 * side made a 2048² prop look like ~22 MB when the true figure is closer to 38 MB, and at
 * the 256 MB default the real footprint was approaching half a gigabyte.
 *
 * The honest number is counted here rather than the retention being removed, because
 * releasing the canvas means handing PIXI an `ImageBitmap` instead, and that could not be
 * verified against a live v14 renderer in this pass. The budget therefore now means what
 * a user reads it as — total memory, not just VRAM. See DESIGN A9.
 */
export function textureBytes(width: number, height: number): number {
  const pixels = width * height;
  // GPU: RGBA8 plus the mip chain's extra third. CPU: the canvas backing store, no mips.
  return Math.round(pixels * 4 * 1.34 + pixels * 4);
}

function decodeSvg(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image();
  image.src = url;

  return image
    .decode()
    .then(() => image)
    .finally(() => URL.revokeObjectURL(url));
}

/**
 * Rasterise a complete SVG document into a texture.
 *
 * The long edge is what gets snapped to a tier, so a tall letter and a wide handbill
 * both get the same texel density rather than the tall one being starved.
 */
export async function rasterise(
  svg: string,
  width: number,
  height: number,
  longEdgePixels: number
): Promise<RasterResult | null> {
  if (canRasterise === false) return null;

  const PIXI = (globalThis as any).PIXI;
  if (!PIXI) return null;

  const tier = tierFor(longEdgePixels);
  const scale = tier / Math.max(width, height);
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));

  try {
    const image = await decodeSvg(svg);
    const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
    const context = canvas.getContext("2d");
    if (!context) return null;

    context.drawImage(image, 0, 0, pixelWidth, pixelHeight);

    const texture = PIXI.Texture.from(canvas, {
      // The RENDERER's resolution, not the display's: Foundry runs its renderer at a
      // ratio the user controls, and sizing from devicePixelRatio would allocate four
      // times the VRAM for pixels Foundry never puts on screen.
      resolution: rendererResolution(),
      mipmap: PIXI.MIPMAP_MODES?.ON,
      scaleMode: PIXI.SCALE_MODES?.LINEAR,
    });

    consecutiveFailures = 0;
    return {
      texture,
      width: pixelWidth,
      height: pixelHeight,
      bytes: textureBytes(pixelWidth, pixelHeight),
    };
  } catch (error) {
    log.warn(`rasterisation failed:`, error);
    // One failure is a bad card; a run of them means the client cannot rasterise, and
    // the run is counted rather than read out of the error text — see FAILURE_LATCH.
    consecutiveFailures += 1;
    if (
      consecutiveFailures >= FAILURE_LATCH ||
      String(error).includes("insecure") ||
      String(error).includes("Tainted")
    ) {
      canRasterise = false;
      log.warn(`canvas rendering disabled after repeated failures`);
    }
    return null;
  }
}

/**
 * A texture from a canvas that is ALREADY drawn.
 *
 * The PDF path uses this: pdf.js paints with Canvas2D rather than through an SVG
 * `foreignObject`, so its canvas is origin-clean and uploads fine — which is why a pinned
 * PDF can reach the canvas tier when a journal page cannot. See `render/PdfPage.ts` and
 * DESIGN A11.
 *
 * Deliberately does NOT touch `canRasterise`: that latch is about the HTML pipeline, and a
 * client that cannot draw HTML can still draw PDFs perfectly well.
 */
export function textureFromCanvas(source: any, width: number, height: number): RasterResult | null {
  const PIXI = (globalThis as any).PIXI;
  if (!PIXI || !source) return null;

  try {
    const texture = PIXI.Texture.from(source, {
      resolution: rendererResolution(),
      mipmap: PIXI.MIPMAP_MODES?.ON,
      scaleMode: PIXI.SCALE_MODES?.LINEAR,
    });
    return { texture, width, height, bytes: textureBytes(width, height) };
  } catch (error) {
    log.warn("could not upload a pre-drawn canvas", error);
    return null;
  }
}

/**
 * Release a texture and the GPU memory behind it.
 *
 * `destroy(true)` destroys the base texture as well. Without it, `PIXI.Texture.from`
 * keeps caching by the source canvas's internal id and the memory is never freed —
 * which shows up as VRAM climbing steadily across a session with no obvious cause.
 */
export function releaseTexture(texture: any): void {
  try {
    texture?.destroy?.(true);
  } catch {
    /* already gone */
  }
}
