/**
 * Procedural surface textures.
 *
 * PURE: builds `data:` URIs from parameters. No files, no fetches, no binary assets in
 * the repository at all.
 *
 * Three reasons this beats shipping image files:
 *
 * 1. **It works inside the rasteriser.** An SVG rendered as an image cannot fetch
 *    anything, so a `url()` to a real file draws nothing there while working fine in
 *    the DOM reader — the two tiers would silently disagree about what a prop looks
 *    like. A `data:` URI is already embedded and behaves identically in both.
 * 2. **It scales with the prop.** A 512px paper scan tiled across a 2048px prop shows
 *    its repeat; a generated pattern is sized to the card it is drawn on.
 * 3. **It is parameterised.** Grain coarseness follows `noise.scale` and strength
 *    follows `noise.amount`, so the same generator serves parchment, vellum and a
 *    bloodstain rather than needing three files.
 *
 * `feTurbulence` is used STATICALLY and only statically. Animating its `baseFrequency`
 * or `seed` forces a full CPU-side filter re-evaluation every frame and is banned
 * outright in `DESIGN.md` §6.2 — here it is evaluated once, when the browser decodes
 * the data URI, and never again.
 */

/**
 * Percent-encode an SVG for a `data:` URI that is safe inside a CSS `url()`.
 *
 * Spaces and quotes are encoded, not just the markup characters: the result ends up
 * inside `url('…')` in a `style` attribute, and an unencoded space there terminates
 * the URL token while a quote terminates the attribute. `%` goes first, or the escapes
 * introduced afterwards would be escaped again.
 */
function encodeSvg(svg: string): string {
  return svg
    .replace(/\s+/g, " ")
    .replace(/%/g, "%25")
    .replace(/"/g, "%22")
    .replace(/'/g, "%27")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/ /g, "%20");
}

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeSvg(svg)}`;
}

/** A number safe to interpolate into SVG markup. */
function n(value: number, min: number, max: number, fallback: number): number {
  const v = Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(max, Math.max(min, v)) * 10000) / 10000;
}

/**
 * Fibre grain: the flecks and unevenness that make paper read as paper.
 *
 * `fractalNoise` rather than `turbulence`, because turbulence's absolute value gives
 * hard dark veins that read as damage; fractal noise gives the soft variation of a
 * real sheet.
 */
export function grainDataUri(
  options: { scale?: number; opacity?: number; seed?: number } = {}
): string {
  const frequency = n(0.65 / (options.scale ?? 1), 0.02, 4, 0.65);
  const opacity = n(options.opacity ?? 0.5, 0, 1, 0.5);
  const seed = Math.floor(n(options.seed ?? 1, 0, 9999, 1));

  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">` +
      `<filter id="g" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="4" seed="${seed}"/>` +
      `<feColorMatrix type="saturate" values="0"/>` +
      `</filter>` +
      `<rect width="180" height="180" filter="url(#g)" opacity="${opacity}"/>` +
      `</svg>`
  );
}

/**
 * A blotch field, for stains: fewer, larger, softer marks than grain.
 *
 * A low octave count and a low frequency give big smooth regions, and the contrast
 * matrix pushes most of the field to transparent so what survives reads as a handful
 * of separate marks rather than an overall wash.
 */
export function stainDataUri(
  options: { scale?: number; opacity?: number; seed?: number; color?: string } = {}
): string {
  const frequency = n(0.012 / (options.scale ?? 1), 0.002, 0.2, 0.012);
  const opacity = n(options.opacity ?? 0.6, 0, 1, 0.6);
  const seed = Math.floor(n(options.seed ?? 7, 0, 9999, 7));
  const color = /^#[0-9a-f]{3,8}$/i.test(options.color ?? "") ? options.color! : "#6b1c12";

  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
      `<filter id="s" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="3" seed="${seed}"/>` +
      // Steep transfer: keep the top of the range, drop everything else to nothing, so
      // the result is a few marks rather than an even tint over the whole card.
      `<feComponentTransfer><feFuncA type="gamma" exponent="6" amplitude="2.4" offset="-0.9"/></feComponentTransfer>` +
      `</filter>` +
      `<rect width="400" height="400" fill="${color}" filter="url(#s)" opacity="${opacity}"/>` +
      `</svg>`
  );
}

export type EdgeStyle = "none" | "torn" | "burnt" | "deckled" | "singed";

/**
 * An alpha mask that eats the card's edge.
 *
 * Returned as a mask image rather than a border so it can carve real irregularity out
 * of the silhouette — a torn letter has to be torn at its OUTLINE, and no amount of
 * border styling produces that.
 *
 * Each style is the same displacement applied at a different frequency and amplitude,
 * which is what actually distinguishes them physically: a tear is coarse and deep, a
 * deckled edge is fine and shallow, a burn is coarse with a soft falloff.
 */
export function edgeMaskDataUri(style: EdgeStyle, amount: number, seed = 3): string {
  if (style === "none" || amount <= 0) return "none";

  const strength = n(amount, 0, 1, 0.5);
  const profile = {
    torn: { frequency: 0.03, scale: 26, blur: 0 },
    burnt: { frequency: 0.02, scale: 30, blur: 3 },
    deckled: { frequency: 0.09, scale: 10, blur: 0.6 },
    singed: { frequency: 0.05, scale: 16, blur: 1.6 },
  }[style];

  const displacement = n(profile.scale * strength, 0, 60, 10);
  const blur = n(profile.blur * strength, 0, 8, 0);
  const inset = Math.ceil(displacement / 2) + 2;

  return `url('${dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400" preserveAspectRatio="none">` +
      `<filter id="e" x="-20%" y="-20%" width="140%" height="140%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${profile.frequency}" numOctaves="3" seed="${Math.floor(seed) % 9999}" result="n"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="${displacement}" xChannelSelector="R" yChannelSelector="G"/>` +
      (blur > 0 ? `<feGaussianBlur stdDeviation="${blur}"/>` : "") +
      `</filter>` +
      `<rect x="${inset}" y="${inset}" width="${400 - inset * 2}" height="${400 - inset * 2}" fill="white" filter="url(#e)"/>` +
      `</svg>`
  )}')`;
}

/**
 * Static scanlines, as a repeating gradient rather than an image.
 *
 * A gradient because the browser can rasterise it at any density without resampling,
 * where a 2px-pitch image at a card's true resolution would alias into moiré.
 */
export function scanlineGradient(spacing: number, opacity: number): string {
  const gap = n(spacing, 1, 64, 3);
  const alpha = n(opacity, 0, 1, 0);
  if (alpha <= 0) return "none";
  return (
    `repeating-linear-gradient(to bottom,` +
    ` rgb(0 0 0 / ${alpha}) 0 ${gap / 2}px,` +
    ` transparent ${gap / 2}px ${gap}px)`
  );
}
