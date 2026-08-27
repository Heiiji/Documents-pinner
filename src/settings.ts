/**
 * Module settings.
 *
 * Declared once in `SETTINGS` and used for both registration and typed reads, so a
 * renamed key or a changed default cannot land in one place and not the other.
 *
 * Scope follows a single rule: **anything about this machine is `client`, anything
 * about this world is `world`.** Rendering mode, effect level and VRAM budget describe
 * the hardware in front of one player and must not be imposed by the GM; the default
 * audience and ownership-sync policy describe how the table plays and must be the same
 * for everyone.
 *
 * Two settings are `config: false` scratch space rather than preferences: the last
 * source and preset a GM used, which is what makes `Shift+P` a zero-dialog placement.
 */

import { DEFAULTS, MODULE_ID } from "./const";
import { g } from "./fvtt";

export type RenderingMode = "canvas" | "dom";
export type EffectsLevel = "auto" | "full" | "reduced" | "off";
export type DropModifier = "alt" | "ctrl" | "shift" | "none";

interface SettingDef {
  scope: "world" | "client";
  config: boolean;
  type: typeof String | typeof Boolean | typeof Number | typeof Object;
  default: unknown;
  choices?: Record<string, string>;
  range?: { min: number; max: number; step: number };
  requiresReload?: boolean;
}

export const SETTINGS = {
  /**
   * Canvas rendering is the point of the module — a prop lit by the room's torches —
   * but it needs `foreignObject` rasterisation, which WebKit refuses by tainting the
   * canvas. `ready` probes for that and falls back on its own; this setting exists so
   * a player on a low-VRAM machine can choose the cheap path deliberately.
   */
  rendering: {
    scope: "client",
    config: true,
    type: String,
    default: "canvas",
    choices: {
      canvas: "DP.settings.rendering.canvas",
      dom: "DP.settings.rendering.dom",
    },
  },
  effectsLevel: {
    scope: "client",
    config: true,
    type: String,
    default: "auto",
    choices: {
      auto: "DP.settings.effectsLevel.auto",
      full: "DP.settings.effectsLevel.full",
      reduced: "DP.settings.effectsLevel.reduced",
      off: "DP.settings.effectsLevel.off",
    },
  },
  vramBudgetMb: {
    scope: "client",
    config: true,
    type: Number,
    default: Math.round(DEFAULTS.vramBudget / (1024 * 1024)),
    range: { min: 64, max: 2048, step: 64 },
  },
  autoDegrade: {
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  /**
   * macOS turns Option-drag into a copy gesture, which changes the HTML5 `dropEffect`
   * and can swallow the drop. Exposed so a GM on a hostile OS/browser pair can move
   * the gesture rather than lose the entry point.
   */
  dropModifier: {
    scope: "client",
    config: true,
    type: String,
    default: "alt",
    choices: {
      alt: "DP.settings.dropModifier.alt",
      ctrl: "DP.settings.dropModifier.ctrl",
      shift: "DP.settings.dropModifier.shift",
      none: "DP.settings.dropModifier.none",
    },
  },
  placementLegend: {
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  defaultMode: {
    scope: "world",
    config: true,
    type: String,
    default: "prop",
    choices: {
      prop: "DP.settings.defaultMode.prop",
      pin: "DP.settings.defaultMode.pin",
    },
  },
  /**
   * What a freshly placed pin is visible to. The stored payload always defaults to
   * hidden — an unparseable flag must never reveal a document — so this is applied by
   * the placement flow on top, where a GM can see what they are doing.
   */
  defaultAudience: {
    scope: "world",
    config: true,
    type: String,
    default: "everyone",
    choices: {
      everyone: "DP.settings.defaultAudience.everyone",
      hidden: "DP.settings.defaultAudience.hidden",
    },
  },
  defaultOwnershipSync: {
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  },
  /** Bumped by `migrations.ts` after a world-wide sweep completes. */
  schemaVersion: {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  },
  lastPreset: {
    scope: "client",
    config: false,
    type: String,
    default: "none",
  },
  lastSourceUuid: {
    scope: "client",
    config: false,
    type: String,
    default: "",
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

interface SettingTypes {
  rendering: RenderingMode;
  effectsLevel: EffectsLevel;
  vramBudgetMb: number;
  autoDegrade: boolean;
  dropModifier: DropModifier;
  placementLegend: boolean;
  defaultMode: "prop" | "pin";
  defaultAudience: "everyone" | "hidden";
  defaultOwnershipSync: boolean;
  schemaVersion: number;
  lastPreset: string;
  lastSourceUuid: string;
}

/**
 * Read a setting, falling back to its declared default.
 *
 * The fallback is not defensive clutter: settings are read from `canvasReady` paths
 * that can run before registration on a slow world load, and a thrown "not registered"
 * there would abort the canvas draw.
 */
export function get<K extends SettingKey>(key: K): SettingTypes[K] {
  try {
    const value = g()?.settings?.get(MODULE_ID, key);
    if (value !== undefined && value !== null) return value as SettingTypes[K];
  } catch {
    /* not registered yet */
  }
  return SETTINGS[key].default as SettingTypes[K];
}

export async function set<K extends SettingKey>(key: K, value: SettingTypes[K]): Promise<void> {
  try {
    await g()?.settings?.set(MODULE_ID, key, value);
  } catch (error) {
    console.warn(`${MODULE_ID} | could not store setting ${key}`, error);
  }
}

/** Register every setting. Call once, at `init`. */
export function register(): void {
  const settings = g()?.settings;
  if (!settings?.register) return;

  for (const [key, def] of Object.entries(SETTINGS) as [SettingKey, SettingDef][]) {
    settings.register(MODULE_ID, key, {
      name: `DP.settings.${key}.name`,
      hint: `DP.settings.${key}.hint`,
      scope: def.scope,
      config: def.config,
      type: def.type,
      default: def.default,
      ...(def.choices ? { choices: def.choices } : {}),
      ...(def.range ? { range: def.range } : {}),
    });
  }
}

/** The VRAM budget in bytes, which is the unit the texture cache actually works in. */
export function vramBudgetBytes(): number {
  return get("vramBudgetMb") * 1024 * 1024;
}
