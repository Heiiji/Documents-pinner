import { describe, expect, it } from "vitest";
import {
  chipMarkup,
  chipState,
  chipsMarkup,
  describeChips,
  isMismatch,
  type ChipUser,
} from "../src/apps/chips";

const t = (n: { key: string; data?: Record<string, unknown> }) =>
  `${n.key}${n.data ? `(${JSON.stringify(n.data)})` : ""}`;

function user(overrides: Partial<ChipUser> = {}): ChipUser {
  return {
    id: "u1",
    name: "Ali",
    color: "#ff8800",
    avatar: null,
    canSee: true,
    canOpen: true,
    ...overrides,
  };
}

describe("chipState", () => {
  it("distinguishes all four combinations of seeing and opening", () => {
    expect(chipState({ canSee: true, canOpen: true })).toBe("visible");
    expect(chipState({ canSee: false, canOpen: false })).toBe("hidden");
    expect(chipState({ canSee: true, canOpen: false })).toBe("seesButCannotOpen");
    expect(chipState({ canSee: false, canOpen: true })).toBe("opensButCannotSee");
  });

  it("treats both disagreements as a mismatch, and neither agreement", () => {
    expect(isMismatch("seesButCannotOpen")).toBe(true);
    expect(isMismatch("opensButCannotSee")).toBe(true);
    expect(isMismatch("visible")).toBe(false);
    expect(isMismatch("hidden")).toBe(false);
  });
});

describe("chipMarkup", () => {
  it("shows the key glyph exactly when presence and access disagree", () => {
    expect(chipMarkup(user({ canOpen: false }), { t })).toContain("dp-chip__key");
    expect(chipMarkup(user(), { t })).not.toContain("dp-chip__key");
    expect(chipMarkup(user({ canSee: false, canOpen: false }), { t })).not.toContain(
      "dp-chip__key"
    );
  });

  it("reports visibility to assistive technology, not just to the eye", () => {
    expect(chipMarkup(user(), { t })).toContain('aria-checked="true"');
    expect(chipMarkup(user({ canSee: false }), { t })).toContain('aria-checked="false"');
    expect(chipMarkup(user(), { t })).toContain('role="checkbox"');
  });

  it("escapes a display name, which is user-controlled text", () => {
    const markup = chipMarkup(user({ name: '<img src=x onerror="alert(1)">' }), { t });
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;");
  });

  it("escapes a name inside the tooltip attribute too", () => {
    const markup = chipMarkup(user({ name: 'a" onmouseover="x' }), { t });
    expect(markup).not.toMatch(/title="[^"]*" onmouseover=/);
  });

  it("falls back to an initial when there is no avatar, one glyph even for an emoji", () => {
    expect(chipMarkup(user({ name: "ali" }), { t })).toContain(">A<");
    expect(chipMarkup(user({ name: "🐉 Dragon" }), { t })).toContain(">🐉<");
  });

  it("rejects a colour that is not a plain hex value", () => {
    const markup = chipMarkup(user({ color: "red; background:url(evil)" }), { t });
    expect(markup).toContain("--dp-chip-color:#7a7971");
  });

  it("rejects an avatar path that could break out of the img attribute", () => {
    for (const avatar of ['a" onerror="x', "a')", "javascript:alert(1)"]) {
      const markup = chipMarkup(user({ avatar }), { t });
      expect(markup, avatar).not.toContain("dp-chip__avatar");
    }
  });

  it("uses a real avatar when it is a plain path", () => {
    expect(chipMarkup(user({ avatar: "icons/svg/mystery-man.svg" }), { t })).toContain(
      'src="icons/svg/mystery-man.svg"'
    );
  });
});

describe("chipsMarkup", () => {
  it("says so rather than rendering an unexplained gap when there are no players", () => {
    expect(chipsMarkup([], { t })).toContain("DP.chip.noPlayers");
  });

  it("renders one chip per player", () => {
    const markup = chipsMarkup([user({ id: "a" }), user({ id: "b" })], { t });
    expect(markup.match(/dp-chip"/g)?.length).toBe(2);
  });
});

describe("describeChips", () => {
  it("counts who is seeing out of how many", () => {
    expect(describeChips([user(), user({ canSee: false, canOpen: false })])).toEqual({
      key: "DP.chip.summary",
      data: { seeing: 1, total: 2 },
    });
  });

  it("promotes the summary when any chip disagrees with itself", () => {
    const notice = describeChips([user({ canOpen: false }), user()]);
    expect(notice.key).toBe("DP.chip.summaryMismatch");
    expect(notice.data).toEqual({ seeing: 2, total: 2, mismatched: 1 });
  });
});

describe("the chip's tooltip", () => {
  it("states the result first and the two gestures second, the same on every surface", () => {
    const markup = chipMarkup(user({ canSee: true, canOpen: false }), { t });
    const title = markup.match(/title="([^"]*)"/)![1];
    expect(title.startsWith("DP.chip.seesButCannotOpen")).toBe(true);
    expect(title).toContain("DP.chip.actions");
    // The accessible name stays the state alone.
    expect(markup).toMatch(/aria-label="DP\.chip\.seesButCannotOpen[^"]*"/);
  });
});
