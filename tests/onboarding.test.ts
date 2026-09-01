/**
 * @vitest-environment jsdom
 *
 * Once per client, GM only: a welcome the first time, a "what's new" when the version
 * has moved, never twice, never for a player.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareVersions, whatsNewFor } from "../src/ui/onboarding";
import { answerDialogs, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/apps/DocumentPicker", () => ({ openPicker: vi.fn() }));

import { openPicker } from "../src/apps/DocumentPicker";

describe("compareVersions", () => {
  it("orders numerically, component by component", () => {
    expect(compareVersions("0.2.0", "0.1.8")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
    expect(compareVersions("0.1.8", "0.2.0")).toBeLessThan(0);
  });
});

describe("whatsNewFor", () => {
  it("lists the minor versions above what was seen, up to the current one", () => {
    expect(whatsNewFor("0.1.8", "0.2.0").length).toBeGreaterThan(0);
    expect(whatsNewFor("0.2.0", "0.2.1")).toEqual([]);
    expect(whatsNewFor("0.2.0", "0.2.0")).toEqual([]);
  });
});

describe("onboardingReady", () => {
  let world: ReturnType<typeof installWorld>;
  let dialogs: number;

  function setUp(isGM: boolean, seen: string, version = "0.2.0") {
    world = installWorld({ isGM, settings: { seenVersion: seen } });
    world.game.modules.get = () => ({ version });
    dialogs = 0;
    const DialogV2 = (globalThis as any).foundry.applications.api.DialogV2;
    const confirm = DialogV2.confirm;
    DialogV2.confirm = async (...args: any[]) => {
      dialogs++;
      return confirm(...args);
    };
  }

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.mocked(openPicker).mockClear();
    uninstallWorld();
  });

  it("welcomes a GM once, and offers to place the first pin", async () => {
    setUp(true, "");
    answerDialogs(true);
    const { onboardingReady } = await import("../src/ui/onboarding");
    await onboardingReady();
    expect(dialogs).toBe(1);
    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(world.game.settings.get("documents-pinner", "seenVersion")).toBe("0.2.0");

    await onboardingReady();
    expect(dialogs).toBe(1);
  });

  it("says what is new when the version has moved, once", async () => {
    setUp(true, "0.1.8");
    const { onboardingReady } = await import("../src/ui/onboarding");
    await onboardingReady();
    expect(dialogs).toBe(1);
    expect(openPicker).not.toHaveBeenCalled();
    expect(world.game.settings.get("documents-pinner", "seenVersion")).toBe("0.2.0");

    await onboardingReady();
    expect(dialogs).toBe(1);
  });

  it("stays quiet for a patch release", async () => {
    setUp(true, "0.2.0", "0.2.1");
    const { onboardingReady } = await import("../src/ui/onboarding");
    await onboardingReady();
    expect(dialogs).toBe(0);
  });

  it("never speaks to a player", async () => {
    setUp(false, "");
    const { onboardingReady } = await import("../src/ui/onboarding");
    await onboardingReady();
    expect(dialogs).toBe(0);
  });
});
