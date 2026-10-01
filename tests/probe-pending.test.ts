/**
 * @vitest-environment jsdom
 *
 * Before the rasterisation probe answers (DESIGN A29).
 *
 * Core awaits the canvas before `ready` (foundry.mjs 14.368 ~206405-206421), so the first
 * LOD pass always runs while `rasterisationAvailable()` is still `null`. Read as "canvas is
 * fine", that pass queued every text prop for a rasterisation the probe — which decodes
 * from a `blob:` URL and so answers `false` on every supported browser — was about to
 * forbid. And `ready` encoded every font face as a data URI for that same dormant path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeJournal, installSources, installWorld, uninstallWorld } from "./helpers/fake-foundry";
import type { DpPinFlags } from "../src/types/dp";

vi.mock("../src/render/AssetInliner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/render/AssetInliner")>()),
  warmFontCache: vi.fn(),
}));

vi.mock("../src/render/Rasterizer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/render/Rasterizer")>()),
  probeRasterisation: vi.fn(async () => false),
}));

// What `ready` also starts, and none of this file's business.
vi.mock("../src/data/ownership-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/ownership-sync")>()),
  reconcile: vi.fn(async () => 0),
}));
vi.mock("../src/ui/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/onboarding")>()),
  onboardingReady: vi.fn(async () => {}),
}));

const pinOn = (uuid: string): DpPinFlags => ({
  ...defaultPin(),
  mode: "prop",
  source: { ...defaultPin().source, uuid },
});

beforeEach(() => vi.resetModules());
afterEach(() => uninstallWorld());

describe("the DOM policy while the probe has not answered", () => {
  function world() {
    const installed = installWorld({ isGM: true });
    const letters = fakeJournal({
      id: "letters",
      name: "Letters",
      pages: [
        { id: "note", name: "Note" },
        { id: "deed", name: "Deed", type: "pdf" },
      ],
    });
    letters.pages.get("deed").src = "deed.pdf";
    installSources(installed, { journals: [letters] });
  }

  it("draws a text prop as a DOM card, not as a texture nobody will make", async () => {
    world();
    const { setRasterisationAvailable } = await import("../src/render/Rasterizer");
    const { drawsAsDom } = await import("../src/canvas/PropManager");

    setRasterisationAvailable(null);
    expect(drawsAsDom(pinOn("JournalEntry.letters.JournalEntryPage.note"))).toBe(true);
  });

  it("still sends a PDF page to the canvas, which does not depend on the probe", async () => {
    world();
    const { setRasterisationAvailable } = await import("../src/render/Rasterizer");
    const { drawsAsDom } = await import("../src/canvas/PropManager");

    setRasterisationAvailable(null);
    expect(drawsAsDom(pinOn("JournalEntry.letters.JournalEntryPage.deed"))).toBe(false);
  });

  it("moves a text prop to the canvas only once the probe answers true", async () => {
    world();
    const { setRasterisationAvailable } = await import("../src/render/Rasterizer");
    const { drawsAsDom } = await import("../src/canvas/PropManager");
    const text = pinOn("JournalEntry.letters.JournalEntryPage.note");

    setRasterisationAvailable(true);
    expect(drawsAsDom(text)).toBe(false);
    setRasterisationAvailable(false);
    expect(drawsAsDom(text)).toBe(true);
  });
});

describe("the font warm-up at ready", () => {
  /** `main.ts` booted, with its `ready` handler recorded and then run. */
  async function ready(canRasterise: boolean) {
    installWorld({ isGM: true });
    const once = new Map<string, () => unknown>();
    (globalThis as any).Hooks.once = (name: string, fn: () => unknown) => once.set(name, fn);
    const { probeRasterisation } = await import("../src/render/Rasterizer");
    vi.mocked(probeRasterisation).mockResolvedValue(canRasterise);
    const { warmFontCache } = await import("../src/render/AssetInliner");
    vi.mocked(warmFontCache).mockClear();

    await import("../src/main");
    once.get("ready")?.();
    // The probe's answer, then its `.then`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return vi.mocked(warmFontCache);
  }

  it("encodes no font for a client whose probe says the canvas path cannot run", async () => {
    expect(await ready(false)).not.toHaveBeenCalled();
  });

  it("warms the fonts once the probe says it can", async () => {
    expect(await ready(true)).toHaveBeenCalledTimes(1);
  });
});
