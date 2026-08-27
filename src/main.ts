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
import { cv, g, isOurs } from "./fvtt";
import { publicApi } from "./api";
import * as settings from "./settings";
import { definePinData } from "./data/PinData";
import { onSourceOwnershipEdited, reconcile } from "./data/ownership-sync";
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
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  const module = g()?.modules?.get(MODULE_ID);
  if (module) module.api = publicApi();

  void probeRasterisation();
  warmFontCache();
  void reconcile();

  Hooks.callAll(`${MODULE_ID}.ready`, module?.api);
  console.log(`${MODULE_ID} | ready`);
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

// --- Entry points -----------------------------------------------------------

Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
Hooks.on("dropCanvasData", onDropCanvasData);
Hooks.on("getHeaderControlsApplicationV2", onGetHeaderControls);
Hooks.on("chatMessage", onChatMessage);
Hooks.on("renderTileConfig", onRenderConfig);
for (const hook of CONTEXT_HOOKS) {
  Hooks.on(hook, (_app: any, options: any[]) => addContextOption(options));
}

Hooks.on(`${MODULE_ID}.openPicker`, () => openPicker());
Hooks.on(`${MODULE_ID}.openBoard`, () => openPinboard());
Hooks.on(`${MODULE_ID}.openReader`, (doc: any) => void openReader(doc));
Hooks.on(`${MODULE_ID}.openStudio`, (doc: any, tab?: any) => openStudio(doc, tab));
Hooks.on(`${MODULE_ID}.openPresets`, () => openPresetStudio());
Hooks.on(`${MODULE_ID}.peek`, (active: boolean) => propManager().setPeeking(active));

// --- Keeping surfaces in step with the world --------------------------------

for (const hook of ["createTile", "updateTile", "deleteTile"]) {
  Hooks.on(hook, (doc: any) => {
    propManager().refresh();
    syncHitLayer();
    repositionReader();
    refreshPinHUD(doc);
    refreshStudios();
    refreshPinboard();
  });
}

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
