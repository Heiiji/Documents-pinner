import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARGIN_EM,
  PDF_PAGE_MAX,
  PIN_SCHEMA_VERSION,
  TYPE_SIZE_MAX,
  TYPE_SIZE_MIN,
  baseFontSize,
  cardMetrics,
  defaultPin,
  defaultTypeSize,
  freezeMetrics,
  mergePin,
  naturalSize,
  validatePin,
} from "../src/data/pin-schema";

const keys = (notices: { key: string }[]) => notices.map((n) => n.key);

/** A payload that parses with no complaints, as the baseline for targeted damage. */
function goodPin() {
  return {
    ...defaultPin(),
    source: {
      kind: "document",
      uuid: "JournalEntry.abc123",
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    },
  };
}

describe("validatePin", () => {
  it("returns a usable pin for input that is not an object at all", () => {
    for (const input of [null, undefined, 42, "pin", []]) {
      const { pin } = validatePin(input);
      expect(pin.mode).toBe("prop");
      expect(pin.v).toBe(PIN_SCHEMA_VERSION);
      expect(pin.audience.kind).toBe("hidden");
    }
  });

  it("never rejects: a broken source is an error but still yields a renderable pin", () => {
    const { pin, errors } = validatePin({ source: { kind: "document", uuid: null } });
    expect(keys(errors)).toContain("DP.pin.error.missingSource");
    expect(pin.display.paper).toBe("parchment");
  });

  it("accepts a well-formed payload without warnings or errors", () => {
    const { pin, errors, warnings } = validatePin(goodPin());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(pin.source.uuid).toBe("JournalEntry.abc123");
  });

  it("defaults to hidden, so an unparseable flag cannot leak a document", () => {
    const { pin } = validatePin({ audience: { kind: "definitely-not-a-kind" } });
    expect(pin.audience.kind).toBe("hidden");
  });

  it("reports and drops keys it does not understand", () => {
    const { warnings } = validatePin({ ...goodPin(), somethingNew: 1, display: { glitter: true } });
    const paths = warnings.map((w) => w.data?.path);
    expect(paths).toContain("somethingNew");
    expect(paths).toContain("display.glitter");
    expect(keys(warnings).every((k) => k === "DP.pin.warn.unknownKey")).toBe(true);
  });

  it("warns about a payload from a future schema version but still parses it", () => {
    const { pin, warnings } = validatePin({ ...goodPin(), v: PIN_SCHEMA_VERSION + 5 });
    expect(keys(warnings)).toContain("DP.pin.warn.futureVersion");
    expect(pin.v).toBe(PIN_SCHEMA_VERSION);
  });

  it("does not warn about an older schema version", () => {
    const { warnings } = validatePin({ ...goodPin(), v: 0 });
    expect(keys(warnings)).not.toContain("DP.pin.warn.futureVersion");
  });
});

describe("source normalisation", () => {
  it("clears a path carrying a scheme that has no business being a texture", () => {
    for (const src of ["javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "vbscript:x"]) {
      const { pin, warnings } = validatePin({ source: { kind: "image", src } });
      expect(pin.source.src, src).toBeNull();
      expect(keys(warnings), src).toContain("DP.pin.warn.badPath");
    }
  });

  it("keeps ordinary relative paths and http(s) URLs", () => {
    for (const src of [
      "worlds/keep/maps/scrap.webp",
      "icons/svg/book.svg",
      "https://example.com/a.png",
    ]) {
      const { pin, errors } = validatePin({ source: { kind: "image", src } });
      expect(pin.source.src, src).toBe(src);
      expect(errors, src).toEqual([]);
    }
  });

  it("keeps a filename containing an apostrophe — safeUrl guards the CSS path, not this one", () => {
    const src = "worlds/keep/The Duke's letter.webp";
    expect(validatePin({ source: { kind: "image", src } }).pin.source.src).toBe(src);
  });

  it("drops an over-long path rather than truncating it into a broken one", () => {
    const src = `worlds/${"a".repeat(2000)}.webp`;
    const { pin, warnings } = validatePin({ source: { kind: "image", src } });
    expect(pin.source.src).toBeNull();
    expect(keys(warnings)).toContain("DP.pin.warn.badPath");
  });

  it("strips control characters from a uuid", () => {
    const { pin } = validatePin({ source: { kind: "document", uuid: "Journal\u0000Entry.a\nb" } });
    expect(pin.source.uuid).toBe("JournalEntry.ab");
  });

  it("treats an empty-string uuid as no source", () => {
    const { pin, errors } = validatePin({ source: { kind: "document", uuid: "   " } });
    expect(pin.source.uuid).toBeNull();
    expect(keys(errors)).toContain("DP.pin.error.missingSource");
  });
});

describe("display normalisation", () => {
  it("clamps padding to the point where content still has room", () => {
    expect(validatePin({ display: { padding: 9 } }).pin.display.padding).toBe(0.5);
    expect(validatePin({ display: { padding: -3 } }).pin.display.padding).toBe(0);
  });

  it("clamps the token fade alpha into 0..1", () => {
    expect(
      validatePin({ display: { fadeUnderTokensAlpha: 4 } }).pin.display.fadeUnderTokensAlpha
    ).toBe(1);
  });

  it("falls back rather than accepting an empty paper key", () => {
    expect(validatePin({ display: { paper: "  " } }).pin.display.paper).toBe("parchment");
  });

  it("keeps an empty label, which means 'use the source document name'", () => {
    const { pin } = validatePin({ ...goodPin(), display: { ...defaultPin().display, label: "" } });
    expect(pin.display.label).toBe("");
    expect(pin.source.followName).toBe(true);
  });

  it("keeps a type size of null, meaning derive it from the tile", () => {
    expect(validatePin({}).pin.display.typeSize).toBeNull();
    expect(validatePin({ display: { typeSize: null } }).pin.display.typeSize).toBeNull();
  });

  // The guarantee the whole migration rests on: a payload written before type sizes
  // existed must render exactly as it did, on every client, until the sweep freezes
  // a number in. A fixed default here would resize every old prop on a player's
  // screen the moment they connected before the GM.
  it("normalises an old payload to null metrics, never to a fixed number", () => {
    const old = { ...goodPin(), display: { paper: "vellum", padding: 0.1 } };
    const { pin } = validatePin(old);
    expect(pin.display.typeSize).toBeNull();
    expect(pin.display.margin).toBeNull();
    expect(pin.display.padding).toBe(0.1);
  });

  it("clamps a stored type size into the legible range", () => {
    expect(validatePin({ display: { typeSize: 1 } }).pin.display.typeSize).toBe(TYPE_SIZE_MIN);
    expect(validatePin({ display: { typeSize: 999 } }).pin.display.typeSize).toBe(TYPE_SIZE_MAX);
    expect(validatePin({ display: { typeSize: "12" } }).pin.display.typeSize).toBe(12);
    expect(validatePin({ display: { typeSize: "abc" } }).pin.display.typeSize).toBeNull();
    expect(validatePin({ display: { typeSize: {} } }).pin.display.typeSize).toBeNull();
  });

  it("clamps margins into 0..6 em and keeps null", () => {
    expect(validatePin({ display: { margin: 40 } }).pin.display.margin).toBe(6);
    expect(validatePin({ display: { margin: -1 } }).pin.display.margin).toBe(0);
    expect(validatePin({ display: { margin: 1.5 } }).pin.display.margin).toBe(1.5);
    expect(validatePin({ display: { margin: null } }).pin.display.margin).toBeNull();
  });
});

describe("baseFontSize (the legacy derive)", () => {
  it("derives type size from the SHORT edge, so a wide card is not oversized", () => {
    expect(baseFontSize(400, 560)).toBe(baseFontSize(400, 4000));
  });

  it("never goes below a legible floor", () => {
    expect(baseFontSize(4, 4)).toBe(8);
  });
});

describe("cardMetrics", () => {
  const size = { width: 400, height: 566 };
  const twice = { width: 800, height: 1132 };

  it("uses the stored type size whatever the tile's size", () => {
    const display = { ...defaultPin().display, typeSize: 12, margin: 1.5 };
    expect(cardMetrics(display, size).fontPx).toBe(12);
    expect(cardMetrics(display, twice).fontPx).toBe(12);
  });

  it("derives the legacy proportional size when none is stored", () => {
    const display = defaultPin().display;
    expect(cardMetrics(display, size).fontPx).toBe(baseFontSize(400, 566));
    expect(cardMetrics(display, twice).fontPx).toBe(baseFontSize(800, 1132));
  });

  it("turns margin em into pixels of the type size", () => {
    const display = { ...defaultPin().display, typeSize: 12, margin: 1.5 };
    expect(cardMetrics(display, size).padPx).toBe(18);
    expect(cardMetrics(display, twice).padPx).toBe(18);
  });

  it("derives legacy padding from the short edge while margin is null", () => {
    const display = { ...defaultPin().display, typeSize: 12, padding: 0.1 };
    expect(cardMetrics(display, size).padPx).toBe(40);
    expect(cardMetrics(display, twice).padPx).toBe(80);
  });
});

describe("defaultTypeSize", () => {
  it("is exactly what a natural-size prop derived before type sizes existed", () => {
    const natural = naturalSize("prop", 100);
    expect(defaultTypeSize(100)).toBe(baseFontSize(natural.width, natural.height));
    expect(defaultTypeSize(100)).toBeCloseTo(400 / 26, 10);
  });

  it("follows the grid, since the natural size does", () => {
    // Above the legacy 8 px floor, which a 50 px grid would hit.
    expect(defaultTypeSize(200)).toBeCloseTo(defaultTypeSize(100) * 2, 10);
  });
});

describe("freezeMetrics", () => {
  const legacy = () => ({ ...validatePin(goodPin()).pin });

  it("reproduces the current pixels exactly, at any size", () => {
    for (const size of [
      { width: 400, height: 566 },
      { width: 800, height: 1132 },
      { width: 1300, height: 240 },
    ]) {
      const before = cardMetrics(legacy().display, size);
      const frozen = freezeMetrics(legacy(), size);
      const after = cardMetrics(frozen.display, size);
      expect(after.fontPx, `${size.width}x${size.height}`).toBeCloseTo(before.fontPx, 2);
      expect(after.padPx, `${size.width}x${size.height}`).toBe(before.padPx);
      expect(frozen.display.typeSize).not.toBeNull();
      expect(frozen.display.margin).not.toBeNull();
    }
  });

  it("leaves stored numbers alone", () => {
    const stored = { ...legacy(), display: { ...legacy().display, typeSize: 20, margin: 2 } };
    const frozen = freezeMetrics(stored, { width: 400, height: 566 });
    expect(frozen.display.typeSize).toBe(20);
    expect(frozen.display.margin).toBe(2);
  });

  it("freezes only the half that is missing", () => {
    const half = { ...legacy(), display: { ...legacy().display, typeSize: 20 } };
    const frozen = freezeMetrics(half, { width: 400, height: 566 });
    expect(frozen.display.typeSize).toBe(20);
    // Legacy padding 0.06 of a 400 short edge is 24px; at 20px type that is 1.2em.
    expect(frozen.display.margin).toBeCloseTo(1.2, 3);
  });

  it("is idempotent", () => {
    const once = freezeMetrics(legacy(), { width: 400, height: 566 });
    expect(freezeMetrics(once, { width: 900, height: 900 })).toEqual(once);
  });

  it("does not mutate its input", () => {
    const input = legacy();
    freezeMetrics(input, { width: 400, height: 566 });
    expect(input.display.typeSize).toBeNull();
  });

  it("yields a valid payload, so what it freezes is what a re-validation keeps", () => {
    const frozen = freezeMetrics(legacy(), { width: 400, height: 566 });
    const { pin, warnings } = validatePin(frozen);
    expect(warnings).toEqual([]);
    expect(pin.display.typeSize).toBe(frozen.display.typeSize);
    expect(pin.display.margin).toBe(frozen.display.margin);
    expect(DEFAULT_MARGIN_EM).toBeGreaterThan(0);
  });
});

describe("effect normalisation", () => {
  it("rejects an effect id that is not a preset id", () => {
    for (const id of ["Not An Id", "-leading", "", "x".repeat(80)]) {
      expect(validatePin({ effect: { id } }).pin.effect.id, id).toBe("none");
    }
  });

  it("lowercases an otherwise valid id", () => {
    expect(validatePin({ effect: { id: "AgedParchment" } }).pin.effect.id).toBe("agedparchment");
  });

  it("keeps the seed an integer, since every client must glitch identically", () => {
    expect(validatePin({ effect: { seed: 12.7 } }).pin.effect.seed).toBe(13);
    expect(validatePin({ effect: { seed: -5 } }).pin.effect.seed).toBe(0);
  });

  it("clamps speed below the rate at which an animation reads as a strobe", () => {
    expect(validatePin({ effect: { speed: 50 } }).pin.effect.speed).toBe(4);
  });

  it("keeps grouped parameter overrides, nested as v14 stores them, and drops anything else", () => {
    const { pin, warnings } = validatePin({
      effect: {
        params: {
          blur: 4,
          "tint.amount": 0.5,
          "tint.color.deep.nested": "#fff",
          "../escape": 1,
          listValue: [1],
        },
      },
    });
    expect(pin.effect.params).toEqual({ blur: 4, tint: { amount: 0.5 } });
    expect(keys(warnings)).toContain("DP.pin.warn.droppedParams");
    expect(warnings.find((w) => w.key === "DP.pin.warn.droppedParams")?.data?.count).toBe(3);
  });

  it("bounds the number of parameter overrides a hand-edited flag can carry", () => {
    const params = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`blur${i}`, i]));
    const { pin } = validatePin({ effect: { params } });
    expect(Object.keys(pin.effect.params).length).toBe(64);
  });
});

describe("audience normalisation", () => {
  it("de-duplicates and bounds the user lists", () => {
    const { pin } = validatePin({
      audience: { kind: "selected", users: ["a", "a", "b", 7, null, "b"] },
    });
    expect(pin.audience.users).toEqual(["a", "b"]);
  });

  it("keeps a restore state only when one was actually stored", () => {
    expect(validatePin({ audience: { kind: "hidden" } }).pin.audience.restore).toBeNull();
    const { pin } = validatePin({
      audience: { kind: "hidden", restore: { kind: "selected", users: ["a"] } },
    });
    expect(pin.audience.restore).toEqual({ kind: "selected", users: ["a"] });
  });

  it("never restores to 'hidden', which would make the eye toggle a no-op", () => {
    const { pin } = validatePin({
      audience: { kind: "hidden", restore: { kind: "hidden", users: [] } },
    });
    expect(pin.audience.restore?.kind).toBe("everyone");
  });

  it("offers only LIMITED and OBSERVER for ownership sync — OWNER is never granted", () => {
    expect(
      validatePin({ audience: { ownershipSync: { level: 3 } } }).pin.audience.ownershipSync.level
    ).toBe(2);
    expect(
      validatePin({ audience: { ownershipSync: { level: 1 } } }).pin.audience.ownershipSync.level
    ).toBe(1);
    expect(
      validatePin({ audience: { ownershipSync: { level: 0 } } }).pin.audience.ownershipSync.level
    ).toBe(2);
  });
});

describe("interaction normalisation", () => {
  it("defaults to opening on double-click", () => {
    expect(validatePin({}).pin.interaction.open).toBe("double");
  });

  it("turns version 1's click-through into open: never, which is what it always meant", () => {
    const { pin } = validatePin({ interaction: { open: "double", clickThrough: true } });
    expect(pin.interaction.open).toBe("never");
  });

  it("falls back on an unknown open mode and says so", () => {
    const { pin, warnings } = validatePin({ interaction: { open: "triple" } });
    expect(pin.interaction.open).toBe("double");
    expect(warnings.find((w) => w.key === "DP.pin.warn.badEnum")?.data?.path).toBe(
      "interaction.open"
    );
  });
});

describe("retired keys", () => {
  // Version 1 stored four fields nothing read. A payload carrying them is not a
  // stranger's typo, so it is normalised without a word and the migration drops them.
  it("drops version 1's dead fields without warning about them", () => {
    const v1 = {
      ...goodPin(),
      display: { ...defaultPin().display, showLabel: true, labelPosition: "below" },
      interaction: { ...defaultPin().interaction, openPage: true, clickThrough: false },
    };
    const { pin, warnings } = validatePin(v1);
    expect(warnings).toEqual([]);
    expect(pin.display).not.toHaveProperty("showLabel");
    expect(pin.display).not.toHaveProperty("labelPosition");
    expect(pin.interaction).not.toHaveProperty("openPage");
    expect(pin.interaction).not.toHaveProperty("clickThrough");
  });

  it("still warns about a key that was never part of any schema", () => {
    const { warnings } = validatePin({ ...goodPin(), display: { glitter: true } });
    expect(warnings.map((w) => w.data?.path)).toContain("display.glitter");
  });
});

describe("round-tripping", () => {
  it("is idempotent: validating a validated pin changes nothing and warns about nothing", () => {
    const once = validatePin(goodPin()).pin;
    const twice = validatePin(once);
    expect(twice.pin).toEqual(once);
    expect(twice.warnings).toEqual([]);
    expect(twice.errors).toEqual([]);
  });

  it("validates the default pin cleanly apart from its deliberately absent source", () => {
    const { errors, warnings } = validatePin(defaultPin());
    expect(warnings).toEqual([]);
    expect(keys(errors)).toEqual(["DP.pin.error.missingSource"]);
  });
});

describe("geometry normalisation", () => {
  it("defaults both modes to 'derive it'", () => {
    expect(validatePin({}).pin.geometry).toEqual({ pin: null, prop: null });
  });

  it("remembers a size for each mode independently", () => {
    const { pin } = validatePin({
      geometry: { pin: { width: 100, height: 100 }, prop: { width: 800, height: 1100 } },
    });
    expect(pin.geometry.pin).toEqual({ width: 100, height: 100 });
    expect(pin.geometry.prop).toEqual({ width: 800, height: 1100 });
  });

  it("discards a half-specified size rather than honouring one axis", () => {
    expect(validatePin({ geometry: { prop: { width: 800 } } }).pin.geometry.prop).toBeNull();
    expect(
      validatePin({ geometry: { prop: { width: "800", height: 1100 } } }).pin.geometry.prop
    ).toBeNull();
  });

  it("clamps a size into the range a placeable can usefully occupy", () => {
    const { pin } = validatePin({ geometry: { prop: { width: 0, height: 1e9 } } });
    expect(pin.geometry.prop).toEqual({ width: 1, height: 65_536 });
  });
});

describe("mergePin", () => {
  const base = validatePin(goodPin()).pin;

  it("merges one field without disturbing its siblings", () => {
    const { pin } = mergePin(base, { display: { padding: 0.2 } });
    expect(pin.display.padding).toBe(0.2);
    expect(pin.display.paper).toBe(base.display.paper);
    expect(pin.source.uuid).toBe(base.source.uuid);
  });

  it("replaces arrays rather than merging them", () => {
    const withUsers = mergePin(base, { audience: { kind: "selected", users: ["a", "b"] } }).pin;
    const { pin } = mergePin(withUsers, { audience: { users: ["c"] } });
    expect(pin.audience.users).toEqual(["c"]);
  });

  it("re-validates, so a patch cannot persist an impossible value", () => {
    const { pin } = mergePin(base, { display: { padding: 99 } });
    expect(pin.display.padding).toBe(0.5);
  });

  it("can set a nullable field back to null", () => {
    const remembered = mergePin(base, { geometry: { prop: { width: 9, height: 9 } } }).pin;
    expect(mergePin(remembered, { geometry: { prop: null } }).pin.geometry.prop).toBeNull();
  });

  it("leaves the pin untouched for an empty patch", () => {
    expect(mergePin(base, {}).pin).toEqual(base);
  });
});

/**
 * The page fields.
 *
 * `pageId` and `pdfPage` were one field until schema 4, and the fold that separates them
 * lives in the normaliser rather than the migration — so these run on every read, on
 * every client, before any sweep. The empty-string case is the Pin Studio's "First page"
 * option: invisible, load-bearing, and the one thing that would silently store `""`.
 */
describe("the page fields", () => {
  const src = (over: Record<string, unknown>) =>
    validatePin({ ...goodPin(), source: { ...goodPin().source, ...over } }).pin.source;

  it("turns the empty option into null, which is what the Studio's 'First page' submits", () => {
    expect(src({ pageId: "" }).pageId).toBeNull();
  });

  it("keeps a real page id and caps an absurd one", () => {
    expect(src({ pageId: "aBcD1234eFgH5678" }).pageId).toBe("aBcD1234eFgH5678");
    expect(src({ pageId: "x".repeat(200) }).pageId).toHaveLength(64);
  });

  it("clamps and floors a PDF page, because half a page is not a page", () => {
    expect(src({ pdfPage: 3.7 }).pdfPage).toBe(3);
    expect(src({ pdfPage: 0 }).pdfPage).toBe(1);
    expect(src({ pdfPage: PDF_PAGE_MAX + 5 }).pdfPage).toBe(PDF_PAGE_MAX);
    expect(src({ pdfPage: "nope" }).pdfPage).toBeNull();
  });

  it("folds a legacy numeric pageId into pdfPage, as clickThrough folded into open", () => {
    const s = src({ pageId: "7" });
    expect(s.pdfPage).toBe(7);
    expect(s.pageId).toBeNull();
  });

  it("never folds a Foundry id, which is sixteen characters and can contain digits", () => {
    const s = src({ pageId: "1234567890123456" });
    expect(s.pageId).toBe("1234567890123456");
    expect(s.pdfPage).toBeNull();
  });

  it("lets an explicit pdfPage win, so re-reading a folded payload is stable", () => {
    expect(src({ pageId: "7", pdfPage: 2 }).pdfPage).toBe(2);
  });

  it("carries pdfPage in the defaults, so it raises no unknown-key warning", () => {
    expect(defaultPin().source.pdfPage).toBeNull();
    expect(validatePin(goodPin()).warnings).toEqual([]);
  });
});
