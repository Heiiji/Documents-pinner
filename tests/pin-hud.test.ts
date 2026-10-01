import { describe, expect, it } from "vitest";
import { focusStep, hudMarkup } from "../src/apps/PinHUD";
import { defaultPin, validatePin } from "../src/data/pin-schema";

function pin(overrides: Record<string, any> = {}) {
  return validatePin({ ...defaultPin(), ...overrides }).pin;
}

function fakeButtons(count: number) {
  return Array.from({ length: count }, () => {
    const focused: string[] = [];
    return {
      tabIndex: -1,
      focus() {
        focused.push("focus");
      },
      focused,
    } as unknown as HTMLElement;
  });
}

describe("focusStep", () => {
  it("wraps around in both directions", () => {
    const buttons = fakeButtons(3);
    focusStep(buttons, buttons[2], 1);
    expect(buttons[0].tabIndex).toBe(0);

    focusStep(buttons, buttons[0], -1);
    expect(buttons[2].tabIndex).toBe(0);
  });

  it("leaves exactly one button tabbable, so the toolbar is one tab stop", () => {
    const buttons = fakeButtons(4);
    focusStep(buttons, buttons[0], 1);
    expect(buttons.filter((b) => b.tabIndex === 0).length).toBe(1);
  });

  it("starts at the first button when nothing is focused yet", () => {
    const buttons = fakeButtons(3);
    focusStep(buttons, null, 1);
    expect(buttons[0].tabIndex).toBe(0);
  });

  it("does nothing rather than throwing on an empty toolbar", () => {
    expect(() => focusStep([], null, 1)).not.toThrow();
  });
});

describe("hudMarkup", () => {
  const doc = { locked: false, hidden: true, x: 0, y: 0, width: 100, height: 100 };

  it("is a toolbar with a single tab stop and no tabbable icons by default", () => {
    const markup = hudMarkup(doc, pin());
    expect(markup).toContain('role="toolbar"');
    // Nine for a prop and a pin alike: Fit, the one verb only a prop had, has left, and
    // the `?` for the keys (E2) has joined the toolbar's roving order at its end.
    expect(markup.match(/tabindex="-1"/g)?.length).toBe(9);
    expect(hudMarkup(doc, pin({ mode: "pin" })).match(/tabindex="-1"/g)?.length).toBe(9);
  });

  /**
   * K10. The live verbs on the left — the eye, the audience, the spotlight — and what the
   * pin is on the right. Lock and Fit are prep and layout verbs, and they are in the
   * Studio's strip (Fit also on Alt+Shift+F): these tests used to assert Fit on the HUD
   * and the lock's state here. The two lists are exact, and the nine tab stops above have
   * no room for a tenth button, so neither can come back unnoticed.
   */
  it("lays out the live verbs on the left and the pin's own on the right", () => {
    const markup = hudMarkup(doc, pin());
    // Each button as its action, and the palette it opens when it opens one.
    const actions = (column: string) => {
      const start = markup.indexOf(`dp-hud__col--${column}`);
      const body = markup.slice(start, markup.indexOf("</div>", start));
      return [
        ...body.matchAll(
          /data-action="(\w+)"(?: aria-expanded="false" aria-controls="([\w-]+)")?/g
        ),
      ].map(([, action, palette]) => (palette ? `${action}:${palette}` : action));
    };
    expect(actions("left")).toEqual([
      "toggleVisibility",
      "togglePalette:dp-hud-audience",
      "spotlight",
    ]);
    expect(actions("right")).toEqual([
      "togglePalette:dp-hud-effects",
      "toggleMode",
      "openLocally",
      "flash",
      "configure",
      // E2: the keys, last, after K10's five.
      "cheatSheet",
    ]);
  });

  it("says in the spotlight's label whose view it moves", () => {
    // Hidden, remembering nobody narrower: the reveal is to everyone, and every view moves.
    expect(hudMarkup(doc, pin())).toContain('data-tooltip-text="DP.hud.spotlight"');
    const forAli = pin({
      audience: {
        ...pin().audience,
        kind: "hidden",
        restore: { kind: "selected", users: ["ali"] },
      },
    });
    expect(hudMarkup(doc, forAli)).toContain('data-tooltip-text="DP.hud.spotlightNarrow"');
  });

  it("offers reveal while hidden and hide while visible", () => {
    expect(hudMarkup(doc, pin())).toContain("fa-eye-slash");
    // The store keeps core's `hidden` in step with the audience; a revealed pin is not hidden.
    const shown = { ...doc, hidden: false };
    expect(hudMarkup(shown, pin({ audience: { ...pin().audience, kind: "everyone" } }))).toContain(
      'class="fa-solid fa-eye"'
    );
  });

  it("keeps the eye shut on a selection that names nobody, which reaches no one", () => {
    const shown = { ...doc, hidden: false };
    const nobody = pin({ audience: { ...pin().audience, kind: "selected", users: [] } });
    expect(hudMarkup(shown, nobody)).toContain("fa-eye-slash");
    expect(hudMarkup(shown, nobody)).toContain('data-tooltip-text="DP.hud.reveal"');
  });

  it("states the eye in its label alone, not also as pressed", () => {
    const markup = hudMarkup(doc, pin());
    expect(markup).not.toMatch(/data-action="toggleVisibility"[^>]*aria-pressed/);
  });

  it("keeps both palettes closed and collapsed until asked", () => {
    const markup = hudMarkup(doc, pin());
    expect(markup.match(/aria-expanded="false"/g)?.length).toBe(2);
    expect(markup.match(/dp-hud__palette[^>]*hidden/g)?.length).toBe(2);
  });

  it("marks the current effect and the current audience as pressed", () => {
    const markup = hudMarkup(doc, pin({ effect: { ...pin().effect, id: "glitch" } }));
    expect(markup).toContain('data-dp-preset="glitch" aria-pressed="true"');
    expect(markup).toContain('data-dp-kind="hidden" aria-pressed="true"');
  });
});
