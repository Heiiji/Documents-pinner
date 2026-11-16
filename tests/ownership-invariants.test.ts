import { expect, it } from "vitest";
import {
  planGrant,
  planRelease,
  type OwnershipDiff,
  type OwnershipRecord,
} from "../src/data/ownership-plan";

function apply(own: OwnershipRecord, diff: OwnershipDiff | null): OwnershipRecord {
  const next = { ...own };
  for (const [key, value] of Object.entries(diff ?? {})) {
    if (key.startsWith("-=")) delete next[key.slice(2)];
    else if (value !== null) next[key] = value;
  }
  return next;
}

// Foundry resolves a user's entry, then the default, then the parent for INHERIT (-1).
function effective(own: OwnershipRecord, key: string, parent: OwnershipRecord): number {
  const value = own[key] ?? own.default ?? 0;
  return value === -1 ? (parent[key] ?? parent.default ?? 0) : value;
}

it("preserves existing access and restores ownership across defaults, inheritance and holders", () => {
  for (const defaultLevel of [-1, 0, 1, 2, 3]) {
    for (const userLevel of [undefined, -1, 0, 1, 2, 3]) {
      for (const parentDefault of [0, 1, 2, 3]) {
        for (const parentUser of [undefined, 0, 1, 2, 3]) {
          for (const keys of [["ali"], ["default"]]) {
            const baseline = {
              default: defaultLevel,
              ...(userLevel === undefined ? {} : { ali: userLevel }),
            };
            const parent = {
              default: parentDefault,
              ...(parentUser === undefined ? {} : { ali: parentUser }),
            };
            const context = JSON.stringify({ baseline, parent, keys });
            const first = planGrant(baseline, null, { anchorUuid: "a", keys, level: 2 }, parent);
            const afterFirst = apply(baseline, first.ownership);
            for (const user of ["ali", "ben"]) {
              expect(effective(afterFirst, user, parent), context).toBeGreaterThanOrEqual(
                effective(baseline, user, parent)
              );
            }
            if (keys[0] === "ali") {
              expect(effective(afterFirst, "ali", parent), context).toBeGreaterThanOrEqual(2);
            }
            const released = planRelease(afterFirst, first.ledger, "a", undefined, parent);
            expect(apply(afterFirst, released.ownership), context).toEqual(baseline);

            const second = planGrant(
              afterFirst,
              first.ledger,
              { anchorUuid: "b", keys: ["ali"], level: 1 },
              parent
            );
            const afterSecond = apply(afterFirst, second.ownership);
            const releaseFirst = planRelease(afterSecond, second.ledger, "a", undefined, parent);
            const remaining = apply(afterSecond, releaseFirst.ownership);
            expect(effective(remaining, "ali", parent), context).toBeGreaterThanOrEqual(
              Math.max(1, effective(baseline, "ali", parent))
            );
            const releaseSecond = planRelease(
              remaining,
              releaseFirst.ledger,
              "b",
              undefined,
              parent
            );
            expect(apply(remaining, releaseSecond.ownership), context).toEqual(baseline);
          }
        }
      }
    }
  }
});
