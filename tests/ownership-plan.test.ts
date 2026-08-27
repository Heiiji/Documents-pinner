import { describe, expect, it } from "vitest";
import {
  emptyLedger,
  keysHeldBy,
  planGrant,
  planRebase,
  planRelease,
  planRetarget,
  type OwnershipRecord,
} from "../src/data/ownership-plan";

const OBSERVER = 2;
const OWNER = 3;
const A = "Scene.s1.Tile.a";
const B = "Scene.s1.Tile.b";

/** Apply a plan's diff to an ownership record the way Foundry's update would. */
function apply(current: OwnershipRecord, diff: Record<string, number | null> | null) {
  const next: OwnershipRecord = { ...current };
  for (const [k, v] of Object.entries(diff ?? {})) {
    if (k.startsWith("-=")) delete next[k.slice(2)];
    else if (v !== null) next[k] = v;
  }
  return next;
}

describe("planGrant", () => {
  it("raises an absent user key and records null as its baseline", () => {
    const current: OwnershipRecord = { default: 0 };
    const plan = planGrant(current, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });

    expect(plan.ownership).toEqual({ ali: OBSERVER });
    expect(plan.ledger!.baseline.ali).toBeNull();
    expect(plan.ledger!.granted.ali).toBe(OBSERVER);
    expect(plan.ledger!.holders.ali).toEqual({ [A]: OBSERVER });
  });

  it("never lowers a level that was already higher", () => {
    const current: OwnershipRecord = { default: 0, ali: OWNER };
    const plan = planGrant(current, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });

    expect(plan.ownership).toBeNull();
    expect(plan.ledger!.baseline.ali).toBe(OWNER);
    expect(plan.ledger!.granted.ali).toBe(OWNER);
  });

  it("is idempotent for the same anchor and key", () => {
    const current: OwnershipRecord = { default: 0 };
    const first = planGrant(current, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const after = apply(current, first.ownership);
    const second = planGrant(after, first.ledger, { anchorUuid: A, keys: ["ali"], level: OBSERVER });

    expect(second.ownership).toBeNull();
    expect(second.ledger!.holders.ali).toEqual({ [A]: OBSERVER });
  });

  it("uses the default key to reach everyone at once", () => {
    const plan = planGrant({ default: 0 }, null, {
      anchorUuid: A,
      keys: ["default"],
      level: OBSERVER,
    });
    expect(plan.ownership).toEqual({ default: OBSERVER });
  });
});

describe("grant -> release round trip", () => {
  it("restores the exact prior state, deleting a key that did not exist before", () => {
    const before: OwnershipRecord = { default: 0, ben: 1 };

    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const during = apply(before, g.ownership);
    expect(during).toEqual({ default: 0, ben: 1, ali: OBSERVER });

    const r = planRelease(during, g.ledger, A);
    expect(r.ownership).toEqual({ "-=ali": null });
    expect(r.ledger).toBeNull();
    expect(apply(during, r.ownership)).toEqual(before);
  });

  it("restores a pre-existing lower level rather than deleting the key", () => {
    const before: OwnershipRecord = { default: 0, ali: 1 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const during = apply(before, g.ownership);

    const r = planRelease(during, g.ledger, A);
    expect(r.ownership).toEqual({ ali: 1 });
    expect(apply(during, r.ownership)).toEqual(before);
  });

  it("leaves the default key at its original value", () => {
    const before: OwnershipRecord = { default: 1 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["default"], level: OBSERVER });
    const during = apply(before, g.ownership);
    const r = planRelease(during, g.ledger, A);
    expect(apply(during, r.ownership)).toEqual(before);
  });
});

describe("two anchors sharing one key", () => {
  it("keeps the grant alive until the last holder releases", () => {
    const before: OwnershipRecord = { default: 0 };

    const g1 = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    let state = apply(before, g1.ownership);
    const g2 = planGrant(state, g1.ledger, { anchorUuid: B, keys: ["ali"], level: OBSERVER });
    state = apply(state, g2.ownership);

    expect(state.ali).toBe(OBSERVER);
    expect(Object.keys(g2.ledger!.holders.ali)).toEqual([A, B]);

    const r1 = planRelease(state, g2.ledger, A);
    state = apply(state, r1.ownership);
    expect(state.ali).toBe(OBSERVER); // B still holds it
    expect(r1.ledger).not.toBeNull();

    const r2 = planRelease(state, r1.ledger, B);
    state = apply(state, r2.ownership);
    expect(state).toEqual(before);
    expect(r2.ledger).toBeNull();
  });

  it("drops back to the lower level when the higher-level holder leaves", () => {
    const before: OwnershipRecord = { default: 0 };
    const g1 = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: 1 });
    let state = apply(before, g1.ownership);
    const g2 = planGrant(state, g1.ledger, { anchorUuid: B, keys: ["ali"], level: OBSERVER });
    state = apply(state, g2.ownership);
    expect(state.ali).toBe(OBSERVER);

    const r = planRelease(state, g2.ledger, B);
    state = apply(state, r.ownership);
    expect(state.ali).toBe(1);
  });
});

describe("a manual GM edit always wins", () => {
  it("leaves ownership untouched on release and reports it", () => {
    const before: OwnershipRecord = { default: 0 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    let state = apply(before, g.ownership);

    // The GM raises Ali to Owner by hand, outside the module.
    state = { ...state, ali: OWNER };

    const r = planRelease(state, g.ledger, A);
    expect(r.ownership).toBeNull();
    expect(r.notices.map((n) => n.key)).toContain("DP.notice.ownershipOverridden");
    expect(apply(state, r.ownership).ali).toBe(OWNER);
  });

  it("adopts a raise so a later release still restores the baseline", () => {
    const before: OwnershipRecord = { default: 0, ali: 1 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    let state = apply(before, g.ownership);

    state = { ...state, ali: OWNER };
    const rebased = planRebase(g.ledger, { ali: OWNER });
    expect(rebased.ledger!.granted.ali).toBe(OWNER);

    const r = planRelease(state, rebased.ledger, A);
    expect(r.ownership).toEqual({ ali: 1 });
    expect(apply(state, r.ownership)).toEqual(before);
  });

  it("treats a lowering as both the new floor and the new ceiling", () => {
    const before: OwnershipRecord = { default: 0 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    let state = apply(before, g.ownership);

    state = { ...state, ali: 1 };
    const rebased = planRebase(g.ledger, { ali: 1 });
    expect(rebased.ledger!.baseline.ali).toBe(1);
    expect(rebased.ledger!.overridden).toContain("ali");

    const r = planRelease(state, rebased.ledger, A);
    expect(apply(state, r.ownership).ali).toBe(1);
  });

  it("handles the GM deleting a key we were holding", () => {
    const g = planGrant({ default: 0 }, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const rebased = planRebase(g.ledger, { "-=ali": null });
    expect(rebased.ledger!.baseline.ali).toBeNull();
    expect(rebased.ledger!.overridden).toContain("ali");
  });

  it("rebases a key we do not hold without inventing bookkeeping", () => {
    const g = planGrant({ default: 0 }, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const rebased = planRebase(g.ledger, { ben: OWNER });
    expect(rebased.ledger!.baseline.ben).toBeUndefined();
    expect(rebased.notices).toEqual([]);
  });
});

describe("planRetarget", () => {
  it("moves a pin from one player to another in a single plan", () => {
    const before: OwnershipRecord = { default: 0 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const state = apply(before, g.ownership);

    const plan = planRetarget(state, g.ledger, { anchorUuid: A, keys: ["ben"], level: OBSERVER });
    const after = apply(state, plan.ownership);

    expect(after).toEqual({ default: 0, ben: OBSERVER });
    expect(keysHeldBy(plan.ledger, A)).toEqual(["ben"]);
  });

  it("never transiently revokes a key present in both the old and new sets", () => {
    const before: OwnershipRecord = { default: 0 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali", "ben"], level: OBSERVER });
    const state = apply(before, g.ownership);

    const plan = planRetarget(state, g.ledger, {
      anchorUuid: A,
      keys: ["ali", "cleo"],
      level: OBSERVER,
    });
    const after = apply(state, plan.ownership);

    expect(after.ali).toBe(OBSERVER);
    expect(after.cleo).toBe(OBSERVER);
    expect(after.ben).toBeUndefined();
  });

  it("releases everything when retargeting to an empty audience", () => {
    const before: OwnershipRecord = { default: 0 };
    const g = planGrant(before, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const state = apply(before, g.ownership);

    const plan = planRetarget(state, g.ledger, { anchorUuid: A, keys: [], level: OBSERVER });
    expect(apply(state, plan.ownership)).toEqual(before);
    expect(plan.ledger).toBeNull();
  });
});

describe("robustness", () => {
  it("releasing an unknown anchor is a no-op, not a throw", () => {
    const g = planGrant({ default: 0 }, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const r = planRelease({ default: 0, ali: OBSERVER }, g.ledger, "Scene.s1.Tile.zzz");
    expect(r.ownership).toBeNull();
    expect(r.ledger).not.toBeNull();
  });

  it("tolerates a missing ledger", () => {
    expect(planRelease({ default: 0 }, null, A)).toEqual({
      ownership: null,
      ledger: null,
      notices: [],
    });
    expect(planRebase(null, { ali: 2 }).ledger).toBeNull();
  });

  it("tolerates a partially corrupt ledger without throwing", () => {
    const broken = { ...emptyLedger(), granted: { ali: 2 } } as never;
    expect(() => planRelease({ default: 0 }, broken, A)).not.toThrow();
  });

  it("does not mutate the ledger it was given", () => {
    const g = planGrant({ default: 0 }, null, { anchorUuid: A, keys: ["ali"], level: OBSERVER });
    const snapshot = JSON.stringify(g.ledger);
    planRelease({ default: 0, ali: OBSERVER }, g.ledger, A);
    planRebase(g.ledger, { ali: OWNER });
    expect(JSON.stringify(g.ledger)).toBe(snapshot);
  });
});
