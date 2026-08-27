/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { formToPatch, studioMarkup, valueOf } from "../src/apps/PinStudio";
import { defaultPin, validatePin } from "../src/data/pin-schema";

const pin = (over: Record<string, any> = {}) => validatePin({ ...defaultPin(), ...over }).pin;
const doc = { id: "t1", elevation: 20, rotation: 45, locked: false, width: 400, height: 560 };

describe("formToPatch", () => {
  it("turns a dotted field name into a nested patch", () => {
    expect(formToPatch([["display.padding", 0.2]])).toEqual({ display: { padding: 0.2 } });
  });

  it("merges several fields in the same group", () => {
    expect(
      formToPatch([
        ["display.padding", 0.2],
        ["display.showTitle", false],
      ])
    ).toEqual({ display: { padding: 0.2, showTitle: false } });
  });

  it("handles a path more than two deep", () => {
    expect(formToPatch([["audience.ownershipSync.level", 1]])).toEqual({
      audience: { ownershipSync: { level: 1 } },
    });
  });

  it("ignores the placement strip, which writes tile fields not the payload", () => {
    expect(formToPatch([["_elevation", 20]])).toEqual({});
  });

  it("keeps a top-level field flat", () => {
    expect(formToPatch([["mode", "pin"]])).toEqual({ mode: "pin" });
  });
});

describe("valueOf", () => {
  const input = (attrs: Record<string, string>) => {
    const el = {
      name: attrs.name ?? "",
      type: attrs.type,
      value: attrs.value,
      checked: attrs.checked === "true",
    };
    Object.setPrototypeOf(el, HTMLInputElement.prototype);
    return el as unknown as HTMLInputElement;
  };

  it("reads a checkbox as a boolean, never as the string 'on'", () => {
    expect(valueOf(input({ type: "checkbox", checked: "true", name: "a" }))).toBe(true);
    expect(valueOf(input({ type: "checkbox", checked: "false", name: "a" }))).toBe(false);
  });

  it("reads a range and a number as numbers, so the schema's clamps apply", () => {
    expect(valueOf(input({ type: "range", value: "0.35", name: "a" }))).toBe(0.35);
    expect(valueOf(input({ type: "number", value: "20", name: "a" }))).toBe(20);
  });

  it("reads text as text", () => {
    expect(valueOf(input({ type: "text", value: "The Duke", name: "a" }))).toBe("The Duke");
  });
});

describe("studioMarkup", () => {
  it("marks exactly one tab selected", () => {
    const markup = studioMarkup(doc, pin(), "appearance");
    expect(markup.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(markup).toContain('data-dp-tab="appearance" role="tab" aria-selected="true"');
  });

  it("renders only the active tab's controls", () => {
    expect(studioMarkup(doc, pin(), "content")).toContain('name="interaction.open"');
    expect(studioMarkup(doc, pin(), "content")).not.toContain('name="display.paper"');
    expect(studioMarkup(doc, pin(), "appearance")).toContain('name="display.paper"');
  });

  it("keeps the placement strip on every tab", () => {
    for (const tab of ["content", "appearance", "audience"] as const) {
      expect(studioMarkup(doc, pin(), tab), tab).toContain("dp-studio__strip");
    }
  });

  it("reflects the anchor's own geometry, not the payload's", () => {
    const markup = studioMarkup(doc, pin(), "content");
    expect(markup).toContain('name="_elevation" value="20"');
    expect(markup).toContain('name="_rotation" value="45"');
  });

  it("shows the current effect as pressed and labels its cost", () => {
    const markup = studioMarkup(
      doc,
      pin({ effect: { ...pin().effect, id: "glitch" } }),
      "appearance"
    );
    expect(markup).toContain('data-dp-preset="glitch" aria-pressed="true"');
    expect(markup).toContain("data-dp-cost=");
  });

  it("says so rather than rendering blank when the source is gone", () => {
    expect(studioMarkup(doc, pin(), "content")).toContain("DP.studio.sourceMissing");
  });

  it("names every audience choice, including the discovered kind", () => {
    const markup = studioMarkup(doc, pin(), "audience");
    for (const kind of ["everyone", "selected", "discovered", "hidden"]) {
      expect(markup, kind).toContain(`value="${kind}"`);
    }
  });

  it("offers only the two ownership levels that are ever granted", () => {
    const markup = studioMarkup(doc, pin(), "audience");
    expect(markup).toContain('<option value="2"');
    expect(markup).toContain('<option value="1"');
    expect(markup).not.toContain('<option value="3"');
  });
});
