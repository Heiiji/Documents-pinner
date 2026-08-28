/**
 * A PDF page, drawn.
 *
 * IMPURE. Foundry ships pdf.js — `scripts/pdfjs/build/pdf.mjs`, confirmed present on a
 * live v14.365 server — and this is the one content type that can reach the canvas tier.
 *
 * **Why PDFs are special, and it is not a small thing.** DESIGN A10 established that the
 * canvas tier cannot work for journal HTML: rendering HTML means an SVG `foreignObject`,
 * that taints the canvas in every current browser, and a tainted canvas is refused by
 * `texImage2D`. pdf.js does not use `foreignObject` at all — it paints with ordinary
 * Canvas2D calls — so its output canvas stays origin-clean. Measured in a live world:
 *
 *     pdf.js -> canvas -> getImageData   clean, 561697 painted pixels
 *     pdf.js -> canvas -> texImage2D     OK
 *     the same texture bound to a prop's mesh   drew the page on the map
 *
 * So a pinned PDF is genuinely lit by torches, hidden by fog, occluded by roofs and sorted
 * behind tokens — the thing §6 was written for, reachable for exactly one source type.
 *
 * Two bounds, because a PDF is the heaviest thing this module will ever draw:
 *
 * - **One render per (file, page, size tier)**, cached, because a LOD change asks again.
 * - **One in-flight load per file**, shared, so eight props of the same document parse it
 *   once. Parsing a 32-page PDF is not cheap and the result is immutable.
 */

import { logger } from "../log";

const log = logger("pdf");

/** Where Foundry keeps pdf.js. Derived once; a build that moved it degrades to no PDFs. */
const PDFJS_LIB = "scripts/pdfjs/build/pdf.mjs";
const PDFJS_WORKER = "scripts/pdfjs/build/pdf.worker.mjs";

let libPromise: Promise<any> | null = null;
const documents = new Map<string, Promise<any>>();
const pages = new Map<string, Promise<HTMLCanvasElement | null>>();

/** Foundry's own route helper, so a server under a subpath still resolves. */
function route(path: string): string {
  const helper = (globalThis as any).foundry?.utils?.getRoute;
  return typeof helper === "function" ? helper(path) : `/${path.replace(/^\/+/, "")}`;
}

/**
 * Inject the pdf.js module, for tests.
 *
 * The real one is fetched by URL from Foundry's own `scripts/` directory, which no test
 * environment can resolve — so the seam is explicit rather than mocked at the import,
 * which keeps the caching, the tiering and the print intent testable.
 */
export function setPdfLibrary(library: unknown): void {
  libPromise = library === null ? null : Promise.resolve(library);
  documents.clear();
  pages.clear();
}

async function library(): Promise<any> {
  if (libPromise) return libPromise;

  libPromise = (async () => {
    try {
      const pdfjs = await import(/* @vite-ignore */ route(PDFJS_LIB));
      if (pdfjs?.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = route(PDFJS_WORKER);
      return pdfjs;
    } catch (error) {
      log.warn("pdf.js is not available on this server; PDFs will not be drawn", error);
      return null;
    }
  })();
  return libPromise;
}

function documentFor(src: string): Promise<any> {
  const existing = documents.get(src);
  if (existing) return existing;

  const loading = (async () => {
    const pdfjs = await library();
    if (!pdfjs?.getDocument) return null;
    try {
      return await pdfjs.getDocument(route(src)).promise;
    } catch (error) {
      log.warn(`could not open ${src}`, error);
      return null;
    }
  })();

  documents.set(src, loading);
  return loading;
}

export interface PdfRender {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Render one page to a canvas whose long edge is about `longEdge` pixels.
 *
 * `intent: "print"` is deliberate and load-bearing. pdf.js drives a `"display"` render
 * through `requestAnimationFrame`, which never fires while the document is hidden — so a
 * client whose Foundry window is behind another would hang mid-render forever. The print
 * intent renders synchronously on promises instead, and produces the same pixels.
 */
export async function renderPdfPage(
  src: string,
  pageNumber: number,
  longEdge: number
): Promise<PdfRender | null> {
  if (!src) return null;

  const key = `${src}|${pageNumber}|${longEdge}`;
  const cached = pages.get(key);
  if (cached) {
    const canvas = await cached;
    return canvas ? { canvas, width: canvas.width, height: canvas.height } : null;
  }

  const work = (async (): Promise<HTMLCanvasElement | null> => {
    const doc = await documentFor(src);
    if (!doc) return null;

    try {
      const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
      const base = page.getViewport({ scale: 1 });
      const scale = longEdge / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale: Math.max(0.05, scale) });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));

      const context = canvas.getContext("2d");
      if (!context) return null;

      await page.render({ canvasContext: context, viewport, intent: "print" }).promise;
      log.debug(`rendered ${src} p${pageNumber} at ${canvas.width}x${canvas.height}`);
      return canvas;
    } catch (error) {
      log.warn(`could not render ${src} page ${pageNumber}`, error);
      return null;
    }
  })();

  pages.set(key, work);
  const canvas = await work;
  return canvas ? { canvas, width: canvas.width, height: canvas.height } : null;
}

/** How many pages a document has, for a pin that wants to say so. */
export async function pdfPageCount(src: string): Promise<number> {
  const doc = await documentFor(src);
  return doc?.numPages ?? 0;
}

/** Whether a resolved source is a PDF page this module can draw. */
export function pdfSourceOf(source: any): string | null {
  if (source?.type !== "pdf") return null;
  const src = source?.src;
  return typeof src === "string" && src ? src : null;
}

/** Drop everything. Called when the module tears down. */
export function clearPdfCache(): void {
  documents.clear();
  pages.clear();
}
