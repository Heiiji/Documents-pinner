/**
 * @vitest-environment jsdom
 *
 * Every window re-renders by replacing its subtree, so the element holding the focus is
 * destroyed on each change. A slider moved with the arrow keys commits on every step and
 * could be moved exactly one; a GM tabbing down the Studio was sent back after each field.
 */
import { afterEach, describe, expect, it } from "vitest";
import { focusSelectorIn, restoreFocus, snapshotFocus } from "../src/apps/focus-restore";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("focusSelectorIn", () => {
  it("finds a form control by its name, whatever else changed around it", () => {
    const root = mount('<select name="display.paper"></select><input name="effect.intensity">');
    root.querySelector<HTMLElement>('[name="effect.intensity"]')!.focus();
    expect(focusSelectorIn(root)).toBe('[name="effect\\.intensity"]');
  });

  it("finds a button that shares its action by what it acts on", () => {
    const root = mount(
      '<button data-action="setTab" data-dp-tab="content"></button>' +
        '<button data-action="setTab" data-dp-tab="audience"></button>'
    );
    root.querySelector<HTMLElement>('[data-dp-tab="audience"]')!.focus();
    const selector = focusSelectorIn(root)!;
    expect(root.querySelector(selector)).toBe(root.querySelector('[data-dp-tab="audience"]'));
  });

  it("finds an element that names itself for the purpose", () => {
    const root = mount('<details><summary data-dp-focus-key="group-glow">Glow</summary></details>');
    root.querySelector<HTMLElement>("summary")!.focus();
    expect(focusSelectorIn(root)).toBe('[data-dp-focus-key="group-glow"]');
  });

  it("says nothing when the focus is somewhere else entirely", () => {
    const root = mount('<input name="a">');
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    expect(focusSelectorIn(root)).toBeNull();
  });
});

describe("snapshotFocus and restoreFocus", () => {
  it("puts the focus back on the same control in new markup", () => {
    const before = mount('<input type="range" name="effect.intensity" value="50">');
    before.querySelector<HTMLElement>("input")!.focus();
    const snapshot = snapshotFocus(before);

    before.innerHTML = '<input type="range" name="effect.intensity" value="55">';
    restoreFocus(before, snapshot);
    expect(document.activeElement).toBe(before.querySelector("input"));
  });

  it("carries a half-typed word across a render that would have replaced it", () => {
    const root = mount('<input type="text" name="display.label" value="Old">');
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.focus();
    input.value = "The Du";
    const snapshot = snapshotFocus(root);

    root.innerHTML = '<input type="text" name="display.label" value="Old">';
    restoreFocus(root, snapshot);
    expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("The Du");
  });

  it("leaves a field that was not being edited showing what was stored", () => {
    const root = mount('<input type="text" name="display.label" value="Old">');
    root.querySelector<HTMLInputElement>("input")!.focus();
    const snapshot = snapshotFocus(root);

    root.innerHTML = '<input type="text" name="display.label" value="Renamed">';
    restoreFocus(root, snapshot);
    expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("Renamed");
  });
});
