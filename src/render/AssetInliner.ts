/**
 * Turning references into bytes.
 *
 * IMPURE. An SVG rendered as an image is an isolated document with NO network access:
 * an `<img src="worlds/keep/seal.webp">` inside a `foreignObject` does not load, it
 * silently draws nothing. Same for fonts. So everything a card refers to has to be
 * fetched here first and embedded as a `data:` URI.
 *
 * Three bounds, because this is where a module can quietly eat a gigabyte:
 *
 * - a per-asset cap, so one enormous map scrap cannot dominate a card
 * - a total cache cap, evicted least-recently-used
 * - one in-flight fetch per URL, shared by every caller, so eight props of the same
 *   journal fetch its illustration once
 *
 * A failed fetch is cached as a failure. Retrying on every re-render would turn one
 * missing file into a request storm against the user's own server.
 */

import { logger } from "../log";
import { cfg, g, ns, onIdle } from "../fvtt";
import { serialiseXml } from "./enrich";

const log = logger("assets");

/** 2 MB per asset: past this, a card is carrying a file, not an illustration. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
/** 8 MB total. Inlined bytes live in JS heap, not VRAM, and are cheap to re-fetch. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * A ceiling on ENTRIES as well as on bytes.
 *
 * A failed fetch is cached as a failure so a missing file is not re-requested per render,
 * and a failure entry weighs zero bytes — so the byte budget could never evict one, and a
 * world with a lot of broken image paths grew this map without bound for the whole
 * session.
 */
export const MAX_ENTRIES = 512;

interface Entry {
  dataUri: string | null;
  bytes: number;
  lastUsed: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string | null>>();
let totalBytes = 0;
let clock = 0;

/** Monotonic and local: `Date.now()` is not needed and ties break badly under it. */
function tick(): number {
  return ++clock;
}

function evictTo(limit: number): void {
  if (totalBytes <= limit && cache.size <= MAX_ENTRIES) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, entry] of entries) {
    if (totalBytes <= limit && cache.size <= MAX_ENTRIES) break;
    cache.delete(key);
    totalBytes -= entry.bytes;
  }
}

/**
 * Fetch a URL and return it as a `data:` URI, or `null` if it cannot be embedded.
 *
 * Already-inlined and remote-scheme URLs pass through untouched: a `data:` URI is
 * already embedded, and a cross-origin URL would fail CORS on the fetch and taint the
 * canvas even if it succeeded.
 */
export async function inlineAsset(url: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  // Cross-origin is refused rather than attempted: the fetch would fail CORS, and even
  // if it succeeded the result would taint the canvas it is drawn into.
  const origin = typeof location === "undefined" ? "" : location.origin;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !(origin && url.startsWith(origin))) return null;

  const cached = cache.get(url);
  if (cached) {
    cached.lastUsed = tick();
    return cached.dataUri;
  }
  const pending = inFlight.get(url);
  if (pending) return pending;

  const work = fetchAsDataUri(url).then((result) => {
    inFlight.delete(url);
    const bytes = result ? result.length : 0;
    cache.set(url, { dataUri: result, bytes, lastUsed: tick() });
    totalBytes += bytes;
    evictTo(MAX_TOTAL_BYTES);
    return result;
  });

  inFlight.set(url, work);
  return work;
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const blob = await response.blob();
    if (blob.size > MAX_ASSET_BYTES) {
      log.warn(`asset too large to inline (${blob.size} bytes): ${url}`);
      return null;
    }
    return await blobToDataUri(blob);
  } catch {
    // Cached as a failure by the caller: a missing file must not be retried per frame.
    return null;
  }
}

function blobToDataUri(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Rewrite every `<img src>` in a card fragment to an inlined copy.
 *
 * Images that cannot be inlined are REMOVED rather than left broken: inside the SVG
 * they would render as nothing anyway, and an `<img>` with no picture still takes up
 * its layout box and pushes the text that matters off the card.
 *
 * Serialised as XML, not as HTML, for the same reason `sanitise` is: this is the path
 * that GUARANTEES an `<img>` is present, and an unclosed one makes the SVG this string
 * ends up inside ill-formed, so the prop draws nothing at all.
 */
export async function inlineImages(html: string): Promise<string> {
  const Parser = (globalThis as any).DOMParser;
  if (!Parser) return html;

  const doc = new Parser().parseFromString(`<body>${html}</body>`, "text/html");
  const images = [...doc.body.querySelectorAll("img")] as HTMLImageElement[];
  if (!images.length) return serialiseXml(doc.body);

  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src");
      const inlined = src ? await inlineAsset(src) : null;
      if (inlined) img.setAttribute("src", inlined);
      else img.remove();
    })
  );

  return serialiseXml(doc.body);
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

let fontFaceCss: string | null = null;
let fontWarm: Promise<string> | null = null;

/**
 * Every font family this world defines, with the files behind it.
 *
 * Two sources, and the second is the one that was missed: core's `CONFIG.fontDefinitions`,
 * and the faces a GM added in Font Config, which live in core's own `fonts` setting and are
 * NOT merged into CONFIG (`FontConfig._collectDefinitions` reads both). A name both define
 * takes CONFIG's definition. The setting read is guarded: on a build where the setting is
 * not registered, `settings.get` throws, and the answer is simply CONFIG's list.
 */
function fontDefinitions(): Record<string, any> {
  const out: Record<string, any> = {};
  try {
    const FontConfig = ns("applications.settings.menus.FontConfig");
    const stored = g()?.settings?.get?.("core", FontConfig?.SETTING ?? "fonts");
    if (stored && typeof stored === "object") Object.assign(out, stored);
  } catch (error) {
    log.debug(`Font Config's own fonts could not be read`, error);
  }
  const config = cfg()?.fontDefinitions;
  if (config && typeof config === "object") Object.assign(out, config);
  return out;
}

/**
 * The family names a typeface picker may offer, before `typeface.fontChoices` filters them.
 *
 * Defined HERE, beside the inliner, so the canvas tier can draw whatever the picker lists:
 * both read `fontDefinitions`. `getAvailableFonts` — the faces that loaded with `editor:
 * true` — is folded in for a build that registers a face some other way.
 */
export function registeredFontFamilies(): string[] {
  const names = new Set(Object.keys(fontDefinitions()));
  try {
    const available = ns("applications.settings.menus.FontConfig")?.getAvailableFonts?.();
    if (Array.isArray(available)) {
      for (const name of available) if (typeof name === "string") names.add(name);
    }
  } catch (error) {
    log.debug(`the available fonts could not be listed`, error);
  }
  return [...names];
}

/**
 * `@font-face` rules with the font files inlined.
 *
 * Built once per session and reused by every card, because the same two or three faces
 * serve every prop and re-encoding them per rasterisation would dominate the cost of
 * drawing one. Every defined face is inlined, not only the ones in use: a journal page
 * can name a face through the editor as well as through a pin. A world that added fonts
 * pays for them once per session, on the canvas tier only.
 */
export async function inlineFonts(): Promise<string> {
  if (fontFaceCss !== null) return fontFaceCss;
  if (fontWarm) return fontWarm;

  fontWarm = buildFontCss().then((css) => {
    fontFaceCss = css;
    fontWarm = null;
    return css;
  });
  return fontWarm;
}

async function buildFontCss(): Promise<string> {
  const rules: string[] = [];
  for (const [family, definition] of Object.entries<any>(fontDefinitions())) {
    for (const face of definition?.fonts ?? []) {
      const urls: string[] = Array.isArray(face?.urls) ? face.urls : [];
      const inlined = (await Promise.all(urls.map(inlineAsset))).filter(Boolean) as string[];
      if (!inlined.length) continue;

      rules.push(
        `@font-face{font-family:"${family.replace(/["\\]/g, "")}";` +
          `font-weight:${Number(face.weight) || 400};` +
          `font-style:${face.style === "italic" ? "italic" : "normal"};` +
          `src:${inlined.map((u) => `url("${u}")`).join(",")};}`
      );
    }
  }
  return rules.join("");
}

/**
 * Start building the font CSS during idle time at `ready`.
 *
 * Without this the first prop a GM places pays for encoding every font face, which
 * lands as a visible pause at exactly the moment they are judging whether the module
 * feels fast.
 */
export function warmFontCache(): void {
  if (!g()) return;
  onIdle(() => void inlineFonts(), 3000);
}

export function clearInliner(): void {
  cache.clear();
  inFlight.clear();
  totalBytes = 0;
  fontFaceCss = null;
}
