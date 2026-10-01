/**
 * The reveal rule, alone.
 *
 * `revealed` is the one answer to "what does a reveal write?" — the eye, the Pinboard's
 * bulk bar, "Reveal all", Reveal next, spotlight and the Studio's resume all ask it. The
 * bulk paths used to answer `everyone` for themselves. The world paths are driven in
 * `pinboard-reveal`, `reveal-next`, `spotlight` and `edit-hold`; what is here is what
 * they cannot reach cheaply: every audience a pin can hold, and the edges of each rule.
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

describe("revealed", () => {
  /** A hidden audience, and the audience its reveal must come back as. */
  it.each([
    ["nothing remembered", hidden(null), { kind: "everyone", users: [] }],
    [
      "everyone remembered",
      hidden({ kind: "everyone", users: [] }),
      { kind: "everyone", users: [] },
    ],
    [
      "one player",
      hidden({ kind: "selected", users: ["ali"] }),
      { kind: "selected", users: ["ali"] },
    ],
    // An empty remembered list means nobody, which would be hidden again.
    [
      "an empty selection",
      hidden({ kind: "selected", users: [] }),
      { kind: "everyone", users: [] },
    ],
    ["line of sight", hidden({ kind: "discovered", users: [] }), { kind: "discovered", users: [] }],
  ] as const)(
    "restores what a hidden pin remembers, as the eye does, once: %s",
    (_name, audience, expected) => {
      const next = revealed(audience);
      expect(next).toMatchObject(expected);
      expect(next.restore).toBeNull();
      // Nothing else about the audience moves, and the remembered list is not shared.
      expect(next.ownershipSync).toEqual(audience.ownershipSync);
      expect(next.sticky).toBe(audience.sticky);
      if (audience.restore) expect(next.users).not.toBe(audience.restore.users);
      // The eye and every bulk path agree; and a second reveal is not a toggle.
      expect(toggleVisibility(audience)).toEqual(next);
      expect(revealed(next)).toEqual(next);
    }
  );

  it("leaves an audience that is not hidden equal, as a copy", () => {
    for (const audience of [
      makeAudience({ kind: "everyone" }),
      makeAudience({ kind: "selected", users: ["ali"] }),
      makeAudience({ kind: "selected", users: [] }),
      makeAudience({ kind: "discovered", discovered: ["ben"] }),
    ]) {
      expect(revealed(audience), audience.kind).toEqual(audience);
      expect(revealed(audience)).not.toBe(audience);
    }
  });
});

/**
 * What "Reveal all" counts before it asks. The counted and the not-counted cases a scene
 * can hold are driven in `pinboard-reveal`; these two are the anchor's own flag.
 */
describe("wouldReveal", () => {
  it("goes by the core hidden flag whatever the kind says, and never counts reaching nobody", () => {
    expect(wouldReveal(makeAudience({ kind: "everyone" }), true, PLAYERS)).toBe(true);
    expect(wouldReveal(makeAudience({ kind: "selected", users: [] }), true, PLAYERS)).toBe(false);
  });
});

describe("sameAudience", () => {
  it("ignores the order of a list, and tells apart the kind, the list and the memory", () => {
    const pair = makeAudience({ kind: "selected", users: ["ali", "ben"] });
    expect(sameAudience(pair, { ...pair, users: ["ben", "ali"] })).toBe(true);

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
  const forPair = makeAudience({ kind: "selected", users: ["ali", "ben"] });
  const held = toggleVisibility(forPair);

  it("reveals again to the players the hold remembered, in whatever order it wrote them", () => {
    expect(resumeAfterEdit(held, held.restore)).toEqual(revealed(held));
    expect(resumeAfterEdit(held, held.restore)).toMatchObject({
      kind: "selected",
      users: ["ali", "ben"],
      restore: null,
    });
    expect(resumeAfterEdit(held, { kind: "selected", users: ["ben", "ali"] })).not.toBeNull();
  });

  it("leaves alone a pin revealed or re-hidden by hand, and one already resumed", () => {
    const cases: [string, DpAudience][] = [
      ["revealed again by hand", forPair],
      ["revealed to everyone by hand", makeAudience({ kind: "everyone" })],
      ["hidden again over everyone", toggleVisibility(makeAudience({ kind: "everyone" }))],
      [
        "hidden again over a narrower list",
        toggleVisibility(makeAudience({ kind: "selected", users: ["ali"] })),
      ],
      ["already resumed", resumeAfterEdit(held, held.restore)!],
    ];
    for (const [name, current] of cases) {
      expect(resumeAfterEdit(current, held.restore), name).toBeNull();
    }
  });
});
