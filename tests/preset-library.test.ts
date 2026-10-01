import { describe, expect, it } from "vitest";
import { GROUPS, presetStudioMarkup, readParam, writeParam } from "../src/apps/PresetStudio";
import { exportPreset, isCorePreset } from "../src/effects/preset-library";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";
import { validatePreset } from "../src/effects/preset-schema";
import { getCorePreset } from "./helpers/presets";

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

  // The preview built its card by hand, so when the rolling scanlines moved to a layer of
  // their own it showed them still, and it never had the HUD overlay at all (A29).
  it("draws the layers a pin's card draws: the rolling scanlines and the HUD overlay", () => {
    // The preview pane alone: from the card to the backdrop swatches after it.
    const preview = (id: string, frozen: boolean) => {
      const markup = presetStudioMarkup(presets, getCorePreset(id)!, "map", frozen);
      const from = markup.indexOf('class="dp-presets__preview"');
      return markup.slice(from, markup.indexOf('class="dp-presets__bgs"', from));
    };
    expect(preview("crt-scanlines", false)).toContain('<i class="dp-card__scan"');
    // Frozen is the reduced level: the scanlines are drawn still, as a reduced card's are.
    expect(preview("crt-scanlines", true)).not.toContain("dp-card__scan");
    expect(preview("projected-readout", false)).toContain('<div class="dp-card__hud"');
    expect(preview("aged-parchment", false)).not.toMatch(/dp-card__(scan|hud)/);
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

/**
 * Twenty-eight controls in one column, the layers a preset does not use sitting at zero
 * among the ones it does. Each layer is a disclosure now, open when the preset uses it.
 */
describe("the parameters, by layer", () => {
  const groups = (markup: string) =>
    [...markup.matchAll(/<details class="dp-presets__group" data-dp-group="([^"]+)"( open)?/g)].map(
      (m) => [m[1], m[2] === " open"] as const
    );

  it("offers every control exactly once, each in a layer", () => {
    const paths = GROUPS.flatMap((group) => group.paths);
    expect(new Set(paths).size).toBe(paths.length);
    const markup = presetStudioMarkup(CORE_PRESETS, parchment(), "map", false);
    for (const path of paths) {
      expect(markup.split(`name="${path}"`).length - 1, path).toBe(1);
    }
  });

  it("opens the layers the preset uses and closes the rest", () => {
    const shown = new Map(groups(presetStudioMarkup(CORE_PRESETS, parchment(), "map", false)));
    // Aged Parchment is a tinted, grained, deckled sheet with no glow and no scanlines.
    expect(shown.get("surface")).toBe(true);
    expect(shown.get("edges")).toBe(true);
    expect(shown.get("glow")).toBe(false);
    expect(shown.get("scanlines")).toBe(false);
  });

  it("keeps a layer the GM opened by hand open", () => {
    const markup = presetStudioMarkup(CORE_PRESETS, parchment(), "map", false, {
      isOpen: (group) => (group === "glow" ? true : undefined),
    });
    expect(new Map(groups(markup)).get("glow")).toBe(true);
  });
});

/**
 * A preset duplicated from a pin's gallery and tuned here was never put on the pin:
 * nothing in this window could, and the gallery was two windows away.
 */
describe("the way back to the pin", () => {
  it("offers the showing preset to the pin the studio was opened from", () => {
    const markup = presetStudioMarkup(CORE_PRESETS, getCorePreset("glitch")!, "map", false, {
      target: { name: "The Letter", effectId: "aged-parchment" },
    });
    expect(markup).toContain('data-action="useOnPin"');
    expect(markup).toContain("DP.presets.useOn");
  });

  it("says the pin already wears it, rather than offering what is done", () => {
    const markup = presetStudioMarkup(CORE_PRESETS, parchment(), "map", false, {
      target: { name: "The Letter", effectId: "aged-parchment" },
    });
    expect(markup).not.toContain('data-action="useOnPin"');
    expect(markup).toContain("DP.presets.inUseOn");
  });

  it("offers nothing when opened for no pin", () => {
    expect(presetStudioMarkup(CORE_PRESETS, parchment(), "map", false)).not.toContain("useOnPin");
  });
});
