/**
 * @vitest-environment jsdom
 *
 * The hooks `main.ts` registers for actors and items, called as core calls them (A9).
 *
 * A handler that only a test calls directly is a feature nobody can reach: so each test
 * here imports `main.ts` with a recording `Hooks.on` and calls the handler it recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeActor,
  fakeItem,
  installSources,
  installWorld,
  uninstallWorld,
} from "./helpers/fake-foundry";

vi.mock("../src/apps/PlacementGhost", () => ({
  arm: vi.fn(() => true),
  armAt: vi.fn(() => true),
  disarm: vi.fn(),
}));

import { armAt } from "../src/apps/PlacementGhost";

let world: ReturnType<typeof installWorld>;
const registered = new Map<string, ((...args: any[]) => unknown)[]>();

/** The world, then `main.ts`, with every handler it registers recorded by name. */
async function boot(options: { isGM?: boolean; tiles?: any[]; actors?: any[] } = {}) {
  world = installWorld({ isGM: options.isGM ?? true, tiles: options.tiles ?? [] });
  installSources(world, { actors: options.actors ?? [] });
  registered.clear();
  (globalThis as any).Hooks.on = (name: string, fn: (...args: any[]) => unknown) =>
    registered.set(name, [...(registered.get(name) ?? []), fn]);
  await import("../src/main");
}

const fire = (name: string, ...args: unknown[]) => {
  for (const handler of registered.get(name) ?? []) handler(...args);
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(armAt).mockClear();
  document.body.innerHTML = '<div id="board"></div>';
});
afterEach(() => uninstallWorld());

describe("an actor's or an item's sheet header", () => {
  const jack = () => fakeActor({ id: "jack", name: "Black Jack" });

  it.each([
    ["a GM, on an actor's sheet", true, () => jack(), "Actor.jack"],
    [
      "a GM, on an item's sheet",
      true,
      () => fakeItem({ id: "amulet", name: "Amulet" }),
      "Item.amulet",
    ],
    ["a player, on an actor's sheet", false, () => jack(), null],
    [
      "a GM, on the sheet of an item an actor owns",
      true,
      () => fakeItem({ id: "knife", name: "Knife", parent: jack() }),
      null,
    ],
  ])("offers Pin to scene to %s", async (_who, isGM, doc, armed) => {
    await boot({ isGM });
    const controls: any[] = [];

    fire("getHeaderControlsApplicationV2", { document: doc() }, controls);
    controls[0]?.onClick();

    expect(controls).toHaveLength(armed ? 1 : 0);
    expect(vi.mocked(armAt).mock.calls.map((call) => call[0].uuid)).toEqual(armed ? [armed] : []);
  });
});
