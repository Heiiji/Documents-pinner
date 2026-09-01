/**
 * @vitest-environment jsdom
 *
 * The measurement probe is what "fit to content" and the overflow fade both rest on.
 * jsdom lays nothing out, so the probe's contract is asserted around a stubbed
 * `getBoundingClientRect`: it mounts at the width it was asked for, reads once, and
 * leaves nothing behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureCardHeight } from "../src/render/measure";

const CARD = '<div class="dp-card"><div class="dp-card__sheet">letter</div></div>';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
