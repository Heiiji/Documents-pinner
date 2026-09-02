import { describe, expect, it } from "vitest";
import {
  dropIndex,
  filterRows,
  focusIndex,
  fold,
  levelsIn,
  planReorder,
  rangeSelect,
  summarise,
  toggleSelection,
  type PinboardRow,
} from "../src/apps/pinboard-model";

function row(overrides: Partial<PinboardRow> = {}): PinboardRow {
  return {
    id: "r1",
    name: "The Duke's Letter",
    breadcrumb: "Ashen Keep › Letters",
    mode: "prop",
    visible: true,
    effectId: "aged-parchment",
    effectLabel: "Aged Parchment",
    sort: 0,
    elevation: 0,
    locked: false,
    thumbnail: null,
    users: [],
    ...overrides,
  };
}

const user = (canSee: boolean, canOpen: boolean) => ({
  id: "u",
  name: "Ali",
  color: "#fff",
  avatar: null,
  canSee,
  canOpen,
});

const q = (over: Partial<Parameters<typeof filterRows>[1]> = {}) => ({
  filter: "all" as const,
  search: "",
  level: null,
  ...over,
});

describe("fold", () => {
  it("folds case and diacritics so a hurried search still matches", () => {
    expect(fold("Épée")).toBe("epee");
    expect(fold("CRÈME brûlée")).toBe("creme brulee");
  });

  it("survives empty and non-string input", () => {
    expect(fold("")).toBe("");
    expect(fold(undefined as any)).toBe("");
  });
});

describe("filterRows", () => {
  const rows = [
    row({ id: "a", name: "Épée du Duc", visible: true, mode: "prop", elevation: 0 }),
    row({ id: "b", name: "Warded Door", visible: false, mode: "pin", elevation: 20 }),
    row({ id: "c", name: "Ransom note", visible: false, mode: "prop", elevation: 20 }),
  ];

  it("returns everything by default", () => {
    expect(filterRows(rows, q()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by visibility and by mode", () => {
    expect(filterRows(rows, q({ filter: "visible" })).map((r) => r.id)).toEqual(["a"]);
    expect(filterRows(rows, q({ filter: "hidden" })).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterRows(rows, q({ filter: "pins" })).map((r) => r.id)).toEqual(["b"]);
    expect(filterRows(rows, q({ filter: "props" })).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("searches the name and the breadcrumb, ignoring accents", () => {
    expect(filterRows(rows, q({ search: "epee" })).map((r) => r.id)).toEqual(["a"]);
    expect(filterRows(rows, q({ search: "ashen" })).length).toBe(3);
    expect(filterRows(rows, q({ search: "  " })).length).toBe(3);
  });

  it("combines a filter, a search and a level", () => {
    expect(
      filterRows(rows, q({ filter: "hidden", level: 20, search: "ransom" })).map((r) => r.id)
    ).toEqual(["c"]);
  });

  it("never reorders, so the list stays the order the GM arranged", () => {
    const reversed = [...rows].reverse();
    expect(filterRows(reversed, q()).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

describe("rangeSelect", () => {
  const rows = ["a", "b", "c", "d"].map((id) => row({ id }));

  it("covers the rows between the two ends, inclusive", () => {
    expect(rangeSelect(rows, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("works the same dragged upwards", () => {
    expect(rangeSelect(rows, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("selects one row when both ends are the same", () => {
    expect(rangeSelect(rows, "c", "c")).toEqual(["c"]);
  });

  it("follows the visible rows, not the rows hidden underneath a filter", () => {
    const visible = [row({ id: "a" }), row({ id: "d" })];
    expect(rangeSelect(visible, "a", "d")).toEqual(["a", "d"]);
  });

  it("degrades to the end that still exists when the other was filtered away", () => {
    expect(rangeSelect(rows, "a", "zz")).toEqual(["a"]);
    expect(rangeSelect(rows, "zz", "yy")).toEqual([]);
  });
});

describe("toggleSelection", () => {
  it("adds and removes", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("planReorder", () => {
  const rows = ["a", "b", "c"].map((id, i) => row({ id, sort: i * 10 }));

  it("writes nothing when a row is dropped where it started", () => {
    expect(planReorder(rows, "b", 1)).toEqual([]);
  });

  it("moves a row to the front and renumbers only what changed", () => {
    expect(planReorder(rows, "c", 0)).toEqual([
      { id: "c", sort: 0 },
      { id: "a", sort: 10 },
      { id: "b", sort: 20 },
    ]);
  });

  it("clamps a drop past either end instead of losing the row", () => {
    expect(planReorder(rows, "a", 99).map((u) => u.id)).toEqual(["b", "c", "a"]);
    expect(planReorder(rows, "c", -5).map((u) => u.id)).toEqual(["c", "a", "b"]);
  });

  it("never leaves two rows sharing a sort value", () => {
    const messy = ["a", "b", "c"].map((id) => row({ id, sort: 5 }));
    const updates = planReorder(messy, "c", 0);
    const sorts = updates.map((u) => u.sort);
    expect(new Set(sorts).size).toBe(sorts.length);
  });

  it("ignores a row that is not in the list", () => {
    expect(planReorder(rows, "zz", 0)).toEqual([]);
  });
});

describe("summarise", () => {
  it("counts what the footer shows", () => {
    const rows = [
      row({ visible: true, mode: "prop" }),
      row({ visible: false, mode: "pin" }),
      row({ visible: true, mode: "pin" }),
    ];
    expect(summarise(rows)).toEqual({
      total: 3,
      visible: 2,
      hidden: 1,
      props: 1,
      pins: 2,
      mismatched: 0,
    });
  });

  it("counts a row where presence and access disagree, in either direction", () => {
    const rows = [
      row({ users: [user(true, false)] }),
      row({ users: [user(false, true)] }),
      row({ users: [user(true, true)] }),
    ];
    expect(summarise(rows).mismatched).toBe(2);
  });
});

describe("levelsIn", () => {
  it("offers each real level once, in order", () => {
    const rows = [row({ elevation: 20 }), row({ elevation: 0 }), row({ elevation: 20 })];
    expect(levelsIn(rows)).toEqual([0, 20]);
  });
});

describe("focusIndex", () => {
  it("clamps rather than wrapping, so the position is never lost", () => {
    expect(focusIndex(3, 2, 1)).toBe(2);
    expect(focusIndex(3, 0, -1)).toBe(0);
  });

  it("enters the list from whichever end the key implies", () => {
    expect(focusIndex(3, -1, 1)).toBe(0);
    expect(focusIndex(3, -1, -1)).toBe(2);
  });

  it("reports no focus for an empty list", () => {
    expect(focusIndex(0, -1, 1)).toBe(-1);
  });
});

describe("the mismatch filter", () => {
  it("keeps only the rows where someone can see the pin but not open the document", () => {
    const rows = [
      row({ id: "ok", users: [user(true, true)] }),
      row({ id: "stuck", users: [user(true, false)] }),
      row({ id: "hidden", users: [user(false, false)] }),
    ];
    const visible = filterRows(rows, { filter: "mismatch", search: "", level: null });
    expect(visible.map((r) => r.id)).toEqual(["stuck"]);
  });
});

describe("dropIndex", () => {
  const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
  const order = (movedId: string, targetId: string, after: boolean) =>
    (() => {
      const index = dropIndex(rows, movedId, targetId, after);
      const next = rows.filter((r) => r.id !== movedId);
      next.splice(
        index,
        0,
        rows.find((r) => r.id === movedId)!
      );
      return next.map((r) => r.id);
    })();

  it("lands after the row under the pointer when the line was below it", () => {
    expect(order("a", "b", true)).toEqual(["b", "a", "c"]);
  });

  it("lands before it when the line was above", () => {
    expect(order("c", "a", false)).toEqual(["c", "a", "b"]);
  });

  it("lands exactly where the line was whichever direction the row came from", () => {
    expect(order("a", "c", false)).toEqual(["b", "a", "c"]);
    expect(order("c", "b", false)).toEqual(["a", "c", "b"]);
  });
});
