/**
 * The ownership ledger against a document that MERGES, which is what Foundry does.
 *
 * `ownership-plan.ts` is pure, exhaustively tested and correct — it emits
 * `delete ledger.holders[key]` and the tests assert the returned object. The defect is
 * in the layer around it: `applyPlan` writes the whole ledger as a nested plain object,
 * and `Document#update` DEEP-MERGES those. The module relies on that merge itself, which
 * is why `DELETE_PREFIX` and `-=` keys exist everywhere else.
 *
 * So every deletion the plan computed was discarded on the way to the server, and no key
 * could ever leave the stored ledger. The scenario is ordinary: pin A on journal J shown
 * to Ali, GM flips it to Ben. The plan is right; the stored ledger ends up claiming both.
 *
 * These tests therefore write through `fakeDoc`, whose `update` implements Foundry's own
 * merge semantics, and assert on the STORED state rather than on the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeDoc, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

let journal: any;
let anchorA: any;
let anchorB: any;

function pinned(id: string, kind: string, users: string[]) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}` });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        source: {
          kind: "document",
          uuid: "JournalEntry.j",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
        },
        audience: {
          ...defaultPin().audience,
          kind,
          users,
          ownershipSync: { enabled: true, level: 2 },
        },
      },
    },
  };
  return tile;
}

/** The ledger as it is actually STORED, after the merge. */
const ledger = () => journal.flags?.["documents-pinner"]?.grants;

beforeEach(() => {
  vi.resetModules();
  journal = fakeDoc({ id: "j", uuid: "JournalEntry.j", ownership: { default: 0 } });
  anchorA = pinned("a", "selected", ["ali"]);
  anchorB = pinned("b", "selected", ["ali"]);

  installWorld({ isGM: true, tiles: [anchorA, anchorB] });
  (globalThis as any).foundry.utils.fromUuid = async (uuid: string) =>
    uuid === "JournalEntry.j" ? journal : null;
});

afterEach(() => uninstallWorld());

/** Re-point an anchor's audience without going through the whole store. */
function setAudience(anchor: any, kind: string, users: string[]) {
  const pin = anchor.flags["documents-pinner"].pin;
  pin.audience = { ...pin.audience, kind, users };
}

describe("retargeting one anchor's audience", () => {
  it("actually removes the old holder from the STORED ledger", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    expect(Object.keys(ledger().holders)).toEqual(["ali"]);

    setAudience(anchorA, "selected", ["ben"]);
    await syncAnchor(anchorA);

    // Before the fix the merge left `holders: { ali: {...}, ben: {...} }`, so the ledger
    // claimed anchor A held a grant for a user whose ownership entry no longer existed.
    expect(Object.keys(ledger().holders)).toEqual(["ben"]);
  });

  it("removes the old user's ownership entry too", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    expect(journal.ownership.ali).toBe(2);

    setAudience(anchorA, "selected", ["ben"]);
    await syncAnchor(anchorA);

    expect(journal.ownership.ali).toBeUndefined();
    expect(journal.ownership.ben).toBe(2);
  });

  it("drops the stale baseline and granted entries with it", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    setAudience(anchorA, "selected", ["ben"]);
    await syncAnchor(anchorA);

    expect(Object.keys(ledger().baseline)).toEqual(["ben"]);
    expect(Object.keys(ledger().granted)).toEqual(["ben"]);
  });

  it("leaves no phantom holder that a later release cannot clear", async () => {
    const { syncAnchor, releaseAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    setAudience(anchorA, "selected", ["ben"]);
    await syncAnchor(anchorA);
    await releaseAnchor(anchorA);

    // The flag is unset entirely once nothing holds a grant, and the journal is back to
    // exactly what it was — which is invariant 3.
    expect(ledger()).toBeUndefined();
    expect(journal.ownership).toEqual({ default: 0 });
  });

  it("does not warn about a GM override that never happened", async () => {
    const { syncAnchor, releaseAnchor } = await import("../src/data/ownership-sync");
    const world = installWorld({ isGM: true, tiles: [anchorA, anchorB] });
    (globalThis as any).foundry.utils.fromUuid = async () => journal;

    await syncAnchor(anchorA);
    setAudience(anchorA, "selected", ["ben"]);
    await syncAnchor(anchorA);
    await releaseAnchor(anchorA);

    expect(world.notifications).toEqual([]);
  });
});

describe("two anchors on the same journal", () => {
  it("keeps the grant while the second anchor still wants it", async () => {
    const { syncAnchor, releaseAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    await syncAnchor(anchorB);
    await releaseAnchor(anchorA);

    expect(journal.ownership.ali).toBe(2);
    expect(Object.keys(ledger().holders.ali)).toEqual(["Scene.s1.Tile.b"]);
  });

  it("restores the exact prior state once the last one lets go", async () => {
    const { syncAnchor, releaseAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    await syncAnchor(anchorB);
    await releaseAnchor(anchorA);
    await releaseAnchor(anchorB);

    expect(journal.ownership).toEqual({ default: 0 });
    expect(ledger()).toBeUndefined();
  });
});

describe("hiding a pin", () => {
  it("releases the grant rather than leaving the player holding it", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");

    await syncAnchor(anchorA);
    setAudience(anchorA, "hidden", []);
    await syncAnchor(anchorA);

    expect(journal.ownership.ali).toBeUndefined();
    expect(ledger()).toBeUndefined();
  });
});

describe("a manual GM edit landing between a grant and its release", () => {
  it("reads the ledger inside its own queue, not before it", async () => {
    const { onSourceOwnershipEdited, syncAnchor } = await import("../src/data/ownership-sync");

    // Nothing is granted yet, so the ledger does not exist at the moment the hook fires.
    // Reading it outside the queue meant this returned early and the rebase was lost.
    const rebase = onSourceOwnershipEdited(journal, { ownership: { ali: 3 } }, {}, "gm");
    await syncAnchor(anchorA);
    await rebase;

    // The grant landed; the ledger exists and is coherent.
    expect(ledger()).toBeDefined();
    expect(Object.keys(ledger().holders)).toEqual(["ali"]);
  });
});

/**
 * DESIGN §10.8 keeps anchors as ordinary Tiles so other tooling can act on them, which
 * makes deleting one from the Tiles layer — or with Ctrl+Z, or from the v14 Placeables
 * sidebar — a mainline path rather than an edge case.
 *
 * `releaseAnchor` was reachable only from `api.deletePin`/`api.unpin`, so every one of
 * those gestures left the player holding OBSERVER on the journal indefinitely, with the
 * pin gone and nothing left to take it back from.
 */
describe("deleting a pin by a core gesture", () => {
  it("releases the grant the pin was holding", async () => {
    const { syncAnchor, onPreDeleteTile } = await import("../src/data/ownership-sync");
    const { settled } = await import("../src/data/PinStore");

    await syncAnchor(anchorA);
    expect(journal.ownership.ali).toBe(2);

    onPreDeleteTile(anchorA, {});
    // Fire-and-forget by design: a `pre*` hook cannot await, and returning a promise
    // from one would read as "cancel this delete".
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settled();

    expect(journal.ownership).toEqual({ default: 0 });
    expect(ledger()).toBeUndefined();
  });

  it("leaves the other anchor's grant alone", async () => {
    const { syncAnchor, onPreDeleteTile } = await import("../src/data/ownership-sync");
    const { settled } = await import("../src/data/PinStore");

    await syncAnchor(anchorA);
    await syncAnchor(anchorB);

    onPreDeleteTile(anchorA, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settled();

    expect(journal.ownership.ali).toBe(2);
    expect(Object.keys(ledger().holders.ali)).toEqual(["Scene.s1.Tile.b"]);
  });

  it("stands down for the module's own delete, which already released", async () => {
    const { syncAnchor, onPreDeleteTile } = await import("../src/data/ownership-sync");
    const { settled } = await import("../src/data/PinStore");
    const { internal } = await import("../src/fvtt");

    await syncAnchor(anchorA);
    const before = journal.updates.length;

    onPreDeleteTile(anchorA, internal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settled();

    expect(journal.updates.length).toBe(before);
  });

  it("ignores an ordinary tile that was never a pin", async () => {
    const { onPreDeleteTile } = await import("../src/data/ownership-sync");
    const { fakeTile: plain } = await import("./helpers/fake-foundry");
    expect(() => onPreDeleteTile(plain({ id: "z" }), {})).not.toThrow();
  });
});

/**
 * The `ready` sweep, and the fault a changeable source created.
 *
 * Until `api.retarget` existed, "this holder is stale" and "this holder's anchor is gone"
 * were the same question, so the liveness test answered both. A retargeted anchor is
 * alive and points somewhere else — it passes the liveness test, and the old document
 * would have stayed granted to a player forever with no pin anywhere naming it.
 */
describe("reconcile", () => {
  beforeEach(async () => {
    const sync = await import("../src/data/ownership-sync");
    await sync.syncAnchor(anchorA);
    (globalThis as any).game.journal.contents = [journal];
  });

  it("leaves a holder whose anchor still points at this document", async () => {
    const sync = await import("../src/data/ownership-sync");
    expect(await sync.reconcile()).toBe(0);
    expect(ledger().holders.ali).toHaveProperty("Scene.s1.Tile.a");
    expect(journal.ownership.ali).toBe(2);
  });

  it("releases a holder whose anchor is alive but now names another document", async () => {
    const sync = await import("../src/data/ownership-sync");
    anchorA.flags["documents-pinner"].pin.source.uuid = "JournalEntry.other";

    expect(await sync.reconcile()).toBe(1);
    expect(journal.flags["documents-pinner"]?.grants ?? null).toBeNull();
    expect(journal.ownership.ali).toBeUndefined();
  });

  it("still releases a holder whose anchor is gone entirely", async () => {
    const sync = await import("../src/data/ownership-sync");
    (globalThis as any).canvas.scene.tiles.contents = [];
    (globalThis as any).game.scenes.contents[0].tiles.contents = [];

    expect(await sync.reconcile()).toBe(1);
    expect(journal.flags["documents-pinner"]?.grants ?? null).toBeNull();
  });
});
