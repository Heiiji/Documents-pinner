/**
 * @vitest-environment jsdom
 *
 * A pin hidden or shown with core's own controls — the Tiles layer's HUD, TileConfig's
 * Hidden box, the Placeables sidebar, a paste — through the hooks `main.ts` registers (A9).
 *
 * Core wrote `hidden` and left the audience saying who it was for. The eye, the chips and
 * the Pinboard read the audience and lied, and the next module write derived `hidden` from
 * it and put the pin back on every player's screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { readPin } from "../src/data/PinData";
import {
  fakeJournal,
  fakeTile,
  installSources,
  installWorld,
  uninstallWorld,
} from "./helpers/fake-foundry";

const registered = new Map<string, ((...args: any[]) => unknown)[]>();

/** The world, then `main.ts`, with every handler it registers recorded by name. */
async function boot(tiles: any[], journals: any[] = []) {
  const world = installWorld({ isGM: true, tiles });
  installSources(world, { journals });
  registered.clear();
  (globalThis as any).Hooks.on = (name: string, fn: (...args: any[]) => unknown) =>
    registered.set(name, [...(registered.get(name) ?? []), fn]);
  await import("../src/main");
  return world;
}

const fire = (name: string, ...args: unknown[]) => {
  for (const handler of registered.get(name) ?? []) handler(...args);
};

/** What core does with a change made on this client: the pre-hook, the write, the hook. */
async function coreUpdate(doc: any, changes: Record<string, unknown>) {
  const options = {};
  fire("preUpdateTile", doc, changes, options, "gm");
  await doc.update(changes, options);
  fire("updateTile", doc, changes, options, "gm");
}

function pin(audience: Record<string, unknown>, hidden = false) {
  const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", hidden });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        source: { ...defaultPin().source, uuid: "JournalEntry.letter" },
        audience: { ...defaultPin().audience, ...audience },
      },
    },
  };
  return tile;
}

beforeEach(() => vi.resetModules());
afterEach(() => uninstallWorld());

describe("a pin hidden or shown with core's own controls", () => {
  it("hides it in its audience, remembering who it was for, and shows it to them again, access and all", async () => {
    const tile = pin({ kind: "selected", users: ["ali"] });
    const letter = fakeJournal({ id: "letter", name: "Letter" });
    await boot([tile], [letter]);

    await coreUpdate(tile, { hidden: true });
    expect(readPin(tile)?.audience).toMatchObject({
      kind: "hidden",
      restore: { kind: "selected", users: ["ali"] },
    });

    await coreUpdate(tile, { hidden: false });
    expect(readPin(tile)?.audience).toMatchObject({ kind: "selected", users: ["ali"] });
    await vi.waitFor(() => expect(letter.ownership).toEqual({ ali: 2 }));

    await coreUpdate(tile, { hidden: true });
    await vi.waitFor(() => expect(letter.ownership).toEqual({}));
  });

  it("stays hidden through an unrelated edit, when it was hidden while the module was not listening", async () => {
    const tile = pin({ kind: "everyone" }, true);
    await boot([tile]);
    const { patch } = await import("../src/api");

    await patch(tile, { display: { label: "The Duke's Letter" } });

    expect(tile.hidden).toBe(true);
  });

  it("is hidden in its audience too when core creates it hidden, as a paste does", async () => {
    const tile = pin({ kind: "everyone" }, true);
    await boot([]);

    fire("preCreateTile", tile, {}, {}, "gm");

    expect(readPin(tile)?.audience).toMatchObject({
      kind: "hidden",
      restore: { kind: "everyone", users: [] },
    });
  });
});
