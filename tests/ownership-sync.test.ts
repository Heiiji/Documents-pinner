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
import { readLedger } from "../src/data/ownership-plan";
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

/** The ledger as it is actually STORED, after v14's expansion, diff and merge, read back. */
const ledger = (): any => readLedger(journal.flags?.["documents-pinner"]?.grants) ?? undefined;

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
 * One anchor's syncs, one at a time (DESIGN A29).
 *
 * A sync read the pin, then awaited its document, then queued its grant. Two syncs of one
 * anchor — two quick chip clicks, or the `ready` sweep beside a resumed edit hold — reached
 * the ledger in whatever order those reads resolved, and the first audience could be
 * written last.
 */
describe("syncs of one anchor", () => {
  /** `fromUuid` whose FIRST answer waits for `release`; every later one is immediate. */
  function slowFirstRead() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    (globalThis as any).foundry.utils.fromUuid = async (uuid: string) => {
      if (reads++ === 0) await gate;
      return uuid === "JournalEntry.j" ? journal : null;
    };
    return release;
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("end on the audience the pin was given last, however their reads resolve", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    const release = slowFirstRead();

    const first = syncAnchor(anchorA);
    await tick();
    setAudience(anchorA, "selected", ["ali", "ben"]);
    const second = syncAnchor(anchorA);
    await tick();
    release();
    await Promise.all([first, second]);

    expect(Object.keys(ledger().holders).sort()).toEqual(["ali", "ben"]);
    expect(journal.ownership).toEqual({ default: 0, ali: 2, ben: 2 });
  });

  it("release after the sync in flight, rather than finding nothing and letting it land", async () => {
    const { releaseAnchor, syncAnchor } = await import("../src/data/ownership-sync");
    const release = slowFirstRead();

    const granting = syncAnchor(anchorA);
    await tick();
    const releasing = releaseAnchor(anchorA);
    await tick();
    release();
    await Promise.all([granting, releasing]);

    expect(ledger()).toBeUndefined();
    expect(journal.ownership).toEqual({ default: 0 });
  });

  it("grant nothing once the anchor is deleted, and give back what it held", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    const scene = (globalThis as any).game.scenes.contents[0];
    anchorA.parent = scene;
    await syncAnchor(anchorA);
    expect(journal.ownership.ali).toBe(2);

    // Core's delete: off the scene's collection, the document object left as it was.
    scene.tiles.contents.splice(scene.tiles.contents.indexOf(anchorA), 1);
    setAudience(anchorA, "selected", ["ali", "ben"]);
    await syncAnchor(anchorA);

    expect(ledger()).toBeUndefined();
    expect(journal.ownership).toEqual({ default: 0 });
  });

  it("do not hold up another anchor's: two pins of one journal synced at once keep both", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    setAudience(anchorB, "selected", ["ben"]);

    await Promise.all([syncAnchor(anchorA), syncAnchor(anchorB)]);

    expect(ledger().holders).toEqual({
      ali: { "Scene.s1.Tile.a": 2 },
      ben: { "Scene.s1.Tile.b": 2 },
    });
    expect(journal.ownership).toEqual({ default: 0, ali: 2, ben: 2 });
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

  it("releases an orphan after a grant still landing on the same journal, not over it", async () => {
    const sync = await import("../src/data/ownership-sync");
    anchorA.flags["documents-pinner"].pin.source.uuid = "JournalEntry.other";
    setAudience(anchorB, "selected", ["ben"]);
    // Anchor B's grant — an edit hold resumed at `ready` — is slow to land.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const write = journal.update;
    let held = false;
    journal.update = async (...args: [any, any]) => {
      if (!held) {
        held = true;
        await gate;
      }
      return write(...args);
    };

    const granting = sync.syncAnchor(anchorB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sweeping = sync.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([granting, sweeping]);

    expect(ledger().holders).toEqual({ ben: { "Scene.s1.Tile.b": 2 } });
    expect(journal.ownership).toEqual({ default: 0, ben: 2 });
  });
});

/**
 * The sweep asked whether a holder's anchor still pointed at the document, never whether it
 * still WANTED the key (DESIGN A29). A reload in the middle of "Hide all" — the tiles written
 * hidden, their releases not yet landed — left the players holding OBSERVER on documents
 * behind hidden pins, and every sweep after kept the grants, their anchors being alive and
 * pointing here. Each case below is a pin written without the sync that should follow it.
 */
describe("reconcile, for a pin that no longer asks for its grant", () => {
  let world: ReturnType<typeof installWorld>;
  const said = (key: string) => world.notifications.filter((n) => n.message === key).length;

  beforeEach(async () => {
    world = installWorld({ isGM: true, tiles: [anchorA, anchorB] });
    (globalThis as any).foundry.utils.fromUuid = async (uuid: string) =>
      uuid === "JournalEntry.j" ? journal : null;
    (globalThis as any).game.journal.contents = [journal];
  });

  it("takes back the grant of a pin hidden while its release was interrupted", async () => {
    const sync = await import("../src/data/ownership-sync");
    await sync.syncAnchor(anchorA);
    setAudience(anchorA, "hidden", []);
    anchorA.hidden = true;

    expect(await sync.reconcile()).toBe(0);

    expect(ledger()).toBeUndefined();
    expect(journal.ownership).toEqual({ default: 0 });
    expect(said("DP.notice.grantsRevoked")).toBe(1);
    expect(said("DP.notice.ledgerRepaired")).toBe(0);
  });

  it("releases every grant of a pin whose access was switched off", async () => {
    const sync = await import("../src/data/ownership-sync");
    await sync.syncAnchor(anchorA);
    anchorA.flags["documents-pinner"].pin.audience.ownershipSync.enabled = false;

    await sync.reconcile();

    expect(ledger()).toBeUndefined();
    expect(journal.ownership).toEqual({ default: 0 });
  });

  it("moves an everyone grant to the one player a narrowed pin is now for", async () => {
    const sync = await import("../src/data/ownership-sync");
    setAudience(anchorA, "everyone", []);
    await sync.syncAnchor(anchorA);
    expect(journal.ownership.default).toBe(2);
    setAudience(anchorA, "selected", ["ali"]);

    await sync.reconcile();

    expect(ledger().holders).toEqual({ ali: { "Scene.s1.Tile.a": 2 } });
    expect(journal.ownership).toEqual({ default: 0, ali: 2 });
  });

  it("restores the baseline and leaves a GM's own edit where it is", async () => {
    const sync = await import("../src/data/ownership-sync");
    // Ben could already see the journal before any pin; the GM then raised Ali by hand.
    journal.ownership = { default: 0, ben: 1 };
    setAudience(anchorA, "selected", ["ali", "ben"]);
    await sync.syncAnchor(anchorA);
    journal.ownership.ali = 3;
    await sync.onSourceOwnershipEdited(journal, { ownership: { ali: 3 } }, {}, "gm");
    setAudience(anchorA, "hidden", []);

    await sync.reconcile();

    expect(journal.ownership).toEqual({ default: 0, ali: 3, ben: 1 });
    expect(ledger()).toBeUndefined();
  });

  it("takes back the grant of a player who has left the world", async () => {
    const sync = await import("../src/data/ownership-sync");
    setAudience(anchorA, "selected", ["ali", "ben"]);
    await sync.syncAnchor(anchorA);
    const users = world.game.users.contents;
    users.splice(
      users.findIndex((u: any) => u.id === "ben"),
      1
    );

    await sync.reconcile();

    expect(ledger().holders).toEqual({ ali: { "Scene.s1.Tile.a": 2 } });
    expect(journal.ownership).toEqual({ default: 0, ali: 2 });
  });

  it("leaves alone a pin that still wants what it holds", async () => {
    const sync = await import("../src/data/ownership-sync");
    await sync.syncAnchor(anchorA);
    const writes = journal.updates.length;

    expect(await sync.reconcile()).toBe(0);

    expect(journal.updates.length).toBe(writes);
    expect(world.notifications).toEqual([]);
  });

  it("finds nothing to fight for a compendium pin, whose access is the pack's", async () => {
    const sync = await import("../src/data/ownership-sync");
    const packPin = pinned("c", "everyone", []);
    packPin.flags["documents-pinner"].pin.source.uuid = "Compendium.world.lore.JournalEntry.x";
    (globalThis as any).game.scenes.contents[0].tiles.contents = [packPin];
    await sync.syncAnchor(packPin);

    expect(await sync.reconcile()).toBe(0);

    expect(journal.updates).toEqual([]);
    expect(world.notifications).toEqual([]);
  });
});

/**
 * v14 corrupted every ledger it stored: the anchor-UUID keys under `holders` were expanded
 * into nesting, so a release never found its anchor and the player kept the permission.
 * A world upgraded to 0.3.2 already holds ledgers in that shape; they must still release.
 */
describe("a ledger v14 already stored nested", () => {
  beforeEach(() => {
    journal.ownership = { default: 0, ali: 2 };
    journal.flags = {
      "documents-pinner": {
        grants: {
          v: 1,
          baseline: { ali: null },
          granted: { ali: 2 },
          holders: { ali: { Scene: { s1: { Tile: { a: 2 } } } } },
          overridden: [],
        },
      },
    };
  });

  it("is read back as the anchor it was keyed by", async () => {
    expect(ledger().holders.ali).toEqual({ "Scene.s1.Tile.a": 2 });
  });

  it("releases the grant when the pin is hidden, and leaves no ledger behind", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    setAudience(anchorA, "hidden", []);
    await syncAnchor(anchorA);

    expect(journal.ownership.ali).toBeUndefined();
    expect(ledger()).toBeUndefined();
  });

  it("is not mistaken by the ready sweep for an orphan named `Scene`", async () => {
    const sync = await import("../src/data/ownership-sync");
    (globalThis as any).game.journal.contents = [journal];
    expect(await sync.reconcile()).toBe(0);
    expect(journal.ownership.ali).toBe(2);
  });
});

/** The operator classes the world was installed with, which `vi.resetModules` would split. */
const installed = () => (globalThis as any).foundry.data.operators;

describe("the ledger's storage", () => {
  it("is a string, which no core merges into or expands", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    await syncAnchor(anchorA);
    expect(typeof journal.flags["documents-pinner"].grants).toBe("string");
  });

  /**
   * v14 validates an ownership change key by key before applying any of the update, and a
   * deletion — `-=ali` or a `ForcedDeletion` — is not a permission level: core refuses the
   * whole write, ledger included, and resolves as if it had worked. Measured by running
   * 14.367's own update path. So every release of a player who had no entry before the pin
   * failed on v14, and the player kept the permission.
   */
  it("writes a release that deletes a player's entry as the whole record, which v14 accepts", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    const { ForcedReplacement } = installed();
    await syncAnchor(anchorA);
    setAudience(anchorA, "hidden", []);
    await syncAnchor(anchorA);

    const last = journal.updates[journal.updates.length - 1];
    expect(last.ownership).toBeInstanceOf(ForcedReplacement);
    expect(last.ownership.value).toEqual({ default: 0 });
    expect(journal.rejected).toEqual([]);
    expect(journal.ownership).toEqual({ default: 0 });
  });

  it("keeps a grant that only sets levels as a plain diff", async () => {
    const { syncAnchor } = await import("../src/data/ownership-sync");
    await syncAnchor(anchorA);
    expect(journal.updates[0].ownership).toEqual({ ali: 2 });
  });
});

/**
 * Core's ownership dialog writes the whole record as a `ForcedReplacement`, in which a
 * player the GM removed is simply absent. Read as a plain diff that was no change at all,
 * and the ledger went on recording a grant the GM had taken away.
 */
describe("a GM's edit through core's ownership dialog", () => {
  const stored = () => ({
    v: 1,
    baseline: { ali: null },
    granted: { ali: 2 },
    holders: { ali: { "Scene.s1.Tile.a": 2 } },
    overridden: [],
  });

  it("reads a player missing from the replacement as removed", async () => {
    const { ownershipChange } = await import("../src/data/ownership-sync");
    const { ForcedReplacement } = installed();
    const change = ownershipChange(ForcedReplacement.create({ default: 0, ben: 1 }), stored());
    expect(change).toEqual({ default: 0, ben: 1, "-=ali": null });
  });

  it("reads a ForcedDeletion value as a removal, and passes a plain diff through", async () => {
    const { ownershipChange } = await import("../src/data/ownership-sync");
    const { ForcedDeletion } = installed();
    expect(ownershipChange({ ali: new ForcedDeletion(), ben: 3 }, stored())).toEqual({
      "-=ali": null,
      ben: 3,
    });
  });

  it("records the removal as the GM's own edit when it happens", async () => {
    const sync = await import("../src/data/ownership-sync");
    const { ForcedReplacement } = installed();
    await sync.syncAnchor(anchorA);

    journal.ownership = { default: 0 };
    await sync.onSourceOwnershipEdited(
      journal,
      { ownership: ForcedReplacement.create({ default: 0 }) },
      {},
      "gm"
    );
    expect(ledger().overridden).toContain("ali");
  });
});
