/**
 * @vitest-environment jsdom
 *
 * The measurement probe is what "fit to content" and the overflow fade both rest on.
 * jsdom lays nothing out, so the probe's contract is asserted around a stubbed
 * `getBoundingClientRect`: it mounts at the width it was asked for, reads once, and
 * leaves nothing behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEASURE_DEADLINE_MS, measureCard, measureCardHeight } from "../src/render/measure";

const CARD = '<div class="dp-card"><div class="dp-card__sheet">letter</div></div>';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as any).fonts;
  document.getElementById("dp-measure")?.remove();
});

describe("measureCardHeight", () => {
  it("returns null where there is no document", async () => {
    vi.stubGlobal("document", undefined);
    expect(await measureCardHeight(CARD, 400)).toBeNull();
  });

  it("mounts the card at the requested width and removes it afterwards", async () => {
    let widthSeen: string | null = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      widthSeen = (this.closest("#dp-measure > div") as HTMLElement | null)?.style.width ?? null;
      return { height: 812 } as DOMRect;
    });

    expect(await measureCardHeight(CARD, 400)).toBe(812);
    expect(widthSeen).toBe("400px");
    expect(document.getElementById("dp-measure")?.children.length).toBe(0);
  });

  it("keeps the probe hidden and out of the way", async () => {
    await measureCardHeight(CARD, 400);
    const probe = document.getElementById("dp-measure")!;
    expect(probe.style.visibility).toBe("hidden");
    expect(probe.style.pointerEvents).toBe("none");
    expect(probe.getAttribute("aria-hidden")).toBe("true");
  });

  it("treats a zero height as unknown, not as empty", async () => {
    expect(await measureCardHeight(CARD, 400)).toBeNull();
  });
});

/**
 * A picture without a size of its own lays out at 0 px until it has decoded, so a page of
 * handout pictures measured as a page of captions, and "fit to content" cut them off. And
 * a journal's `loading="lazy"` picture, in a probe parked far off screen, never loaded.
 */
describe("measureCard and the card's pictures", () => {
  const PICTURED =
    '<div class="dp-card"><div class="dp-card__sheet">' +
    '<img src="worlds/keep/map.webp" loading="lazy" alt=""><p>letter</p></div></div>';

  /** jsdom has no `decode`; the browser's, as each test needs it to answer. */
  const decodes = (impl: (this: HTMLImageElement) => Promise<void>) => {
    (HTMLImageElement.prototype as any).decode = impl;
  };
  afterEach(() => {
    delete (HTMLImageElement.prototype as any).decode;
  });

  it("waits for each picture to decode, made eager, before it reads", async () => {
    const order: string[] = [];
    let decoded = () => {};
    decodes(function () {
      order.push(`decode ${this.getAttribute("loading")}`);
      return new Promise<void>((resolve) => (decoded = resolve));
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
      order.push("read");
      return { height: 900 } as DOMRect;
    });

    const measuring = measureCard(PICTURED, 400);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["decode eager"]);

    decoded();
    expect(await measuring).toEqual({ height: 900, complete: true });
    expect(order).toEqual(["decode eager", "read"]);
  });

  it("still measures past a picture that cannot be decoded, and says so", async () => {
    decodes(() => Promise.reject(new DOMException("broken", "EncodingError")));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 300,
    } as DOMRect);

    expect(await measureCard(PICTURED, 400)).toEqual({ height: 300, complete: false });
  });

  it("gives a face and a picture that never arrive ONE deadline between them, not one each", async () => {
    vi.useFakeTimers();
    (document as any).fonts = { load: () => new Promise(() => {}), ready: new Promise(() => {}) };
    decodes(() => new Promise(() => {}));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 512,
    } as DOMRect);

    let result: unknown;
    void measureCard(PICTURED, 400).then((measured) => (result = measured));
    await vi.advanceTimersByTimeAsync(MEASURE_DEADLINE_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ height: 512, complete: false });
  });

  it("calls a card with nothing to wait for complete", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 200,
    } as DOMRect);
    expect(await measureCard(CARD, 400)).toEqual({ height: 200, complete: true });
  });
});
