import { describe, expect, it } from "vitest";
import {
  anchorHidden,
  canSee,
  cycleAudience,
  grantKeysFor,
  makeAudience,
  setUserVisible,
  shouldRecordDiscovery,
  soloUser,
  toggleVisibility,
} from "../src/data/audience";

const PLAYERS = ["ali", "ben", "cleo"];
const gm = { isGM: true, userId: "gm", hidden: false };
const ali = { isGM: false, userId: "ali", hidden: false };
const ben = { isGM: false, userId: "ben", hidden: false };

describe("canSee", () => {
  it("always shows to the GM, including hidden pins", () => {
    expect(canSee(makeAudience({ kind: "hidden" }), gm)).toBe(true);
    expect(canSee(makeAudience({ kind: "everyone" }), { ...gm, hidden: true })).toBe(true);
  });

  it("hides from players when the core hidden field is set, whatever the kind", () => {
    for (const kind of ["everyone", "selected", "discovered"] as const) {
      const a = makeAudience({ kind, users: PLAYERS, discovered: PLAYERS });
      expect(canSee(a, { ...ali, hidden: true })).toBe(false);
    }
  });

  it("shows to everyone", () => {
    expect(canSee(makeAudience({ kind: "everyone" }), ali)).toBe(true);
    expect(canSee(makeAudience({ kind: "everyone" }), ben)).toBe(true);
  });

  it("shows only to listed users when selected", () => {
    const a = makeAudience({ kind: "selected", users: ["ali"] });
    expect(canSee(a, ali)).toBe(true);
    expect(canSee(a, ben)).toBe(false);
  });

  it("requires line of sight when discovered and not yet found", () => {
    const a = makeAudience({ kind: "discovered", sticky: true, discovered: [] });
    expect(canSee(a, ali)).toBe(false);
    expect(canSee(a, { ...ali, hasLineOfSight: true })).toBe(true);
  });

  it("keeps a sticky discovery after line of sight is lost", () => {
    const a = makeAudience({ kind: "discovered", sticky: true, discovered: ["ali"] });
    expect(canSee(a, ali)).toBe(true);
    expect(canSee(a, ben)).toBe(false);
  });

  it("forgets a non-sticky discovery once line of sight is lost", () => {
    const a = makeAudience({ kind: "discovered", sticky: false, discovered: ["ali"] });
    expect(canSee(a, ali)).toBe(false);
    expect(canSee(a, { ...ali, hasLineOfSight: true })).toBe(true);
  });
});

describe("shouldRecordDiscovery", () => {
  it("records a new sticky discovery for a player with line of sight", () => {
    const a = makeAudience({ kind: "discovered", sticky: true, discovered: [] });
    expect(shouldRecordDiscovery(a, { ...ali, hasLineOfSight: true })).toBe(true);
  });

  it("does not record twice, for the GM, or without line of sight", () => {
    const a = makeAudience({ kind: "discovered", sticky: true, discovered: ["ali"] });
    expect(shouldRecordDiscovery(a, { ...ali, hasLineOfSight: true })).toBe(false);
    expect(shouldRecordDiscovery(a, { ...gm, hasLineOfSight: true })).toBe(false);
    expect(shouldRecordDiscovery(a, ben)).toBe(false);
  });

  it("never records for a non-sticky audience", () => {
    const a = makeAudience({ kind: "discovered", sticky: false });
    expect(shouldRecordDiscovery(a, { ...ali, hasLineOfSight: true })).toBe(false);
  });
});

describe("toggleVisibility", () => {
  it("remembers a per-player selection across a hide/show round trip", () => {
    const start = makeAudience({ kind: "selected", users: ["ali", "cleo"] });
    const hidden = toggleVisibility(start);
    expect(hidden.kind).toBe("hidden");
    expect(anchorHidden(hidden)).toBe(true);

    const shown = toggleVisibility(hidden);
    expect(shown.kind).toBe("selected");
    expect(shown.users).toEqual(["ali", "cleo"]);
    expect(shown.restore).toBeNull();
  });

  it("defaults to everyone when there is nothing remembered", () => {
    expect(toggleVisibility(makeAudience({ kind: "hidden" })).kind).toBe("everyone");
  });
});

describe("setUserVisible", () => {
  it("narrows everyone to an explicit list when one user is removed", () => {
    const a = setUserVisible(makeAudience({ kind: "everyone" }), "ben", false, PLAYERS);
    expect(a.kind).toBe("selected");
    expect(a.users).toEqual(["ali", "cleo"]);
  });

  it("widens back to everyone when the last missing user is added", () => {
    const a = setUserVisible(
      makeAudience({ kind: "selected", users: ["ali", "cleo"] }),
      "ben",
      true,
      PLAYERS
    );
    expect(a.kind).toBe("everyone");
    expect(a.users).toEqual([]);
  });

  it("normalises an emptied selection to hidden so the core field carries the state", () => {
    const a = setUserVisible(makeAudience({ kind: "selected", users: ["ali"] }), "ali", false, PLAYERS);
    expect(a.kind).toBe("hidden");
    expect(anchorHidden(a)).toBe(true);
  });

  it("preserves the order of allPlayerIds rather than click order", () => {
    let a = makeAudience({ kind: "hidden" });
    a = setUserVisible(a, "cleo", true, PLAYERS);
    a = setUserVisible(a, "ali", true, PLAYERS);
    expect(a.users).toEqual(["ali", "cleo"]);
  });

  it("derives the starting set from discovered when the kind is discovered", () => {
    const a = setUserVisible(
      makeAudience({ kind: "discovered", discovered: ["ali"] }),
      "ben",
      true,
      PLAYERS
    );
    expect(a.users).toEqual(["ali", "ben"]);
  });
});

describe("soloUser and cycleAudience", () => {
  it("solos to exactly one user", () => {
    const a = soloUser(makeAudience({ kind: "everyone" }), "ben");
    expect(a.kind).toBe("selected");
    expect(a.users).toEqual(["ben"]);
  });

  it("cycles everyone -> selected -> hidden -> everyone when a selection is remembered", () => {
    let a = makeAudience({ kind: "everyone", restore: { kind: "selected", users: ["ali"] } });
    a = cycleAudience(a);
    expect(a.kind).toBe("selected");
    expect(a.users).toEqual(["ali"]);
    a = cycleAudience(a);
    expect(a.kind).toBe("hidden");
    a = cycleAudience(a);
    expect(a.kind).toBe("everyone");
  });

  it("skips the selected step when there is no meaningful per-player list", () => {
    let a = makeAudience({ kind: "everyone" });
    a = cycleAudience(a);
    expect(a.kind).toBe("hidden");
    a = cycleAudience(a);
    expect(a.kind).toBe("everyone");
  });

  it("never cycles into a selection that nobody is in", () => {
    let a = makeAudience({ kind: "everyone" });
    for (let i = 0; i < 6; i++) {
      a = cycleAudience(a);
      if (a.kind === "selected") expect(a.users.length).toBeGreaterThan(0);
    }
  });

  it("escapes from discovered to everyone", () => {
    expect(cycleAudience(makeAudience({ kind: "discovered" })).kind).toBe("everyone");
  });
});

describe("grantKeysFor", () => {
  it("uses the default key for everyone", () => {
    expect(grantKeysFor(makeAudience({ kind: "everyone" }), PLAYERS)).toEqual(["default"]);
  });

  it("returns nothing for hidden", () => {
    expect(grantKeysFor(makeAudience({ kind: "hidden" }), PLAYERS)).toEqual([]);
  });

  it("filters out stale user ids that no longer exist", () => {
    const a = makeAudience({ kind: "selected", users: ["ali", "deleted-user"] });
    expect(grantKeysFor(a, PLAYERS)).toEqual(["ali"]);
  });

  it("grants to discovered users only", () => {
    const a = makeAudience({ kind: "discovered", discovered: ["ben"] });
    expect(grantKeysFor(a, PLAYERS)).toEqual(["ben"]);
  });
});
