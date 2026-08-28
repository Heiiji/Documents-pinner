/**
 * The one content type that can reach the canvas tier.
 *
 * DESIGN A10 established that HTML cannot: rendering it means an SVG `foreignObject`, that
 * taints the canvas in every current browser, and a tainted canvas is refused by
 * `texImage2D`. pdf.js paints with ordinary Canvas2D calls instead, so its output stays
 * origin-clean. Measured on a live v14.365 server against a real 32-page document:
 *
 *     pdf.js -> canvas -> getImageData   clean, 561697 painted pixels
 *     pdf.js -> canvas -> texImage2D     OK
 *     that texture bound to a prop's mesh  drew the page on the map
 *
 * The measurement needs a browser; what these tests pin is the contract that made it work.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";
import {
  clearPdfCache,
  pdfPageCount,
  pdfSourceOf,
  renderPdfPage,
  setPdfLibrary,
} from "../src/render/PdfPage";

const renders: Record<string, any>[] = [];
let opened = 0;

/** A pdf.js shaped closely enough to hold the contract, and no more. */
function fakePdfJs(numPages = 32) {
  return {
    GlobalWorkerOptions: {} as Record<string, unknown>,
    getDocument: (url: string) => {
      opened++;
      return {
        promise: Promise.resolve({
          numPages,
          getPage: async (n: number) => ({
            getViewport: ({ scale }: { scale: number }) => ({
              width: 600 * scale,
              height: 850 * scale,
            }),
            render: (options: Record<string, unknown>) => {
              renders.push({ ...options, url, page: n });
              return { promise: Promise.resolve() };
            },
          }),
        }),
      };
    },
  };
}

let realGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  renders.length = 0;
  opened = 0;
  installWorld({});
  // jsdom ships no 2D context, and pdf.js only ever hands it back to itself — what this
  // file is testing is the shape of the call, not the pixels, which the browser proved.
  realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  (globalThis as any).foundry.utils.getRoute = (p: string) => `/${p}`;
  setPdfLibrary(fakePdfJs());
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  setPdfLibrary(null);
  clearPdfCache();
  uninstallWorld();
});

describe("pdfSourceOf", () => {
  it("recognises a PDF page and nothing else", () => {
    expect(pdfSourceOf({ type: "pdf", src: "pdf/manual.pdf" })).toBe("pdf/manual.pdf");
    expect(pdfSourceOf({ type: "text", src: "pdf/manual.pdf" })).toBeNull();
    expect(pdfSourceOf({ type: "pdf", src: "" })).toBeNull();
    expect(pdfSourceOf(null)).toBeNull();
  });
});

describe("renderPdfPage", () => {
  it("renders with the PRINT intent, not display", async () => {
    // A display render drives itself through `requestAnimationFrame`, which never fires
    // while the document is hidden — a Foundry window behind another app would hang
    // mid-render forever. Observed: the display path stalled and never resolved.
    await renderPdfPage("pdf/manual.pdf", 1, 1024);
    expect(renders).toHaveLength(1);
    expect(renders[0].intent).toBe("print");
  });

  it("sizes the page so its LONG edge hits the requested tier", async () => {
    const out = await renderPdfPage("pdf/manual.pdf", 1, 1700);
    // The fake page is 600x850, so the long edge is the height.
    expect(out!.height).toBe(1700);
    expect(out!.width).toBe(1200);
  });

  it("clamps the page number into the document", async () => {
    await renderPdfPage("pdf/manual.pdf", 99, 512);
    expect(renders[0].page).toBe(32);
    renders.length = 0;
    await renderPdfPage("pdf/manual.pdf", 0, 256);
    expect(renders[0].page).toBe(1);
  });

  it("renders once per file, page and size, because a LOD change asks again", async () => {
    await renderPdfPage("pdf/manual.pdf", 1, 512);
    await renderPdfPage("pdf/manual.pdf", 1, 512);
    expect(renders).toHaveLength(1);

    await renderPdfPage("pdf/manual.pdf", 1, 1024);
    expect(renders).toHaveLength(2);
  });

  it("parses a document once however many props reference it", async () => {
    await Promise.all([
      renderPdfPage("pdf/manual.pdf", 1, 512),
      renderPdfPage("pdf/manual.pdf", 2, 512),
      renderPdfPage("pdf/manual.pdf", 3, 512),
    ]);
    expect(opened).toBe(1);
  });

  it("returns null rather than throwing when there is no pdf.js", async () => {
    setPdfLibrary(undefined);
    expect(await renderPdfPage("pdf/manual.pdf", 1, 512)).toBeNull();
  });

  it("returns null for an empty source", async () => {
    expect(await renderPdfPage("", 1, 512)).toBeNull();
  });

  it("reports the page count", async () => {
    expect(await pdfPageCount("pdf/manual.pdf")).toBe(32);
  });
});
