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
import { concernsPins, definePinData } from "./data/PinData";
import { onPreDeleteTile, onSourceOwnershipEdited, reconcile } from "./data/ownership-sync";
import { onCanvasReady as migrateOnCanvasReady } from "./data/migrations";
import {
  checkTileGeometry,
  definePinnedTile,
  onTileRefreshed,
  refreshAllPins,
} from "./canvas/PinnedTile";
import { registerPropHitLayer, syncHitLayer } from "./canvas/PropHitLayer";
import { propManager, teardownProps } from "./canvas/PropManager";
import { probeRasterisation } from "./render/Rasterizer";
import { clearPdfCache } from "./render/PdfPage";
import { warmFontCache } from "./render/AssetInliner";
import { definePinHUD, refreshPinHUD } from "./apps/PinHUD";
import { openStudio, refreshStudios, resumeEditHolds } from "./apps/PinStudio";
import { openPinboard, refreshPinboard } from "./apps/Pinboard";
import { openPicker } from "./apps/DocumentPicker";
import { openPresetStudio } from "./apps/PresetStudio";
import { alignToBoard, destroyOverlay, syncTransform } from "./apps/OverlayRoot";
import { closeReader, openReader, repositionReader, revalidateReader } from "./apps/ReaderOverlay";
import { disarm } from "./apps/PlacementGhost";
import { hidePropTooltip, setPropHover } from "./apps/PropTooltip";
import { onGetSceneControlButtons } from "./ui/controls";
import { registerKeybindings, teachPeekOnce } from "./ui/keybindings";
import {
  addContextOption,
  onChatMessage,
  onDropCanvasData,
  onGetHeaderControls,
  onRenderConfig,
  onSourceRenamed,
} from "./ui/entry-points";
import { flashDomProp, setDomPropHover, syncSceneDim } from "./canvas/DomPropTier";
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
  // A pin hidden with "Hide while I edit" in a Studio this reload closed without asking.
  void resumeEditHolds().catch((error) => log.warn("could not resume the edit holds", error));

  Hooks.callAll(`${MODULE_ID}.ready`, module?.api);
});

// --- Canvas lifecycle -------------------------------------------------------

Hooks.on("canvasReady", () => {
  alignToBoard();
  syncSceneDim(true);
  syncTransform(true);
  propManager().start();
  // The one assumption every placement rests on, checked against core's own bounds.
  checkTileGeometry();
  syncHitLayer();
  void migrateOnCanvasReady(cv()?.scene);
  // An open Pinboard is about the scene being viewed; it used to keep listing the last
  // one's pins until a tile happened to change.
  refreshPinboard();
});

// The scene's darkness, for the cards drawn over the canvas. This hook fires at the end of
// the environment's own initialisation, which is where core applies a darkness change;
// `lightingRefresh` is not the signal — it fires on every light-carrying token step.
Hooks.on("initializeCanvasEnvironment", () => syncSceneDim());

Hooks.on("canvasTearDown", () => {
  disarm();
  hidePropTooltip();
  closeReader();
  teardownProps();
  destroyOverlay();
  clearPdfCache();
});

Hooks.on("canvasPan", () => {
  // Cheap and idempotent: both of these dirty-check before writing anything, so this
  // hook firing every tick during an animated pan costs six float comparisons.
  syncTransform();
  repositionReader();
});

// The GM's hit areas exist on the Notes layer only, so they follow the active layer.
// `activateCanvasLayer`, not `renderSceneControls`: choosing a layer from the controls
// RENDERS them first and activates the layer after (foundry.mjs 14.367, 146178 then
// 146202), so a rebuild on the render read the layer being left. Arriving on Notes built
// nothing; leaving it for Tokens or Walls left the GM's areas in place, where a press on a
// prop switched to Tiles in the middle of a rubber-band select or a wall. A microtask,
// because the GM's own press activates Tiles from INSIDE a hit area's handler, and the
// rebuild would destroy that container while PIXI is still dispatching to it.
Hooks.on("activateCanvasLayer", () => queueMicrotask(syncHitLayer));

// Core redrew a pin's tile, so the texture we captured to restore later is stale and the
// binding we recorded belongs to a mesh that no longer exists. `PinnedTile` has fired this
// since it was written; nothing listened.
Hooks.on(`${MODULE_ID}.tileDrawn`, (tile: any) => propManager().onTileDrawn(tile));

// Core's handles and drags mutate a document in memory on every tick and fire the
// generic refresh hook; the commit only arrives as `updateTile` on release. The card and
// the reader follow live, and a drag's preview clone speaks for its original.
Hooks.on("refreshTile", onTileRefreshed);

// `interaction.tooltip` was offered by the Pin Studio, validated, stored — and read by
// nothing, while `PropHitLayer` fired this hook into a void. A player hovering a pin got
// no feedback at all beyond the cursor.
Hooks.on(`${MODULE_ID}.propHover`, (doc: any, hovering: boolean) => {
  setPropHover(doc, hovering);
  // The cue that says "this opens": warm light on the paper, on whichever tier draws it.
  setDomPropHover(doc?.id, hovering);
  propManager().setHover(doc?.id, hovering);
  if (hovering) teachPeekOnce(doc);
});

// Flash and Locate ping inside the canvas, under a text prop's card; the card pulses.
Hooks.on(`${MODULE_ID}.flash`, (doc: any) => {
  flashDomProp(doc);
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
// The application rides along: a compendium window fires the same hooks as the sidebar,
// and only its collection says that the row it was opened on is in a pack.
for (const hook of CONTEXT_HOOKS) {
  Hooks.on(hook, (app: any, options: any[]) => addContextOption(options, app));
}

Hooks.on(`${MODULE_ID}.openPicker`, () => openPicker());
Hooks.on(`${MODULE_ID}.openBoard`, () => openPinboard());
Hooks.on(`${MODULE_ID}.openReader`, (doc: any) => {
  openReader(doc).catch((error) => log.warn(`the reader could not open`, error));
});
Hooks.on(`${MODULE_ID}.openStudio`, (doc: any, tab?: any) => openStudio(doc, tab));
Hooks.on(`${MODULE_ID}.openPresets`, (id?: string, doc?: any) => openPresetStudio(id, doc));
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

function onTileChanged(doc: any, changed?: any): void {
  if (!concernsPins(doc, changed)) return;
  if (doc?.id) changedTiles.add(doc.id);
  if (tileRefreshQueued) return;
  tileRefreshQueued = true;

  void Promise.resolve().then(() => {
    tileRefreshQueued = false;
    const ids = [...changedTiles];
    changedTiles.clear();

    // Core re-tests a tile's visibility only when `hidden`, `sort` or `locked` change.
    // Who is in a pin's audience lives in its flags, so moving a player in or out of it
    // left a pin icon — and a PDF, which is drawn on the tile's own mesh — showing to
    // the player just removed and hidden from the one just added.
    refreshAllPins(ids);
    propManager().refresh();
    syncHitLayer();
    revalidateReader();
    // The HUD is bound to at most one anchor, so it only cares whether that one moved.
    for (const id of ids) refreshPinHUD({ id });
    // Only the Studios showing a pin that changed: re-rendering every open Studio on any
    // pin's change threw away the focus — and a half-typed label — in all of them.
    refreshStudios(ids);
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
