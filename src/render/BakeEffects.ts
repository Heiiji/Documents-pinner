/**
 * Effects painted onto a canvas, with Canvas2D.
 *
 * IMPURE. A12 gave PDFs the canvas tier and, without noticing, took their effects away:
 * a PDF is painted straight into a texture by pdf.js, so it has no `.dp-card` and none of
 * the CSS in `fx/effects.css` applies to it. A15 disabled those controls rather than leave
 * them lying. This file is the other half of that answer — the effects come back, painted
 * rather than styled.
 *
 * **Why this is safe when the HTML path is not.** A10's finding was about `foreignObject`
 * specifically, and there is none here: the tint is a `fillRect`, the grain and stains are
 * plain `feTurbulence` SVGs drawn with `drawImage`, and a plain SVG image was measured
 * uploading to WebGL without complaint. Nothing in this file taints anything.
 *
 * **What is deliberately NOT here.** Everything that moves. A texture cannot animate, so
 * flicker, jitter, chromatic drift, warp and the scanline roll have no static rendition
 * worth faking — which is exactly the distinction `dressing({ baked: true })` already
 * draws, and why this takes its input from there rather than inventing a second policy.
 */

import type { CssVars } from "../effects/preset-css";
import { logger } from "../log";

const log = logger("bake");

/** Decoded once per data URI: the same grain serves every prop that shares a seed. */
const images = new Map<string, Promise<HTMLImageElement | null>>();

/**
 * How long to wait for a generated texture before drawing without it.
 *
 * Not paranoia. An `Image` that neither loads nor errors leaves its promise pending
 * forever, and this is awaited inside the concurrency-1 generation queue — so one
 * undecodable stain would stop every prop on the scene from ever drawing, with nothing
 * anywhere to say why. A missing layer is a cosmetic loss; a stuck queue is not.
 */
const DECODE_TIMEOUT_MS = 2000;

function decode(url: string): Promise<HTMLImageElement | null> {
  const existing = images.get(url);
  if (existing) return existing;

  const work = new Promise<HTMLImageElement | null>((resolve) => {
    let settled = false;
    const done = (value: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };

    const timer = window.setTimeout(() => {
      log.warn(`a generated texture did not decode in ${DECODE_TIMEOUT_MS}ms; drawing without it`);
      done(null);
    }, DECODE_TIMEOUT_MS);

    const image = new Image();
    image.onload = () => done(image);
    image.onerror = () => done(null);
    image.src = url;
  });

  images.set(url, work);
  return work;
}

/** `url("…")` or `url('…')` as CSS writes it, or `none`. */
function urlOf(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^\s*url\(\s*["']?(.*?)["']?\s*\)\s*$/.exec(value);
  return match ? match[1] : null;
}

function num(vars: CssVars, key: string, fallback = 0): number {
  const raw = Number.parseFloat(vars[key] ?? "");
  return Number.isFinite(raw) ? raw : fallback;
}

/** The multiplier every intensity-scaled value is already expressed against. */
function intensity(vars: CssVars): number {
  return Math.min(1, Math.max(0, num(vars, "--dp-i", 1)));
}

const BLEND: Record<string, GlobalCompositeOperation> = {
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  normal: "source-over",
};

/**
 * Paint a preset's static rendition onto a canvas, in place.
 *
 * The canvas is assumed to be the caller's own copy: this mutates it, and the pdf.js page
 * cache must not be written through. Every step is individually guarded — a preset that
 * cannot supply one layer still gets the others, because a prop with no stains is a much
 * better outcome than a prop that failed to draw.
 */
export async function bakeEffects(canvas: HTMLCanvasElement, vars: CssVars): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const i = intensity(vars);
  if (i <= 0) return;

  try {
    await blur(canvas, ctx, num(vars, "--dp-blur") * i);

    tint(ctx, canvas, vars, i);
    await layer(ctx, canvas, urlOf(vars["--dp-surface-img"]), num(vars, "--dp-surface-op") * i);
    await layer(ctx, canvas, urlOf(vars["--dp-grain-img"]), num(vars, "--dp-noise") * i, true);
    scanlines(ctx, canvas, vars, i);
    frame(ctx, canvas, vars);
    await edgeMask(ctx, canvas, urlOf(vars["--dp-edge-mask"]));
  } catch (error) {
    log.warn("could not bake an effect layer; the page is drawn without it", error);
  }
}

/** Out of Focus, and anything else that softens. Needs a round trip through a copy. */
async function blur(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  radius: number
): Promise<void> {
  if (!(radius > 0.1) || typeof ctx.filter !== "string") return;

  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext("2d")?.drawImage(canvas, 0, 0);

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(copy, 0, 0);
  ctx.restore();
}

function tint(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vars: CssVars,
  i: number
): void {
  const amount = num(vars, "--dp-tint-amt") * i;
  const colour = vars["--dp-tint"];
  if (!(amount > 0) || !colour || colour === "transparent") return;

  ctx.save();
  ctx.globalCompositeOperation = BLEND[vars["--dp-tint-blend"] ?? "multiply"] ?? "multiply";
  ctx.globalAlpha = Math.min(1, amount);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** Stains stretch to the page; grain tiles at its own scale, as the CSS does. */
async function layer(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  url: string | null,
  alpha: number,
  tile = false
): Promise<void> {
  if (!url || !(alpha > 0)) return;

  const image = await decode(url);
  if (!image) return;

  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.globalCompositeOperation = "multiply";
  if (tile) {
    const pattern = ctx.createPattern(image, "repeat");
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  } else {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

/**
 * Scanlines, drawn rather than decoded.
 *
 * `--dp-scan-img` is a CSS `repeating-linear-gradient`, which is not an image and cannot
 * be handed to `drawImage` — so the same lines are stroked directly. Static only: the roll
 * is motion, and a texture has none.
 */
function scanlines(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vars: CssVars,
  i: number
): void {
  const opacity = num(vars, "--dp-scan-op") * i;
  const gap = Math.max(1, num(vars, "--dp-scan-gap", 3));
  if (!(opacity > 0)) return;

  ctx.save();
  ctx.globalAlpha = Math.min(1, opacity);
  ctx.fillStyle = "#000";
  for (let y = 0; y < canvas.height; y += gap * 2) ctx.fillRect(0, y, canvas.width, gap);
  ctx.restore();
}

function frame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, vars: CssVars): void {
  const width = num(vars, "--dp-frame-w");
  const colour = vars["--dp-frame"];
  if (!(width > 0) || !colour || colour === "transparent") return;

  const radius = Math.max(0, num(vars, "--dp-frame-r"));
  const inset = width / 2;

  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(inset, inset, canvas.width - width, canvas.height - width, radius);
  } else {
    ctx.rect(inset, inset, canvas.width - width, canvas.height - width);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * The torn or burnt silhouette.
 *
 * Last, and `destination-in`: the mask carves the alpha of everything painted before it,
 * which is the only way an irregular outline can be produced — a border cannot make one.
 */
async function edgeMask(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  url: string | null
): Promise<void> {
  if (!url) return;

  const image = await decode(url);
  if (!image) return;

  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** A copy of a canvas, so a cached page is never painted over. */
export function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")?.drawImage(source, 0, 0);
  return copy;
}

export function clearBakeCache(): void {
  images.clear();
}
