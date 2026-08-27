/**
 * The preset library: shipped presets plus the world's own.
 *
 * IMPURE only in that it reads and writes a setting; the merge and the validation are
 * pure and tested through `validatePreset`.
 *
 * Two rules the Preset Studio depends on:
 *
 * 1. **Core presets are read-only, and duplicating is the only way to edit one.** A
 *    user preset that gets broken while being tuned always has a working ancestor to
 *    go back to, and a world can never end up with no usable presets at all.
 * 2. **Stored raw, validated on read.** A preset authored by a future version is
 *    reduced to what this version understands rather than rejected, so opening an
 *    older client does not destroy work. Unknown parameters are reported, then dropped.
 */

import { notify } from "../fvtt";
import * as settings from "../settings";
import { CORE_PRESETS } from "./presets/core-presets";
import { validatePreset, withComputedCost, type DpPreset } from "./preset-schema";

/** Every preset available in this world, core first. */
export function allPresets(): DpPreset[] {
  return [...CORE_PRESETS, ...userPresets()];
}

export function userPresets(): DpPreset[] {
  const raw = settings.get("userPresets");
  if (!Array.isArray(raw)) return [];

  const out: DpPreset[] = [];
  for (const entry of raw) {
    const { preset } = validatePreset(entry);
    // A preset that will not parse at all is skipped rather than shown broken: it is
    // still in the setting, so a later version that understands it can recover it.
    if (preset) out.push({ ...preset, author: "user" });
  }
  return out;
}

export function findPreset(id: string): DpPreset | null {
  return allPresets().find((preset) => preset.id === id) ?? null;
}

export function isCorePreset(id: string): boolean {
  return CORE_PRESETS.some((preset) => preset.id === id);
}

/**
 * A free id derived from a name.
 *
 * Suffixed until it is unique, because two presets sharing an id would make which one
 * a pin refers to depend on array order.
 */
export function freeId(base: string): string {
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "preset";

  const taken = new Set(allPresets().map((preset) => preset.id));
  if (!taken.has(stem)) return stem;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${taken.size}`;
}

async function writeUserPresets(presets: DpPreset[]): Promise<void> {
  await settings.set("userPresets", presets);
}

/** Save a user preset, replacing one with the same id. Core ids are refused. */
export async function savePreset(preset: DpPreset): Promise<DpPreset | null> {
  if (isCorePreset(preset.id)) {
    notify({ key: "DP.preset.error.coreReadOnly" }, "warn");
    return null;
  }

  const stamped = withComputedCost({ ...preset, author: "user" });
  const existing = userPresets().filter((p) => p.id !== stamped.id);
  await writeUserPresets([...existing, stamped]);
  return stamped;
}

/** Duplicate any preset into an editable copy. The only way to "edit" a core one. */
export async function duplicatePreset(id: string, name?: string): Promise<DpPreset | null> {
  const source = findPreset(id);
  if (!source) return null;

  const label = name ?? `${source.label} (copy)`;
  return savePreset({ ...source, id: freeId(label), label, author: "user" });
}

export async function deletePreset(id: string): Promise<boolean> {
  if (isCorePreset(id)) {
    notify({ key: "DP.preset.error.coreReadOnly" }, "warn");
    return false;
  }
  const remaining = userPresets().filter((preset) => preset.id !== id);
  await writeUserPresets(remaining);
  return true;
}

/**
 * Import a preset from arbitrary JSON.
 *
 * Warnings are surfaced rather than swallowed: a preset from a newer version loses
 * parameters this one does not know, and a user who pasted it deserves to be told it
 * degraded rather than wondering why it looks wrong.
 */
export async function importPreset(json: string): Promise<DpPreset | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    notify({ key: "DP.preset.error.notAnObject" }, "error");
    return null;
  }

  const { preset, errors, warnings } = validatePreset(parsed);
  for (const warning of warnings) notify(warning, "warn");
  for (const error of errors) notify(error, "error");
  if (!preset) return null;

  const label = preset.label || preset.id;
  return savePreset({ ...preset, id: freeId(label), author: "user" });
}

export function exportPreset(preset: DpPreset): string {
  return JSON.stringify(preset, null, 2);
}
