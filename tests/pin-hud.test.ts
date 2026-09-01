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
    expect(markup.match(/tabindex="-1"/g)?.length).toBe(9);
  });

  it("offers fit-to-content for a prop and not for a pin", () => {
    expect(hudMarkup(doc, pin())).toContain('data-action="fitHeight"');
    const asPin = hudMarkup(doc, pin({ mode: "pin" }));
    expect(asPin).not.toContain('data-action="fitHeight"');
    expect(asPin.match(/tabindex="-1"/g)?.length).toBe(8);
  });

  it("offers reveal while hidden and hide while visible", () => {
    expect(hudMarkup(doc, pin())).toContain("fa-eye-slash");
    expect(hudMarkup(doc, pin({ audience: { ...pin().audience, kind: "everyone" } }))).toContain(
      'class="fa-solid fa-eye"'
    );
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

  it("reflects the anchor's lock state rather than assuming it", () => {
    expect(hudMarkup({ ...doc, locked: true }, pin())).toContain('fa-lock"');
  });
});
