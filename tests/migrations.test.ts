import { describe, expect, it } from "vitest";
import { FLAGS, MODULE_ID, SCHEMA_VERSION } from "../src/const";
import { planMigration } from "../src/data/migrations";
import { cardMetrics, defaultPin, freezeMetrics, validatePin } from "../src/data/pin-schema";

const FLAG_PATH = `flags.${MODULE_ID}.${FLAGS.PIN}`;

function tile(
  id: string,
  pin: unknown,
  size: { width: number; height: number; x?: number; y?: number; rotation?: number } = {
    width: 400,
    height: 560,
  }
) {
  return {
    id,
    x: 0,
    y: 0,
    rotation: 0,
    ...size,
    flags: pin === undefined ? {} : { [MODULE_ID]: { [FLAGS.PIN]: pin } },
  };
}

/** A payload exactly as version 1 wrote it: no type size, no margin, the dead fields. */
const v1Pin = () => {
  const pin: any = cleanPin();
  delete pin.display.typeSize;
  delete pin.display.margin;
  pin.display.showLabel = true;
  pin.display.labelPosition = "below";
  pin.interaction.openPage = true;
  pin.interaction.clickThrough = false;
  pin.v = 1;
  return pin;
};

/** A payload with nothing left to migrate: current shape, and the metrics stored. */
const cleanPin = () =>
  freezeMetrics(
    validatePin({
      ...defaultPin(),
      source: {
        kind: "document",
        uuid: "JournalEntry.abc",
        src: null,
        pageId: null,
        pdfPage: null,
        followName: true,
      },
    }).pin,
    { width: 400, height: 560 }
  );

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

  it("rewrites every version 1 payload, because the type size becomes stored", () => {
    const updates = planMigration([tile("a", v1Pin())]);
    expect(updates.length).toBe(1);
    expect((updates[0][FLAG_PATH] as any).v).toBe(SCHEMA_VERSION);
  });

  it("freezes the type size a prop is currently drawn at, so migrating changes nothing on the map", () => {
    const size = { width: 800, height: 1132 };
    const migrated: any = planMigration([tile("a", v1Pin(), size)])[0][FLAG_PATH];
    expect(migrated.display.typeSize).toBeCloseTo(800 / 26, 6);
    // Legacy padding was 0.06 of the short edge: 48px, which at 30.77px type is 1.56em.
    expect(migrated.display.margin).toBeCloseTo((0.06 * 800) / (800 / 26), 3);
  });

  it("reproduces the pre-migration pixels exactly", () => {
    for (const size of [
      { width: 400, height: 560 },
      { width: 1300, height: 240 },
    ]) {
      const before = cardMetrics(validatePin(v1Pin()).pin.display, size);
      const migrated: any = planMigration([tile("a", v1Pin(), size)])[0][FLAG_PATH];
      const after = cardMetrics(migrated.display, size);
      expect(after.fontPx).toBeCloseTo(before.fontPx, 2);
      expect(after.padPx).toBe(before.padPx);
    }
  });

  it("leaves a pin-mode anchor's type to be decided when it becomes a prop", () => {
    const pin = { ...v1Pin(), mode: "pin" };
    const migrated: any = planMigration([tile("a", pin, { width: 100, height: 100 })])[0][
      FLAG_PATH
    ];
    expect(migrated.display.typeSize).toBeNull();
    expect(migrated.display.margin).toBeNull();
  });

  it("uses the remembered prop size when a pin-mode anchor has one", () => {
    const pin = {
      ...v1Pin(),
      mode: "pin",
      geometry: { pin: null, prop: { width: 800, height: 1132 } },
    };
    const migrated: any = planMigration([tile("a", pin, { width: 100, height: 100 })])[0][
      FLAG_PATH
    ];
    expect(migrated.display.typeSize).toBeCloseTo(800 / 26, 6);
  });

  it("drops the dead fields and turns click-through into open: never", () => {
    const pin = v1Pin();
    pin.interaction.clickThrough = true;
    const migrated: any = planMigration([tile("a", pin)])[0][FLAG_PATH];
    expect(migrated.display).not.toHaveProperty("showLabel");
    expect(migrated.interaction).not.toHaveProperty("clickThrough");
    expect(migrated.interaction.open).toBe("never");
  });

  it("is idempotent after freezing, at any later size", () => {
    const migrated = planMigration([tile("a", v1Pin())])[0][FLAG_PATH];
    expect(planMigration([tile("a", migrated, { width: 900, height: 900 })])).toEqual([]);
  });

  it("plans only the tiles that need it", () => {
    const stale: any = cleanPin();
    stale.display = { ...stale.display, padding: 42 };
    const updates = planMigration([tile("ok", cleanPin()), tile("stale", stale)]);
    expect(updates.map((u) => u._id)).toEqual(["stale"]);
  });
});

/**
 * Version 3: the paper stays where it is.
 *
 * A card used to be placed with the document's point as its top-left corner; core drew
 * the tile about that point. The sweep moves the point to where the card's centre already
 * was, so nothing moves on the map and core's frame joins the paper.
 */
describe("re-anchoring a prop that was drawn as a card", () => {
  const card = () => true;
  const texture = () => false;
  /** A prop exactly as 0.2.0 or 0.2.1 wrote it: current shape, version 2. */
  const v2Prop = (): any => ({ ...cleanPin(), v: 2 });
  const at = (x: number, y: number, rotation = 0) => ({ width: 400, height: 560, x, y, rotation });

  it("moves the point to the centre the card already had", () => {
    const [update] = planMigration([tile("a", v2Prop(), at(100, 240))], { drawnAsCard: card });
    expect(update.x).toBe(300);
    expect(update.y).toBe(520);
    expect((update[FLAG_PATH] as any).v).toBe(SCHEMA_VERSION);
  });

  it("moves it the same at any rotation, because the card turned about that centre", () => {
    const [update] = planMigration([tile("a", v2Prop(), at(100, 240, 90))], { drawnAsCard: card });
    expect(update.x).toBe(300);
    expect(update.y).toBe(520);
  });

  it("leaves a prop that was a texture on the mesh where core drew it", () => {
    const [update] = planMigration([tile("a", v2Prop(), at(100, 240))], { drawnAsCard: texture });
    expect(update).toBeDefined();
    expect("x" in update).toBe(false);
  });

  it("leaves a pin-mode anchor alone: core drew its icon at the point", () => {
    const pin = { ...v2Prop(), mode: "pin" };
    const [update] = planMigration([tile("a", pin, { ...at(100, 240), width: 100, height: 100 })], {
      drawnAsCard: card,
    });
    expect("x" in update).toBe(false);
  });

  it("treats a payload with no version as older than the move", () => {
    const pin = v2Prop();
    delete pin.v;
    const [update] = planMigration([tile("a", pin, at(100, 240))], { drawnAsCard: card });
    expect(update.x).toBe(300);
  });

  it("never moves twice", () => {
    const [first] = planMigration([tile("a", v2Prop(), at(100, 240))], { drawnAsCard: card });
    const moved = tile("a", first[FLAG_PATH], at(first.x as number, first.y as number));
    expect(planMigration([moved], { drawnAsCard: card })).toEqual([]);
  });

  it("does not move without a client to ask", () => {
    const [update] = planMigration([tile("a", v2Prop(), at(100, 240))]);
    expect("x" in update).toBe(false);
  });
});
