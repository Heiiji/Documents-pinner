/**
 * The reveal rule, alone.
 *
 * `revealed` is the one answer to "what does a reveal write?" — the eye, the Pinboard's
 * bulk bar, "Reveal all", Reveal next, spotlight and the Studio's resume all ask it. The
 * bulk paths used to answer `everyone` for themselves, so these are table-driven: every
 * audience a pin can hold, and what each path must agree on.
 */
import { describe, expect, it } from "vitest";
import {
  makeAudience,
  pingsEveryone,
  resumeAfterEdit,
  revealed,
  sameAudience,
  toggleVisibility,
  wouldReveal,
} from "../src/data/audience";
import type { DpAudience } from "../src/types/dp";

const PLAYERS = ["ali", "ben"];

const hidden = (restore: DpAudience["restore"]) => makeAudience({ kind: "hidden", restore });

/** A hidden audience, and the audience its reveal must come back as. */
const HIDDEN: [string, DpAudience, Pick<DpAudience, "kind" | "users">][] = [
  ["nothing remembered", hidden(null), { kind: "everyone", users: [] }],
  ["everyone remembered", hidden({ kind: "everyone", users: [] }), { kind: "everyone", users: [] }],
  [
    "one player",
    hidden({ kind: "selected", users: ["ali"] }),
    { kind: "selected", users: ["ali"] },
  ],
  [
    "two players",
    hidden({ kind: "selected", users: ["ali", "ben"] }),
    { kind: "selected", users: ["ali", "ben"] },
  ],
  // An empty remembered list means nobody, which would be hidden again.
  ["an empty selection", hidden({ kind: "selected", users: [] }), { kind: "everyone", users: [] }],
  ["line of sight", hidden({ kind: "discovered", users: [] }), { kind: "discovered", users: [] }],
];

const SHOWING: [string, DpAudience][] = [
  ["everyone", makeAudience({ kind: "everyone" })],
  ["one player", makeAudience({ kind: "selected", users: ["ali"] })],
  ["a selection naming nobody", makeAudience({ kind: "selected", users: [] })],
  ["line of sight", makeAudience({ kind: "discovered", discovered: ["ben"] })],
];

describe("revealed", () => {
  it.each(HIDDEN)("restores what a hidden pin remembers: %s", (_name, audience, expected) => {
    const next = revealed(audience);
    expect(next).toMatchObject(expected);
    expect(next.restore).toBeNull();
    // Nothing else about the audience moves.
    expect(next.ownershipSync).toEqual(audience.ownershipSync);
    expect(next.sticky).toBe(audience.sticky);
  });

  it.each(SHOWING)("leaves an audience that is not hidden equal: %s", (_name, audience) => {
    expect(revealed(audience)).toEqual(audience);
    expect(revealed(audience)).not.toBe(audience);
  });

  it.each(HIDDEN)("is idempotent, never a toggle: %s", (_name, audience) => {
    expect(revealed(revealed(audience))).toEqual(revealed(audience));
  });

  it.each(HIDDEN)("is exactly what the eye does to a hidden pin: %s", (_name, audience) => {
    expect(toggleVisibility(audience)).toEqual(revealed(audience));
  });

  it("does not share the remembered list with the result", () => {
    const audience = hidden({ kind: "selected", users: ["ali"] });
    revealed(audience).users.push("ben");
    expect(audience.restore?.users).toEqual(["ali"]);
  });
});

describe("wouldReveal", () => {
  it("counts a hidden pin whose reveal reaches a player", () => {
    expect(wouldReveal(hidden({ kind: "selected", users: ["ali"] }), true, PLAYERS)).toBe(true);
    expect(wouldReveal(hidden(null), true, PLAYERS)).toBe(true);
  });

  it("does not count a pin already showing — there is nothing to reveal", () => {
    for (const [, audience] of SHOWING) expect(wouldReveal(audience, false, PLAYERS)).toBe(false);
  });

  it("counts a pin whose core hidden flag is set whatever its kind says", () => {
    expect(wouldReveal(makeAudience({ kind: "everyone" }), true, PLAYERS)).toBe(true);
  });

  it("does not count a reveal that would reach nobody", () => {
    expect(wouldReveal(hidden({ kind: "selected", users: ["gone"] }), true, PLAYERS)).toBe(false);
    expect(wouldReveal(makeAudience({ kind: "selected", users: [] }), true, PLAYERS)).toBe(false);
  });
});

describe("sameAudience", () => {
  it("ignores the order of a list", () => {
    const a = makeAudience({ kind: "selected", users: ["ali", "ben"] });
    const b = makeAudience({ kind: "selected", users: ["ben", "ali"] });
    expect(sameAudience(a, b)).toBe(true);
  });

  it("tells apart the kind, the list and the memory", () => {
    const base = hidden({ kind: "selected", users: ["ali"] });
    expect(sameAudience(base, { ...base, kind: "everyone" })).toBe(false);
    expect(sameAudience(base, { ...base, users: ["ali"] })).toBe(false);
    expect(sameAudience(base, { ...base, restore: null })).toBe(false);
    expect(sameAudience(base, { ...base, restore: { kind: "selected", users: ["ben"] } })).toBe(
      false
    );
    expect(sameAudience(base, { ...base, restore: { kind: "everyone", users: ["ali"] } })).toBe(
      false
    );
    expect(sameAudience(base, { ...base, restore: { kind: "selected", users: ["ali"] } })).toBe(
      true
    );
  });
});

/** K1: the one audience whose location every client may be shown. */
describe("pingsEveryone", () => {
  it.each([
    ["everyone", makeAudience({ kind: "everyone" }), true],
    ["one player", makeAudience({ kind: "selected", users: ["ali"] }), false],
    ["every player, listed", makeAudience({ kind: "selected", users: PLAYERS }), false],
    ["line of sight", makeAudience({ kind: "discovered", discovered: PLAYERS }), false],
    ["hidden", hidden({ kind: "everyone", users: [] }), false],
  ])("%s", (_name, audience, expected) => {
    expect(pingsEveryone(audience)).toBe(expected);
  });
});

/**
 * "Hide while I edit", ended: the reveal again, only while the pin is exactly as the hold
 * left it. A pin the GM revealed or re-hid by hand meanwhile is theirs.
 */
describe("resumeAfterEdit", () => {
  const forAli = makeAudience({ kind: "selected", users: ["ali", "ben"] });
  const held = toggleVisibility(forAli);

  it("reveals again to the players the hold remembered", () => {
    expect(resumeAfterEdit(held, held.restore)).toEqual(revealed(held));
    expect(resumeAfterEdit(held, held.restore)).toMatchObject({
      kind: "selected",
      users: ["ali", "ben"],
      restore: null,
    });
  });

  it("does not care in which order the remembered list was written", () => {
    expect(resumeAfterEdit(held, { kind: "selected", users: ["ben", "ali"] })).not.toBeNull();
  });

  it("leaves alone a pin revealed again by hand", () => {
    expect(resumeAfterEdit(forAli, held.restore)).toBeNull();
    expect(resumeAfterEdit(makeAudience({ kind: "everyone" }), held.restore)).toBeNull();
  });

  it("leaves alone a pin hidden again by hand over a different audience", () => {
    const rehidden = toggleVisibility(makeAudience({ kind: "everyone" }));
    expect(resumeAfterEdit(rehidden, held.restore)).toBeNull();
    const narrower = toggleVisibility(makeAudience({ kind: "selected", users: ["ali"] }));
    expect(resumeAfterEdit(narrower, held.restore)).toBeNull();
  });

  it("is a single effect: once resumed, a second resume finds nothing to do", () => {
    const once = resumeAfterEdit(held, held.restore)!;
    expect(resumeAfterEdit(once, held.restore)).toBeNull();
  });
});
