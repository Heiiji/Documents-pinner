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
import { cv, g } from "./fvtt";
import { publicApi } from "./api";
import * as settings from "./settings";
import { definePinData } from "./data/PinData";
import {
  onCreateTile,
  onPreDeleteTile,
  onSourceOwnershipEdited,
  reconcile,
} from "./data/ownership-sync";
import { onCanvasReady as migrateOnCanvasReady } from "./data/migrations";
import { onPreCreateTile, onPreUpdateTile, syncAfterCoreHidden } from "./data/core-hidden";
import {
  checkTileGeometry,
  definePinnedTile,
  onTileRefreshed,
  refreshAllPins,
} from "./canvas/PinnedTile";
import { registerPropHitLayer, syncHitLayer } from "./canvas/PropHitLayer";
import { tileChangeHandler } from "./canvas/tile-hooks";
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
import { sourceLifecycleHandler, sourceUpdateHandler } from "./sources/hooks";
import { contextHookNames, hookedDocumentNames } from "./sources/index";

const log = logger("boot");

declare const Hooks: any;

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
    // AND recompute. Core awaits the canvas before `ready`, so `canvasReady` always runs
    // its first LOD pass before this answer exists. That pass now draws text props as DOM
    // cards while the answer is `null` (`PropManager`'s policy); a `true` moves them to
    // the canvas, and before the policy read `null` as DOM, a fresh load showed zero
    // cards until something unrelated scheduled another pass.
    propManager().refresh();
    // The rasteriser's fonts, encoded as data URIs, are for the canvas path only — and
    // the probe decodes from a `blob:` URL, which taints, so it answers `false` on every
    // supported browser today (DESIGN A29). Encoding every face for a path that will
    // never run cost each client its idle time at load for nothing.
    if (canRasterise) warmFontCache();
  });
  void reconcile().catch((error) => log.warn("the ready sweep of the grants failed", error));
  void onboardingReady().catch((error) => log.warn("the welcome could not be shown", error));
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
  void migrateOnCanvasReady(cv()?.scene).catch((error) => log.warn("migration failed", error));
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
// The context menus of every list a pin's source can be shown in — each adapter names its
// own (`contextHooks`). The application rides along: a compendium window fires the same
// hooks as the sidebar, and only its collection says that the row it was opened on is in a
// pack.
for (const hook of contextHookNames()) {
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
// And brought back by one, revealed, with nothing in the ledger.
Hooks.on("createTile", onCreateTile);

// And hidden or shown by one — the Tiles layer's HUD, TileConfig, the Placeables sidebar, a
// paste — which completes the audience in the same update, and moves the grant after it.
Hooks.on("preUpdateTile", onPreUpdateTile);
Hooks.on("preCreateTile", onPreCreateTile);
Hooks.on("updateTile", syncAfterCoreHidden);

// Any change to a pin's tile, by anyone: a batch of any size is one refresh (`tile-hooks`).
const onTileChanged = tileChangeHandler((ids, uuids) => {
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
  refreshStudios(uuids);
  refreshPinboard();
});

for (const hook of ["createTile", "updateTile", "deleteTile"]) Hooks.on(hook, onTileChanged);

// A token moving is what makes a prop underneath it fade, so props never obscure the
// thing the fade exists to protect.
for (const hook of ["updateToken", "createToken", "deleteToken"]) {
  Hooks.on(hook, () => propManager().applyAlpha());
}

// Every type of document a pin can show: an edit to one may rename a pin, change who holds
// it, or change what its card says — and for an actor, mostly does none of these.
const onSourceUpdated = sourceUpdateHandler({
  rebase: onSourceOwnershipEdited,
  rename: onSourceRenamed,
  invalidate: (uuid) => propManager().invalidate(uuid),
  refresh: refreshPinboard,
});
// And one created or deleted: a deleted journal, page or actor drew on until the next canvas
// draw, and a page added to a journal a pin shows whole never appeared.
const onSourceCameOrWent = sourceLifecycleHandler({
  invalidate: (uuid) => propManager().invalidate(uuid),
  refresh: refreshPinboard,
  revalidate: revalidateReader,
});
for (const type of hookedDocumentNames()) {
  Hooks.on(`update${type}`, onSourceUpdated);
  Hooks.on(`create${type}`, onSourceCameOrWent);
  Hooks.on(`delete${type}`, onSourceCameOrWent);
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
