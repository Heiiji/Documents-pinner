import { describe, expect, it } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { planMigration } from "../src/data/migrations";
import { defaultPin, validatePin } from "../src/data/pin-schema";

const FLAG_PATH = `flags.${MODULE_ID}.${FLAGS.PIN}`;

function tile(id: string, pin: unknown) {
  return { id, flags: pin === undefined ? {} : { [MODULE_ID]: { [FLAGS.PIN]: pin } } };
}

const cleanPin = () =>
  validatePin({
    ...defaultPin(),
    source: {
      kind: "document",
      uuid: "JournalEntry.abc",
      src: null,
      pageId: null,
      followName: true,
    },
  }).pin;

describe("planMigration", () => {
  it("ignores tiles that are not pins", () => {
    expect(planMigration([tile("a", undefined), tile("b", null)])).toEqual([]);
  });

  it("leaves an already-current payload alone", () => {
    expect(planMigration([tile("a", cleanPin())])).toEqual([]);
  });

  it("does not rewrite for key order alone", () => {
    const shuffled = Object.fromEntries(Object.entries(cleanPin()).reverse());
    expect(planMigration([tile("a", shuffled)])).toEqual([]);
  });

  it("rewrites a payload missing a field the current schema adds", () => {
    const old: any = cleanPin();
    delete old.geometry;
    const updates = planMigration([tile("a", old)]);
    expect(updates.length).toBe(1);
    expect(updates[0]._id).toBe("a");
    expect((updates[0][FLAG_PATH] as any).geometry).toEqual({ pin: null, prop: null });
  });

  it("rewrites a payload carrying a value the schema no longer allows", () => {
    const bad: any = { ...cleanPin(), mode: "hologram" };
    const updates = planMigration([tile("a", bad)]);
    expect((updates[0][FLAG_PATH] as any).mode).toBe("prop");
  });

  it("is idempotent: the plan is empty once applied", () => {
    const old: any = cleanPin();
    delete old.geometry;
    const migrated = planMigration([tile("a", old)])[0][FLAG_PATH];
    expect(planMigration([tile("a", migrated)])).toEqual([]);
  });

  it("plans only the tiles that need it", () => {
    const stale: any = cleanPin();
    stale.display = { ...stale.display, padding: 42 };
    const updates = planMigration([tile("ok", cleanPin()), tile("stale", stale)]);
    expect(updates.map((u) => u._id)).toEqual(["stale"]);
  });
});
