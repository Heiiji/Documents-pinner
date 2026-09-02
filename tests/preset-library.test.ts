import { describe, expect, it } from "vitest";
import { presetStudioMarkup, readParam, writeParam } from "../src/apps/PresetStudio";
import { exportPreset, isCorePreset } from "../src/effects/preset-library";
import { CORE_PRESETS, getCorePreset } from "../src/effects/presets/core-presets";
import { validatePreset } from "../src/effects/preset-schema";

const parchment = () => getCorePreset("aged-parchment")!;

describe("readParam / writeParam", () => {
  it("reads a nested numeric parameter", () => {
    expect(readParam(parchment(), "tint.amount")).toBe(0.35);
  });

  it("reads a top-level numeric parameter", () => {
    expect(readParam(parchment(), "blur")).toBe(0);
  });

  it("returns 0 rather than throwing for a path that does not exist", () => {
    expect(readParam(parchment(), "nope.nope")).toBe(0);
  });

  it("writes without mutating the original, so a core preset stays frozen", () => {
    const before = parchment();
    const after = writeParam(before, "tint.amount", 0.9);
    expect(after.params.tint.amount).toBe(0.9);
    expect(before.params.tint.amount).toBe(0.35);
  });

  it("leaves sibling parameters untouched", () => {
    const after = writeParam(parchment(), "tint.amount", 0.9);
    expect(after.params.tint.color).toBe(parchment().params.tint.color);
    expect(after.params.edge).toEqual(parchment().params.edge);
  });

  it("round-trips every slider path the studio offers", () => {
    for (const preset of CORE_PRESETS) {
      for (const path of ["tint.amount", "blur", "glow.radius", "shadow.opacity"]) {
        expect(readParam(writeParam(preset, path, 0.25), path), `${preset.id} ${path}`).toBe(0.25);
      }
    }
  });
});

describe("isCorePreset", () => {
  it("recognises every shipped preset and nothing else", () => {
    for (const preset of CORE_PRESETS) expect(isCorePreset(preset.id), preset.id).toBe(true);
    expect(isCorePreset("my-own-thing")).toBe(false);
  });
});

describe("exportPreset", () => {
  it("produces JSON that re-imports to the same preset", () => {
    const json = exportPreset(parchment());
    const { preset, errors } = validatePreset(JSON.parse(json));
    expect(errors).toEqual([]);
    expect(preset?.params).toEqual(parchment().params);
  });

  it("is readable rather than minified, because it is meant to be pasted by hand", () => {
    expect(exportPreset(parchment())).toContain("\n");
  });
});

describe("presetStudioMarkup", () => {
  const presets = CORE_PRESETS;

  it("marks the selected preset and only that one", () => {
    const markup = presetStudioMarkup(presets, getCorePreset("glitch")!, "map", false);
    expect(markup.match(/dp-presets__item[^>]*aria-pressed="true"/g)?.length).toBe(1);
  });

  it("locks the parameters of a shipped preset and says why", () => {
    const markup = presetStudioMarkup(presets, parchment(), "map", false);
    expect(markup).toContain("disabled");
    expect(markup).toContain("DP.presets.readOnlyHint");
  });

  it("offers no delete for a shipped preset — a broken copy must keep its ancestor", () => {
    expect(presetStudioMarkup(presets, parchment(), "map", false)).not.toContain(
      'data-action="remove"'
    );
  });

  it("enables the parameters of a user preset", () => {
    const mine = { ...parchment(), id: "mine", author: "user" as const };
    const markup = presetStudioMarkup([...presets, mine], mine, "map", false);
    expect(markup).toContain('data-action="remove"');
    expect(markup).not.toContain("DP.presets.readOnlyHint");
  });

  it("marks the chosen backdrop, which is how an effect is judged against a real map", () => {
    const markup = presetStudioMarkup(presets, parchment(), "dark", false);
    expect(markup).toContain('data-dp-bg="dark"');
    expect(markup).toContain('data-dp-bg="dark" aria-pressed="true"');
  });

  it("shows the derived cost, never an authored one", () => {
    const markup = presetStudioMarkup(presets, getCorePreset("glitch")!, "map", false);
    expect(markup).toContain("dp-presets__cost");
    expect(markup).toContain("DP.presets.cost");
  });

  it("freezes motion when asked, for judging a still look", () => {
    const frozen = presetStudioMarkup(presets, getCorePreset("glitch")!, "map", true);
    expect(frozen).toContain('data-dp-level="reduced"');
    expect(frozen).toContain('data-action="toggleFreeze" aria-pressed="true"');
  });
});

describe("naming a preset", () => {
  it("offers a name field for a user preset and none for a shipped one", () => {
    const own = { ...parchment(), id: "mine", label: "Mine", author: "user" as const };
    expect(presetStudioMarkup([own], own, "map", false)).toContain('name="_label"');
    expect(presetStudioMarkup([parchment()], parchment(), "map", false)).not.toContain(
      'name="_label"'
    );
  });
});

/**
 * The Preset Studio could edit numbers and nothing else.
 *
 * `SLIDERS` is numeric, so until now no colour and no enum in the schema had a control
 * anywhere — `edge.style` and `frame.style` were as unreachable as the new overlay's
 * geometry, and a GM who duplicated a preset could not recolour it. Every value goes back
 * through `validatePreset`, so a bad one degrades rather than throws.
 */
describe("the colours and the shapes", () => {
  const editable = () => validatePreset({ ...parchment(), id: "mine", author: "user" }).preset!;

  it("offers a control for every colour and every style enum", () => {
    const markup = presetStudioMarkup(CORE_PRESETS, editable(), "dark", false);
    for (const name of ["tint.color", "glow.color", "frame.color", "hud.color"]) {
      expect(markup, name).toContain(`type="color" name="${name}"`);
    }
    for (const name of ["edge.style", "frame.style", "hud.marks", "hud.grid"]) {
      expect(markup, name).toContain(`<select name="${name}"`);
    }
  });

  it("selects the value the preset actually holds", () => {
    const markup = presetStudioMarkup(CORE_PRESETS, editable(), "dark", false);
    // Aged Parchment is deckled, and its tint is the colour the schema lower-cased.
    expect(markup).toContain('<option value="deckled" selected>');
    expect(markup).toContain('value="#c8a86a"');
  });

  it("disables every one of them for a shipped preset", () => {
    const markup = presetStudioMarkup(CORE_PRESETS, parchment(), "dark", false);
    expect(markup).toContain('type="color" name="tint.color" value="#c8a86a" disabled');
    expect(markup).toContain('<select name="edge.style" disabled>');
  });

  it("writes a string parameter as well as a number", () => {
    expect(writeParam(parchment(), "edge.style", "torn").params.edge.style).toBe("torn");
    expect(writeParam(parchment(), "hud.grid", "dot").params.hud.grid).toBe("dot");
    expect(writeParam(parchment(), "tint.amount", 0.5).params.tint.amount).toBe(0.5);
  });

  it("degrades a value this version does not understand rather than storing it", () => {
    const broken = writeParam(editable(), "hud.grid", "spiral");
    const { preset, warnings } = validatePreset(broken);
    expect(preset!.params.hud.grid).toBe("none");
    expect(warnings.map((w) => w.key)).toContain("DP.preset.warn.badEnum");
  });
});
