/**
 * Entry point.
 *
 * This file contains NO logic — only hook wiring — so that the module's behaviour is
 * auditable at a glance and every hook has exactly one obvious owner.
 */

import { MODULE_ID, SCHEMA_VERSION } from "./const";
import { t } from "./i18n";
import * as audience from "./data/audience";
import * as ownership from "./data/ownership-plan";
import * as transform from "./canvas/transform";
import * as presetCss from "./effects/preset-css";
import { estimateCost, validatePreset } from "./effects/preset-schema";
import { CORE_PRESETS, getCorePreset } from "./effects/presets/core-presets";

declare const game: any;
declare const Hooks: any;

/** The public surface, also used by the in-world smoke test. */
function buildApi() {
  return {
    version: SCHEMA_VERSION,
    presets: CORE_PRESETS,
    getCorePreset,
    validatePreset,
    estimateCost,
    audience,
    ownership,
    transform,
    css: presetCss,
  };
}

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("i18nInit", () => {
  // Presets carry i18n KEYS as labels; resolve them once the tables are loaded.
  console.log(`${MODULE_ID} | ${t("DP.module.title")}`);
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = buildApi();
  Hooks.callAll(`${MODULE_ID}.ready`, mod?.api);
  console.log(`${MODULE_ID} | ready — ${CORE_PRESETS.length} effect presets available`);
});
