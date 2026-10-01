/**
 * @vitest-environment jsdom
 *
 * A user's change, through the hooks `main.ts` registers (A9).
 *
 * `userConnected` and `updateUser` both ran `refreshAllPins(); syncHitLayer();
 * refreshPinboard();` on every client for any user's change, and `updateUser` fires
 * whenever any module writes any user's flags. Rebuilding the hit areas clears the hover
 * (`PropHitLayer.sync`), so a player's tooltip vanished under the pointer whenever someone
 * else's client stored a preference. Each surface now follows only what it reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/canvas/PinnedTile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/canvas/PinnedTile")>()),
  refreshAllPins: vi.fn(),
}));
vi.mock("../src/canvas/PropHitLayer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/canvas/PropHitLayer")>()),
  syncHitLayer: vi.fn(),
}));
vi.mock("../src/apps/Pinboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/apps/Pinboard")>()),
  refreshPinboard: vi.fn(),
}));
vi.mock("../src/apps/PinHUD", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/apps/PinHUD")>()),
  refreshPinHUD: vi.fn(),
}));
vi.mock("../src/render/card-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/render/card-cache")>()),
  clearResolved: vi.fn(),
}));

import { refreshAllPins } from "../src/canvas/PinnedTile";
import { syncHitLayer } from "../src/canvas/PropHitLayer";
import { refreshPinboard } from "../src/apps/Pinboard";
import { refreshPinHUD } from "../src/apps/PinHUD";
import { clearResolved } from "../src/render/card-cache";

let world: ReturnType<typeof installWorld>;
const registered = new Map<string, ((...args: any[]) => unknown)[]>();

/** The world as `ali`, a player, then `main.ts`, with every handler it registers recorded. */
async function boot() {
  world = installWorld({ isGM: false });
  registered.clear();
  (globalThis as any).Hooks.on = (name: string, fn: (...args: any[]) => unknown) =>
    registered.set(name, [...(registered.get(name) ?? []), fn]);
  await import("../src/main");
  for (const fn of [refreshAllPins, syncHitLayer, refreshPinboard, refreshPinHUD, clearResolved]) {
    vi.mocked(fn).mockClear();
  }
}

const fire = (name: string, ...args: unknown[]) => {
  for (const handler of registered.get(name) ?? []) handler(...args);
};

/** Which surfaces a hook reached. */
const reached = () => ({
  hits: vi.mocked(syncHitLayer).mock.calls.length,
  cards: vi.mocked(clearResolved).mock.calls.length,
  pins: vi.mocked(refreshAllPins).mock.calls.length,
  hud: vi.mocked(refreshPinHUD).mock.calls.length,
  board: vi.mocked(refreshPinboard).mock.calls.length,
});

const ali = () => world.game.users.get("ali");
const ben = () => world.game.users.get("ben");

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
});
afterEach(() => uninstallWorld());

describe("updateUser", () => {
  it("leaves this player's hover alone when another user's flags are written", async () => {
    await boot();
    fire("updateUser", ben(), { flags: { "some-module": { theme: "dark" } } }, {}, "ben");
    expect(reached()).toEqual({ hits: 0, cards: 0, pins: 0, hud: 0, board: 1 });
  });

  it("rebuilds this user's hit areas for their own change, and keeps their cards", async () => {
    await boot();
    fire("updateUser", ali(), { color: "#ff0000" }, {}, "ali");
    expect(reached()).toEqual({ hits: 1, cards: 0, pins: 0, hud: 0, board: 1 });
  });

  it("knows this user by `isSelf` as well as by id", async () => {
    await boot();
    fire("updateUser", { id: "elsewhere", isSelf: true }, { flags: {} }, {}, "gm");
    expect(reached().hits).toBe(1);
  });

  it("forgets this user's cards and redraws every pin and the HUD when their role changes", async () => {
    await boot();
    fire("updateUser", ali(), { role: 2 }, {}, "gm");
    expect(reached()).toEqual({ hits: 1, cards: 1, pins: 1, hud: 1, board: 1 });
    // The HUD bound to whichever anchor it shows, not one named here.
    expect(vi.mocked(refreshPinHUD).mock.calls[0][0]).toBeNull();
  });

  it("forgets this user's cards when their permissions change, and redraws no pin", async () => {
    await boot();
    fire("updateUser", ali(), { permissions: { FILES_BROWSE: true } }, {}, "gm");
    expect(reached()).toEqual({ hits: 1, cards: 1, pins: 0, hud: 0, board: 1 });
  });

  it("redraws the pins and the HUD when another user's role changes, which moves playerIds", async () => {
    await boot();
    fire("updateUser", ben(), { role: 4 }, {}, "gm");
    expect(reached()).toEqual({ hits: 0, cards: 0, pins: 1, hud: 1, board: 1 });
  });
});

describe("userConnected", () => {
  it("refreshes the Pinboard alone: no chip shows who is connected", async () => {
    await boot();
    fire("userConnected", ben(), true);
    expect(reached()).toEqual({ hits: 0, cards: 0, pins: 0, hud: 0, board: 1 });
  });
});
