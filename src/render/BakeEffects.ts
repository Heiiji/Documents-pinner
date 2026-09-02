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
export async function bakeEffects(
  canvas: HTMLCanvasElement,
  vars: CssVars,
  attrs: Record<string, string> = {}
): Promise<void> {
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
    // Grid under the sweep so the band lights it, and the marks over the sweep so the
    // geometry stays crisp. All three before the mask, which carves everything above it.
    hudGrid(ctx, canvas, vars, attrs, i);
    hudSweep(ctx, canvas, vars, i);
    hudMarks(ctx, canvas, vars, attrs, i);
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

/**
 * The projected overlay, in Canvas2D.
 *
 * A16's rule applied in A16's direction: find out what can be honoured first. All three
 * grids, all three mark styles and a STILL sweep are drawn primitives — no image decodes,
 * so nothing here can hit the decode timeout or taint the canvas (A17). Only the sweep's
 * TRAVEL is withheld, and the still band is not a fake of it: it is exactly the rendition
 * a reduced-motion client is given, because `baked` and `reduced` route through the same
 * `freeze()` in `EffectRegistry`.
 */
function hudStrength(vars: CssVars, i: number): number {
  return num(vars, "--dp-hud-op") * i;
}

function hudGrid(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vars: CssVars,
  attrs: Record<string, string>,
  i: number
): void {
  const style = attrs["data-dp-hud-grid"] ?? "none";
  const alpha = hudStrength(vars, i);
  const gap = num(vars, "--dp-hud-gap");
  const weight = num(vars, "--dp-hud-w");
  if (style === "none" || !(alpha > 0) || !(gap > 0) || !(weight > 0)) return;

  ctx.save();
  // 0.22, matching the stylesheet's own weighting for this layer. A grid you notice only
  // when it is gone.
  ctx.globalAlpha = alpha * 0.22;
  ctx.fillStyle = vars["--dp-hud"] ?? "#fff";

  if (style === "square" || style === "dot") {
    for (let x = 0; x < canvas.width; x += gap) {
      for (let y = 0; y < canvas.height; y += gap) {
        if (style === "dot") ctx.fillRect(x, y, weight, weight);
      }
      if (style === "square") ctx.fillRect(x, 0, weight, canvas.height);
    }
    if (style === "square") {
      for (let y = 0; y < canvas.height; y += gap) ctx.fillRect(0, y, canvas.width, weight);
    }
  } else if (style === "hatch") {
    // Rotated about the centre, over a band long enough that the corners are still
    // covered once the axes are turned.
    const reach = Math.hypot(canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(-Math.PI / 4);
    for (let y = -reach; y < reach; y += gap) ctx.fillRect(-reach, y, reach * 2, weight);
  }
  ctx.restore();
}

function hudMarks(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vars: CssVars,
  attrs: Record<string, string>,
  i: number
): void {
  const style = attrs["data-dp-hud-marks"] ?? "none";
  const alpha = hudStrength(vars, i);
  const weight = num(vars, "--dp-hud-w");
  // From the emitted variable rather than recomputed, so this and the stylesheet cannot
  // disagree about the ratio between a hairline and the arm it draws.
  const arm = num(vars, "--dp-hud-arm");
  if (style === "none" || !(alpha > 0) || !(weight > 0)) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = vars["--dp-hud"] ?? "#fff";

  if (style === "brackets") {
    for (const [x, y, sx, sy] of [
      [0, 0, 1, 1],
      [w, 0, -1, 1],
      [0, h, 1, -1],
      [w, h, -1, -1],
    ]) {
      ctx.fillRect(sx > 0 ? x : x - arm, sy > 0 ? y : y - weight, arm, weight);
      ctx.fillRect(sx > 0 ? x : x - weight, sy > 0 ? y : y - arm, weight, arm);
    }
  } else if (style === "corners") {
    const side = weight * 3;
    for (const [x, y] of [
      [0, 0],
      [w - side, 0],
      [0, h - side],
      [w - side, h - side],
    ]) {
      ctx.fillRect(x, y, side, side);
    }
  } else if (style === "callout") {
    ctx.fillRect(0, 0, arm, weight);
    ctx.fillRect(0, 0, weight, arm);
    ctx.fillRect(arm + 6, 0, w * 0.38, weight);
    ctx.fillRect(w * 0.42, 0, weight * 3, weight * 3);
  }
  ctx.restore();
}

/** The band of light, at rest — centred, exactly where the frozen CSS leaves it. */
function hudSweep(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vars: CssVars,
  i: number
): void {
  const alpha = hudStrength(vars, i);
  const colour = vars["--dp-hud"];
  if (!(alpha > 0) || !colour || !vars["--dp-hud-sweep-dur"]) return;
  if (vars["--dp-hud-sweep-dur"] === "0s" && !vars["--dp-hud-clear"]) return;

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, vars["--dp-hud-clear"] ?? "#0000");
  gradient.addColorStop(0.5, colour);
  gradient.addColorStop(1, vars["--dp-hud-clear"] ?? "#0000");

  ctx.save();
  ctx.globalAlpha = alpha * 0.45;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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
