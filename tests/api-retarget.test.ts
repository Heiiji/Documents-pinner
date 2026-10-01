/**
 * @vitest-environment jsdom
 *
 * Pointing a pin at a different document.
 *
 * The seam A9 warned about: every pure part of this — `mergePin`, `planGrant`,
 * `planRelease` — is already covered, and none of them can see the thing that is
 * actually new, which is the ORDER three already-correct calls are made in and what
 * happens between them. So this file drives the real verb against two real-ish
 * documents and asserts what each one ends up holding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpSource } from "../src/types/dp";
import { fakeDoc, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const source = (over: Partial<DpSource> = {}): DpSource => ({
  kind: "document",
  uuid: "JournalEntry.old",
  src: null,
  pageId: null,
  pdfPage: null,
  followName: true,
  ...over,
});

/** A revealed prop with a hand-built audience, an effect seed and a typed label. */
function pinnedTile() {
  const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        source: source({ pageId: "aBcD1234eFgH5678", pdfPage: 4 }),
        display: { ...defaultPin().display, label: "Sealed Envelope", typeSize: 18 },
        effect: { ...defaultPin().effect, id: "glitch", seed: 4242, intensity: 0.8 },
        interaction: { open: "single", tooltip: "Still warm." },
        audience: {
          ...defaultPin().audience,
          kind: "selected",
          users: ["ali"],
          ownershipSync: { enabled: true, level: 2 },
        },
      },
    },
  };
  return tile;
}

const pinOf = (tile: any) => tile.flags[MODULE_ID][FLAGS.PIN];

afterEach(() => {
  delete (globalThis as any).fromUuid;
  uninstallWorld();
  vi.resetModules();
});

describe("retarget, as the payload sees it", () => {
  let tile: any;
  let api: typeof import("../src/api");
  let sync: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../src/data/ownership-sync", () => ({
      syncAnchor: vi.fn(async () => {}),
      releaseAnchor: vi.fn(async () => {}),
    }));
    tile = pinnedTile();
    installWorld({ isGM: true, tiles: [tile] });
    (globalThis as any).fromUuid = async () => null;
    sync = await import("../src/data/ownership-sync");
    api = await import("../src/api");
  });

  it("moves the source and clears both page fields, which named the old document", async () => {
    await api.retarget(tile, source({ uuid: "JournalEntry.new" }));

    expect(pinOf(tile).source.uuid).toBe("JournalEntry.new");
    expect(pinOf(tile).source.pageId).toBeNull();
    expect(pinOf(tile).source.pdfPage).toBeNull();
  });

  it("keeps everything the pin is, which is the whole reason it is not adoptTile", async () => {
    await api.retarget(tile, source({ uuid: "JournalEntry.new" }));
    const pin = pinOf(tile);

    expect(pin.audience.kind).toBe("selected");
    expect(pin.audience.users).toEqual(["ali"]);
    expect(pin.effect.seed).toBe(4242);
    expect(pin.effect.id).toBe("glitch");
    expect(pin.display.label).toBe("Sealed Envelope");
    expect(pin.display.typeSize).toBe(18);
    expect(pin.interaction.tooltip).toBe("Still warm.");
    expect(pin.mode).toBe("prop");
    expect(tile.width).toBe(400);
    expect(tile.height).toBe(560);
  });

  it("writes the texture in the SAME update as the flag, in both directions", async () => {
    await api.retarget(tile, source({ kind: "image", uuid: null, src: "worlds/map.webp" }));
    const toImage = tile.updates.at(-1);
    expect(toImage["texture.src"]).toBe("worlds/map.webp");
    expect(toImage[`flags.${MODULE_ID}.${FLAGS.PIN}`].source.src).toBe("worlds/map.webp");

    await api.retarget(tile, source({ uuid: "JournalEntry.new" }));
    const toDocument = tile.updates.at(-1);
    expect(toDocument["texture.src"]).toBe("icons/svg/book.svg");
    expect(toDocument[`flags.${MODULE_ID}.${FLAGS.PIN}`].source.uuid).toBe("JournalEntry.new");
  });

  it("hands the sync the old document, so one pass grants the new and releases the old", async () => {
    await api.retarget(tile, source({ uuid: "JournalEntry.new" }));

    // One call, not a sync and then a release: a pin moved between a journal and one of
    // its own pages has both documents in one family, and a separate release of the old
    // family took back the grant the sync had just made. The order — grant, then
    // release — is asserted on real documents below.
    expect(sync.syncAnchor).toHaveBeenCalledWith(tile, "JournalEntry.old");
    expect(sync.releaseAnchor).not.toHaveBeenCalled();
  });

  it("does nothing for a player, or for the source the pin already has", async () => {
    uninstallWorld();
    installWorld({ isGM: false, tiles: [tile] });
    expect(await api.retarget(tile, source({ uuid: "JournalEntry.new" }))).toBe(false);

    uninstallWorld();
    installWorld({ isGM: true, tiles: [tile] });
    expect(await api.retarget(tile, source())).toBe(false);
    expect(tile.updates).toHaveLength(0);
  });

  /**
   * The deadlock this verb was one line away from.
   *
   * `PinStore.enqueue` registers a tracked promise derived from the task it is about to
   * run, so a task that itself enqueues on the same anchor id awaits its own completion.
   * Nothing throws and nothing times out — the button simply never does anything. Only a
   * test that puts work on the queue FIRST can see it.
   */
  it("resolves while another write is already queued on the same anchor", async () => {
    const store = await import("../src/data/PinStore");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queued = store.update(tile, { display: { label: "In flight" } } as any);

    const done = api.retarget(tile, source({ uuid: "JournalEntry.new" }));
    const raced = Promise.race([done, gate.then(() => "deadlocked" as const)]);
    // A deadlock never resolves, so any bound catches it; a correct retarget wins the race
    // at once and never waits for this. Generous, so a loaded runner is not a "deadlock".
    setTimeout(release, 2000);

    expect(await raced).toBe(true);
    await queued;
  });
});

/**
 * The ownership walk, with the real ledger.
 *
 * Two journals, one player with hand-edited permissions on both. The invariant under
 * test is the one DESIGN §4 exists for: the old document comes back byte-for-byte,
 * including the absence of our own bookkeeping.
 */
describe("retarget, as the two documents see it", () => {
  it("restores a hand-set level on the old journal and raises the new one", async () => {
    // The suite above mocks the ledger away; `resetModules` clears the module registry
    // but not the mock registry, so this one has to say so explicitly.
    vi.doUnmock("../src/data/ownership-sync");
    vi.resetModules();
    const tile = pinnedTile();
    const oldDoc = fakeDoc({ id: "old", uuid: "JournalEntry.old", ownership: { ali: 3 } });
    const newDoc = fakeDoc({ id: "new", uuid: "JournalEntry.new", ownership: { ali: 1 } });
    const byUuid: Record<string, any> = {
      "JournalEntry.old": oldDoc,
      "JournalEntry.new": newDoc,
    };

    installWorld({ isGM: true, tiles: [tile] });
    (globalThis as any).fromUuid = async (uuid: string) => byUuid[uuid] ?? null;

    const api = await import("../src/api");
    const sync = await import("../src/data/ownership-sync");

    // The grant the pin already holds on the old journal.
    await sync.syncAnchor(tile);
    expect(oldDoc.flags[MODULE_ID][FLAGS.GRANTS]).toBeTruthy();
    // Never lowered: OWNER by hand outranks the OBSERVER we would have granted.
    expect(oldDoc.ownership.ali).toBe(3);

    await api.retarget(tile, source({ uuid: "JournalEntry.new" }));

    // Byte-for-byte, including no ledger flag left behind.
    expect(oldDoc.ownership.ali).toBe(3);
    expect(oldDoc.flags[MODULE_ID]?.[FLAGS.GRANTS] ?? null).toBeNull();
    // LIMITED by hand is raised to the level the audience asks for, reversibly.
    expect(newDoc.ownership.ali).toBe(2);
  });

  it("grants on the new document before releasing the old, so nobody is briefly locked out", async () => {
    vi.doUnmock("../src/data/ownership-sync");
    vi.resetModules();
    const tile = pinnedTile();
    const writes: string[] = [];
    const oldDoc = fakeDoc({ id: "old", uuid: "JournalEntry.old", ownership: {} });
    const newDoc = fakeDoc({ id: "new", uuid: "JournalEntry.new", ownership: {} });
    for (const doc of [oldDoc, newDoc]) {
      const update = doc.update;
      doc.update = async (changes: any, context?: any) => {
        writes.push(doc.id);
        return update(changes, context);
      };
    }
    const byUuid: Record<string, any> = { "JournalEntry.old": oldDoc, "JournalEntry.new": newDoc };

    installWorld({ isGM: true, tiles: [tile] });
    (globalThis as any).fromUuid = async (uuid: string) => byUuid[uuid] ?? null;

    const api = await import("../src/api");
    const sync = await import("../src/data/ownership-sync");
    await sync.syncAnchor(tile);
    writes.length = 0;

    await api.retarget(tile, source({ uuid: "JournalEntry.new" }));

    expect(writes).toEqual(["new", "old"]);
    expect(oldDoc.ownership.ali).toBeUndefined();
    expect(newDoc.ownership.ali).toBe(2);
  });
});
