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
import { definePinHUD } from "./apps/PinHUD";
import { openPinboard, refreshPinboard } from "./apps/Pinboard";
import { openPicker } from "./apps/DocumentPicker";
import { alignToBoard, destroyOverlay, syncTransform } from "./apps/OverlayRoot";
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

Hooks.once("init", () => {
  settings.register();
  definePinData();
  definePinHUD();
  registerKeybindings();
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  const module = g()?.modules?.get(MODULE_ID);
  if (module) module.api = publicApi();

  void reconcile();
  Hooks.callAll(`${MODULE_ID}.ready`, module?.api);
  console.log(`${MODULE_ID} | ready`);
});

// --- Canvas lifecycle -------------------------------------------------------

Hooks.on("canvasReady", () => {
  alignToBoard();
  syncTransform(true);
  void migrateOnCanvasReady(cv()?.scene);
});

Hooks.on("canvasTearDown", () => {
  disarm();
  destroyOverlay();
});

// --- Entry points -----------------------------------------------------------

Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
Hooks.on("dropCanvasData", onDropCanvasData);
Hooks.on("getHeaderControlsApplicationV2", onGetHeaderControls);
Hooks.on("chatMessage", onChatMessage);
Hooks.on("renderTileConfig", onRenderConfig);
for (const hook of CONTEXT_HOOKS)
  Hooks.on(hook, (_app: any, options: any[]) => addContextOption(options));

Hooks.on(`${MODULE_ID}.openPicker`, () => openPicker());
Hooks.on(`${MODULE_ID}.openBoard`, () => openPinboard());

// --- Keeping surfaces in step with the world --------------------------------

for (const hook of ["createTile", "updateTile", "deleteTile"]) {
  Hooks.on(hook, () => refreshPinboard());
}

for (const type of ["JournalEntry", "JournalEntryPage"]) {
  Hooks.on(`update${type}`, (doc: any, changed: any, options: any, userId: string) => {
    if (isOurs(options)) return;
    void onSourceOwnershipEdited(doc, changed, options, userId);
    onSourceRenamed(doc, changed, options);
    refreshPinboard();
  });
}
