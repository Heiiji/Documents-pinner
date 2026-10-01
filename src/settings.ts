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
import { g, ns } from "./fvtt";
import { logger, setLogLevel, type LogLevel } from "./log";
import { DEFAULT_PRESET_ID } from "./effects/presets/core-presets";
import type { DpAudience } from "./types/dp";

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
   * and for a PDF page it is what happens. For HTML it needs the `foreignObject`
   * rasteriser, and `ready` probes it: the probe decodes its SVG from a `blob:` URL,
   * which taints the canvas (re-verified 2026-10-01 in Chromium 152 and Chrome 154, on a
   * real Foundry origin), so it answers `false` and text props are drawn as DOM cards.
   * The same SVG decoded from a `data:` URL does NOT taint; switching the decode and
   * verifying it live — Electron and Firefox too — is the follow-up for 0.5 (DESIGN A29).
   * This setting exists so a player on a low-VRAM machine can choose the cheap path
   * deliberately, for PDFs too.
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
  /**
   * How much this module says in the console.
   *
   * `warn` by default: Foundry's console is shared with a system and every other module,
   * and one that chatters in a GM's log is one they disable. `debug` is the diagnostic
   * surface for the three failures that are invisible from the outside — a card that will
   * not rasterise, a texture budget that keeps evicting, an ownership write that did not
   * land — and is the first thing a useful bug report needs.
   */
  logLevel: {
    scope: "client",
    config: true,
    type: String,
    default: "warn",
    choices: {
      off: "DP.settings.logLevel.off",
      error: "DP.settings.logLevel.error",
      warn: "DP.settings.logLevel.warn",
      info: "DP.settings.logLevel.info",
      debug: "DP.settings.logLevel.debug",
    },
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
  /**
   * User-authored presets, as an array of raw objects.
   *
   * World-scoped and stored raw rather than validated: a preset written by a future
   * version must survive being read by an older one, so validation happens on read
   * where unknown parameters can be dropped with a warning instead of destroyed.
   */
  userPresets: {
    scope: "world",
    config: false,
    type: Object,
    default: [],
  },
  /** Bumped by `migrations.ts` after a world-wide sweep completes. */
  schemaVersion: {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  },
  /**
   * The effect the ghost starts with. The module's signature look, not "none": a GM's
   * first prop used to have no effect at all, while the default preset was referenced
   * only by tests.
   */
  lastPreset: {
    scope: "client",
    config: false,
    type: String,
    default: DEFAULT_PRESET_ID,
  },
  /** The module version this client has been welcomed to, for the once-only dialogs. */
  seenVersion: {
    scope: "client",
    config: false,
    type: String,
    default: "",
  },
  lastSourceUuid: {
    scope: "client",
    config: false,
    type: String,
    default: "",
  },
  /** The type size the ghost was last placed with; 0 means "derive from the grid". */
  lastTypeSize: {
    scope: "client",
    config: false,
    type: Number,
    default: 0,
  },
  /**
   * Whether this client has been told about the peek key. Hold-to-peek is the one
   * binding players have, and nothing in the game ever mentioned it; the first prop a
   * player hovers says so, once.
   */
  peekTaught: {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  },
  /**
   * The pins this client's Pin Studios have hidden with "Hide while I edit", each with the
   * audience that hide remembered.
   *
   * Written BEFORE the hide, and cleared when the Studio reveals it again. A reload in
   * between — the Studio gone without its close ever running — is resumed by the `ready`
   * sweep instead of stranding the pin hidden. This client's, because the hold is: no pin
   * field, no flag, and no world write beyond the audience itself.
   */
  editHolds: {
    scope: "client",
    config: false,
    type: Object,
    default: [],
  },
} as const satisfies Record<string, SettingDef>;

/** One "Hide while I edit": which pin, the world it is in, and what its hide remembered. */
export interface EditHold {
  anchor: string;
  /**
   * The world the anchor lives in. A client setting is this browser's, across every world
   * it opens; a hold from another world is left for that world's sweep, not dropped.
   */
  world: string | null;
  restore: DpAudience["restore"];
}

export type SettingKey = keyof typeof SETTINGS;

interface SettingTypes {
  rendering: RenderingMode;
  effectsLevel: EffectsLevel;
  vramBudgetMb: number;
  autoDegrade: boolean;
  dropModifier: DropModifier;
  placementLegend: boolean;
  logLevel: LogLevel;
  defaultMode: "prop" | "pin";
  defaultAudience: "everyone" | "hidden";
  defaultOwnershipSync: boolean;
  schemaVersion: number;
  userPresets: unknown[];
  lastPreset: string;
  lastSourceUuid: string;
  lastTypeSize: number;
  seenVersion: string;
  peekTaught: boolean;
  editHolds: EditHold[];
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
    // Not through the logger: this can fail before the level is applied.
    console.warn(`${MODULE_ID} | could not store setting ${key}`, error);
  }
}

/**
 * The settings a prop is drawn from, and who hears that one changed.
 *
 * Without this a GM's preset edit, or a player switching the rendering path or the
 * effects level, reached the map only at whatever LOD pass happened next — a zoom, a
 * pan, an edit — and a preset edit not even then, since a card's key names its preset
 * and not what the preset says. The listener is injected rather than imported for the
 * same reason as `registerPresetMenu`'s opener: the prop manager reads this file.
 */
const REDRAWN_BY: ReadonlySet<SettingKey> = new Set<SettingKey>([
  "rendering",
  "effectsLevel",
  "vramBudgetMb",
  "userPresets",
]);
const redrawListeners = new Set<(key: SettingKey) => void>();

/** Hear about a change to a setting the props are drawn from. */
export function onRedrawSetting(listener: (key: SettingKey) => void): void {
  redrawListeners.add(listener);
}

function redraw(key: SettingKey): void {
  for (const listener of redrawListeners) {
    // Inside core's settings write: a throw here must not fail the write.
    try {
      listener(key);
    } catch (error) {
      logger("settings").warn(`could not redraw the props after ${key} changed`, error);
    }
  }
}

/** Register every setting. Call once, at `init`. */
export function register(): void {
  const settings = g()?.settings;
  if (!settings?.register) return;

  // The logger takes its level by injection rather than reading it, so that `log.ts` can
  // be imported by anything without a cycle back through this file.
  const applyLogLevel = () => setLogLevel(get("logLevel"));

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
      ...(key === "logLevel" ? { onChange: applyLogLevel } : {}),
      ...(REDRAWN_BY.has(key) ? { onChange: () => redraw(key) } : {}),
    });
  }

  applyLogLevel();
}

/**
 * A button in the module settings that opens the Preset Studio.
 *
 * Registered separately from the settings themselves because it needs an application
 * class, and the class cannot exist before `init` — passing the opener in keeps
 * `settings.ts` from importing an app and creating a cycle.
 */
export function registerPresetMenu(open: () => void): void {
  const settings = g()?.settings;
  const ApplicationV2 = ns("applications.api.ApplicationV2");
  if (!settings?.registerMenu || !ApplicationV2) return;

  // registerMenu wants a class it can construct; the smallest honest one opens the
  // real studio and closes itself immediately.
  class PresetMenuShim extends ApplicationV2 {
    render() {
      open();
      return this;
    }
  }

  settings.registerMenu(MODULE_ID, "presetStudio", {
    name: "DP.presets.title",
    label: "DP.presets.title",
    hint: "DP.presets.menuHint",
    icon: "fa-solid fa-wand-magic-sparkles",
    type: PresetMenuShim,
    restricted: true,
  });
}

/** The VRAM budget in bytes, which is the unit the texture cache actually works in. */
export function vramBudgetBytes(): number {
  return get("vramBudgetMb") * 1024 * 1024;
}
