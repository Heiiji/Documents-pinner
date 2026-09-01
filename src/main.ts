/**
 * Entry point.
 *
 * This file contains NO logic — only hook wiring — so the module's behaviour is
 * auditable at a glance and every hook has exactly one obvious owner. If a line here
 * ever needs an `if`, that `if` belongs in the module the line calls.
 *
 * Hook names that vary across builds are resolved at runtime rather than hardcoded:
 * the context-menu family in particular has been renamed twice, so every plausible
 * name is registered and the ones that never fire cost nothing.
 */

import { MODULE_ID } from "./const";
import { logger } from "./log";
import { cv, g, isOurs } from "./fvtt";
import { publicApi } from "./api";
import * as settings from "./settings";
import { definePinData } from "./data/PinData";
import { onPreDeleteTile, onSourceOwnershipEdited, reconcile } from "./data/ownership-sync";
import { onCanvasReady as migrateOnCanvasReady } from "./data/migrations";
import { definePinnedTile, refreshAllPins } from "./canvas/PinnedTile";
import { registerPropHitLayer, suspendHits, syncHitLayer } from "./canvas/PropHitLayer";
import { propManager, teardownProps } from "./canvas/PropManager";
import { probeRasterisation } from "./render/Rasterizer";
import { warmFontCache } from "./render/AssetInliner";
import { definePinHUD, refreshPinHUD } from "./apps/PinHUD";
import { openStudio, refreshStudios } from "./apps/PinStudio";
import { openPinboard, refreshPinboard } from "./apps/Pinboard";
import { openPicker } from "./apps/DocumentPicker";
import { openPresetStudio } from "./apps/PresetStudio";
import { alignToBoard, destroyOverlay, syncTransform } from "./apps/OverlayRoot";
import { closeReader, openReader, repositionReader } from "./apps/ReaderOverlay";
import { disarm } from "./apps/PlacementGhost";
import { hidePropTooltip, setPropHover } from "./apps/PropTooltip";
import { onGetSceneControlButtons } from "./ui/controls";
import { registerKeybindings } from "./ui/keybindings";
import {
  addContextOption,
  onChatMessage,
  onDropCanvasData,
  onGetHeaderControls,
  onRenderConfig,
  onSourceRenamed,
} from "./ui/entry-points";
import { readPin } from "./data/PinData";
import { followDomProp, setDomPropHover } from "./canvas/DomPropTier";
import { onboardingReady } from "./ui/onboarding";

const log = logger("boot");

declare const Hooks: any;

/** Context-menu hooks core has used across generations. Unknown names never fire. */
const CONTEXT_HOOKS = [
  "getJournalEntryContextOptions",
  "getJournalDirectoryEntryContext",
  "getJournalSheetPageContextOptions",
  "getJournalEntryPageContextOptions",
];

/** Gestures during which the prop hit areas must go dead. */
const POINTER_BUSY_HOOKS: [string, boolean][] = [
  ["dragLeftStart", true],
  ["dragLeftDrop", false],
  ["dragLeftCancel", false],
];

Hooks.once("init", () => {
  settings.register();
  settings.registerPresetMenu(() => openPresetStudio());
  definePinData();
  definePinnedTile();
  registerPropHitLayer();
  definePinHUD();
  registerKeybindings();
  log.info(`init`);
});

Hooks.once("ready", () => {
  const module = g()?.modules?.get(MODULE_ID);
  if (module) module.api = publicApi();

  // Which rendering path this client took is the first thing any bug report needs, and
  // the user cannot see it anywhere else — the probe is silent when it succeeds.
  void probeRasterisation().then((canRasterise) => {
    log.info(
      `ready | props render on the ${canRasterise ? "canvas" : "DOM"} path` +
        `${settings.get("rendering") === "dom" ? " (chosen in settings)" : ""}`
    );
    // AND recompute. The probe is asynchronous, so `canvasReady` usually runs its first
    // LOD pass while the answer is still `null` — which reads as "canvas is fine", takes
    // the canvas path, holds every prop's mesh invisible waiting for a texture that will
    // never arrive, and mounts no DOM card either. The props were then invisible until
    // something unrelated happened to schedule another pass. Measured on a fresh load:
    // zero cards; one forced recompute and all three appeared, correctly placed.
    propManager().refresh();
  });
  warmFontCache();
  void reconcile();
  void onboardingReady();

  Hooks.callAll(`${MODULE_ID}.ready`, module?.api);
});

// --- Canvas lifecycle -------------------------------------------------------

Hooks.on("canvasReady", () => {
  alignToBoard();
  syncTransform(true);
  propManager().start();
  syncHitLayer();
  void migrateOnCanvasReady(cv()?.scene);
});

Hooks.on("canvasTearDown", () => {
  disarm();
  hidePropTooltip();
  closeReader();
  teardownProps();
  destroyOverlay();
});

Hooks.on("canvasPan", () => {
  // Cheap and idempotent: both of these dirty-check before writing anything, so this
  // hook firing every tick during an animated pan costs six float comparisons.
  syncTransform();
  repositionReader();
});

for (const [hook, busy] of POINTER_BUSY_HOOKS) Hooks.on(hook, () => suspendHits(busy));

// The GM's hit areas exist on the Notes layer only, so they follow the active layer.
// The scene controls re-render whenever it changes, which is the signal core gives.
Hooks.on("renderSceneControls", () => syncHitLayer());

// Core redrew a pin's tile, so the texture we captured to restore later is stale and the
// binding we recorded belongs to a mesh that no longer exists. `PinnedTile` has fired this
// since it was written; nothing listened.
Hooks.on(`${MODULE_ID}.tileDrawn`, (tile: any) => propManager().onTileDrawn(tile));

// Core's resize handles mutate the document in memory on every tick of the drag and
// fire the generic refresh hook; the commit only arrives as `updateTile` on release.
// The DOM card and the reader follow the handles live through two dirty-checked
// re-placers, so a refresh that moved nothing — a hover, a control frame — costs a few
// compares, and if a future core commits without mutating first, the commit path above
// still does the work.
Hooks.on("refreshTile", (tile: any) => {
  if (readPin(tile?.document)?.mode !== "prop") return;
  followDomProp(tile.document);
  repositionReader();
});

// `interaction.tooltip` was offered by the Pin Studio, validated, stored — and read by
// nothing, while `PropHitLayer` fired this hook into a void. A player hovering a pin got
// no feedback at all beyond the cursor.
Hooks.on(`${MODULE_ID}.propHover`, (doc: any, hovering: boolean) => {
  setPropHover(doc, hovering);
  // The cue that says "this opens": warm light on the paper, on whichever tier draws it.
  setDomPropHover(doc?.id, hovering);
  propManager().setHover(doc?.id, hovering);
});

// --- Entry points -----------------------------------------------------------

Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
Hooks.on("dropCanvasData", onDropCanvasData);
Hooks.on("getHeaderControlsApplicationV2", onGetHeaderControls);
Hooks.on("chatMessage", onChatMessage);
// Both sheets: the Note path is the module's only ecosystem-integration surface,
// and registering only the Tile one made adopting an existing Note impossible.
Hooks.on("renderTileConfig", onRenderConfig);
Hooks.on("renderNoteConfig", onRenderConfig);
for (const hook of CONTEXT_HOOKS) {
  Hooks.on(hook, (_app: any, options: any[]) => addContextOption(options));
}

Hooks.on(`${MODULE_ID}.openPicker`, () => openPicker());
Hooks.on(`${MODULE_ID}.openBoard`, () => openPinboard());
Hooks.on(`${MODULE_ID}.openReader`, (doc: any) => void openReader(doc));
Hooks.on(`${MODULE_ID}.openStudio`, (doc: any, tab?: any) => openStudio(doc, tab));
Hooks.on(`${MODULE_ID}.openPresets`, (id?: string) => openPresetStudio(id));
Hooks.on(`${MODULE_ID}.peek`, (active: boolean) => propManager().setPeeking(active));

// --- Keeping surfaces in step with the world --------------------------------

// A pin can be deleted by any core gesture — the Tiles layer, Ctrl+Z, the Placeables
// sidebar — and every one of those must give back the ownership it granted.
Hooks.on("preDeleteTile", onPreDeleteTile);

/**
 * Tile changes, coalesced.
 *
 * Foundry fires `updateTile` once per document, so a correctly-batched fifty-pin "Reveal
 * all" arrives as fifty hook calls — and each one did O(all placeables) work: a full
 * `PropManager.refresh`, a full hit-layer rebuild (a `PIXI.Container` and a `Polygon`
 * allocated and destroyed per prop), a full Pinboard render and up to N `testVisibility`
 * calls. Fifty of those in one tick is ~2500 allocations and fifty renders for one
 * gesture.
 *
 * The ids are gathered and the refresh runs ONCE from a microtask, so a batch of any size
 * costs one pass. Everything here was already idempotent; only the arithmetic changes.
 */
const changedTiles = new Set<string>();
let tileRefreshQueued = false;

function onTileChanged(doc: any): void {
  if (doc?.id) changedTiles.add(doc.id);
  if (tileRefreshQueued) return;
  tileRefreshQueued = true;

  void Promise.resolve().then(() => {
    tileRefreshQueued = false;
    const ids = [...changedTiles];
    changedTiles.clear();

    propManager().refresh();
    syncHitLayer();
    repositionReader();
    // The HUD is bound to at most one anchor, so it only cares whether that one moved.
    for (const id of ids) refreshPinHUD({ id });
    refreshStudios();
    refreshPinboard();
  });
}

for (const hook of ["createTile", "updateTile", "deleteTile"]) Hooks.on(hook, onTileChanged);

// A token moving is what makes a prop underneath it fade, so props never obscure the
// thing the fade exists to protect.
for (const hook of ["updateToken", "createToken", "deleteToken"]) {
  Hooks.on(hook, () => propManager().applyAlpha());
}

for (const type of ["JournalEntry", "JournalEntryPage"]) {
  Hooks.on(`update${type}`, (doc: any, changed: any, options: any, userId: string) => {
    if (isOurs(options)) return;
    void onSourceOwnershipEdited(doc, changed, options, userId);
    onSourceRenamed(doc, changed, options);
    propManager().invalidate(doc.uuid);
    refreshPinboard();
  });
}

// A user connecting or disconnecting changes who is in an audience, and therefore what
// every chip shows and which props this client should be drawing at all.
for (const hook of ["userConnected", "updateUser"]) {
  Hooks.on(hook, () => {
    refreshAllPins();
    syncHitLayer();
    refreshPinboard();
  });
}
