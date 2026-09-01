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
    expect(formToPatch([["display.typeSize", 12]])).toEqual({ display: { typeSize: 12 } });
  });

  it("merges several fields in the same group", () => {
    expect(
      formToPatch([
        ["display.margin", 2],
        ["display.showTitle", false],
      ])
    ).toEqual({ display: { margin: 2, showTitle: false } });
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

  it("shows the box's width and height in grid squares, with the ratio unlocked by default", () => {
    const markup = studioMarkup(doc, pin(), "content");
    expect(markup).toContain('name="_width" value="4"');
    expect(markup).toContain('name="_height" value="5.6"');
    expect(markup).toContain('name="_aspect">');
    expect(studioMarkup(doc, pin(), "content", { aspectLocked: true })).toContain(
      'name="_aspect" checked'
    );
  });

  it("keeps fit and reset in the strip on every tab", () => {
    for (const tab of ["content", "appearance", "audience"] as const) {
      const markup = studioMarkup(doc, pin(), tab);
      expect(markup, tab).toContain('data-action="fitHeight"');
      expect(markup, tab).toContain('data-action="resetSize"');
    }
  });

  it("disables fit for a pin-mode anchor, which has no content to fit", () => {
    expect(studioMarkup(doc, pin({ mode: "pin" }), "content")).toContain(
      'data-action="fitHeight" disabled'
    );
    expect(studioMarkup(doc, pin(), "content")).not.toContain('data-action="fitHeight" disabled');
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

  it("names every audience choice the module can actually honour", () => {
    const markup = studioMarkup(doc, pin(), "audience");
    for (const kind of ["everyone", "selected", "hidden"]) {
      expect(markup, kind).toContain(`value="${kind}"`);
    }
  });

  it("does not offer `discovered`, which cannot sync ownership or stick", () => {
    // Its visibility half works — each client tests its own line of sight — but the
    // sticky half needs a PLAYER's discovery to be persisted, and players never write
    // pin configuration while the module ships no socket. Offering it produced a
    // permanent "visible but won't open". See DESIGN A9.
    expect(studioMarkup(doc, pin(), "audience")).not.toContain('value="discovered"');
  });

  it("offers only the two ownership levels that are ever granted", () => {
    const markup = studioMarkup(doc, pin(), "audience");
    expect(markup).toContain('<option value="2"');
    expect(markup).toContain('<option value="1"');
    expect(markup).not.toContain('<option value="3"');
  });
});

/**
 * Controls that cannot be honoured must not be offered — the rule this module already
 * applied to the `discovered` audience and to `interaction.tooltip`, arrived at again from
 * the other direction: "we should not offer options we are not able to honor."
 */
describe("the appearance tab and what it can actually do", () => {
  it("offers only the two motion choices the renderer implements", () => {
    const markup = studioMarkup(doc, pin(), "appearance");
    expect(markup).toContain('value="loop"');
    expect(markup).toContain('value="none"');
    // Nothing implements a play-once animation; the renderer treated `onReveal` exactly
    // as `loop`, so a third choice behaved identically to the first.
    expect(markup).not.toContain('value="onReveal"');
  });

  it("offers a text size in scene pixels, showing the size the pin is actually drawn at", () => {
    // A pin from before type sizes were stored: the slider sits at the derived size.
    const markup = studioMarkup(doc, pin(), "appearance");
    expect(markup).toMatch(/name="display.typeSize" min="6" max="72" step="0.5" value="15\.38"/);
    // A stored one shows what is stored.
    const stored = pin({ display: { ...pin().display, typeSize: 20, margin: 2 } });
    expect(studioMarkup(doc, stored, "appearance")).toContain(
      'name="display.typeSize" min="6" max="72" step="0.5" value="20"'
    );
  });

  it("offers margins in em, not as a fraction of the short edge", () => {
    const markup = studioMarkup(doc, pin(), "appearance");
    expect(markup).toMatch(/name="display.margin" min="0" max="6" step="0.1" value="1\.56"/);
    expect(markup).not.toContain('name="display.padding"');
  });

  it("gives the effect name its own grid area, so it cannot land on the cost label", () => {
    // Without the class the name span was auto-placed on top of `grid-area: cost`, and
    // every swatch read as the two strings overlapping.
    expect(studioMarkup(doc, pin(), "appearance")).toContain("dp-studio__swatch-name");
  });
});
