/**
 * A shipped preset by id, for a test that needs one as a fixture.
 *
 * Not product code: the module looks a preset up with `findPreset`, which searches the
 * whole library — the GM's own presets too. A lookup that searched the shipped ones alone
 * was how a pin wearing a user preset once got no effect at all.
 */
import { CORE_PRESETS } from "../../src/effects/presets/core-presets";
import type { DpPreset } from "../../src/effects/preset-schema";

export function getCorePreset(id: string): DpPreset | undefined {
  return CORE_PRESETS.find((p) => p.id === id);
}
