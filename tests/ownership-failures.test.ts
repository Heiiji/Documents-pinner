import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { fakeDoc, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

let docs: any[];
let tiles: any[];
let world: ReturnType<typeof installWorld>;
let sync: typeof import("../src/data/ownership-sync");
let api: typeof import("../src/api");

beforeEach(async () => {
  vi.resetModules();
  docs = ["first", "second"].map((id) =>
    fakeDoc({ id, uuid: `JournalEntry.${id}`, ownership: { default: 0 } })
  );
  tiles = docs.map((doc) => {
    const pin = defaultPin();
    pin.source.uuid = doc.uuid;
    pin.audience = {
      ...pin.audience,
      kind: "selected",
      users: ["ali"],
      ownershipSync: { enabled: true, level: 2 },
    };
    return fakeTile({
      id: doc.id,
      uuid: `Scene.s1.Tile.${doc.id}`,
      hidden: false,
      flags: { [MODULE_ID]: { [FLAGS.PIN]: pin } },
    });
  });
  world = installWorld({ isGM: true, tiles });
  world.game.journal.contents = docs;
  (globalThis as any).foundry.utils.fromUuid = async (uuid: string) =>
    docs.find((doc) => doc.uuid === uuid) ?? null;
  sync = await import("../src/data/ownership-sync");
  api = await import("../src/api");
  for (const tile of tiles) await sync.syncAnchor(tile);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallWorld();
});

const grants = (doc: any) => doc.flags?.[MODULE_ID]?.[FLAGS.GRANTS];

describe("failed ownership writes", () => {
  it.each(["throw", "undefined"])(
    "continues cleanup after %s, keeps failed grants, and never announces complete success",
    async (failure) => {
      docs[0].update = async () => {
        if (failure === "throw") throw new Error("server refusal");
        return undefined;
      };

      await expect(api.releaseAllAccess()).rejects.toThrow("1 document(s)");

      expect(docs[0].ownership).toEqual({ default: 0, ali: 2 });
      expect(grants(docs[0])).toBeTruthy();
      expect(docs[1].ownership).toEqual({ default: 0 });
      expect(grants(docs[1])).toBeUndefined();
      expect(world.notifications).toContainEqual({
        type: "error",
        message: "DP.notice.accessReleaseFailed",
      });
      expect(world.notifications.some((n) => n.message === "DP.notice.accessReleased")).toBe(false);
    }
  );

  it("accepts an undefined result when the desired state is already stored", async () => {
    const update = docs[0].update;
    docs[0].update = async (...args: unknown[]) => {
      await update(...args);
      return undefined;
    };

    await expect(api.releaseAllAccess()).resolves.toBe(2);
    expect(world.notifications).toEqual([{ type: "info", message: "DP.notice.accessReleased" }]);
  });

  it("does not write an unchanged ownership ledger again", async () => {
    const update = vi.spyOn(docs[0], "update").mockResolvedValue(undefined);
    await expect(sync.syncAnchor(tiles[0])).resolves.toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(world.notifications).toEqual([]);
  });

  it.each(["deletePin", "unpin"] as const)(
    "keeps the pin when %s cannot revoke access",
    async (verb) => {
      docs[0].update = async () => undefined;

      await expect(api[verb](tiles[0])).rejects.toThrow("Pin was kept");

      expect(tiles[0].deleted).not.toBe(true);
      expect(tiles[0].flags[MODULE_ID][FLAGS.PIN]).toBeTruthy();
      expect(grants(docs[0])).toBeTruthy();
    }
  );

  it("attempts every bulk release but keeps the pins if any release fails", async () => {
    docs[0].update = async () => undefined;
    const remove = vi.spyOn(world.canvas.scene, "deleteEmbeddedDocuments");

    await expect(api.deletePins(world.canvas.scene, tiles)).rejects.toThrow("Pins were kept");

    expect(remove).not.toHaveBeenCalled();
    expect(docs[0].ownership.ali).toBe(2);
    expect(docs[1].ownership.ali).toBeUndefined();
  });

  it("releases the previous source after a failed grant so a retry cannot orphan its access", async () => {
    await sync.releaseAnchor(tiles[1]);
    const update = docs[1].update;
    docs[1].update = async () => undefined;
    tiles[0].flags[MODULE_ID][FLAGS.PIN].source.uuid = docs[1].uuid;

    await expect(sync.syncAnchor(tiles[0], docs[0].uuid)).resolves.toBe(false);

    expect(docs[0].ownership.ali).toBeUndefined();
    expect(grants(docs[0])).toBeUndefined();
    expect(docs[1].ownership.ali).toBeUndefined();

    docs[1].update = update;
    await expect(sync.syncAnchor(tiles[0])).resolves.toBe(true);
    expect(docs[1].ownership.ali).toBe(2);
    expect(docs[0].ownership.ali).toBeUndefined();
    expect(grants(docs[0])).toBeUndefined();
  });

  it("does not count a refused repair as a repaired grant", async () => {
    docs[0].update = async () => undefined;
    world.canvas.scene.tiles.contents.splice(0, 1);

    await expect(sync.reconcile()).resolves.toBe(0);

    expect(grants(docs[0])).toBeTruthy();
    expect(world.notifications.some((n) => n.message === "DP.notice.ledgerRepaired")).toBe(false);
  });
});
