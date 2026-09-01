/**
 * Keybindings.
 *
 * IMPURE. Registered at `init`, because `game.keybindings.register` refuses later.
 *
 * The set is small on purpose. Every binding here is one a GM uses *during* a session
 * with their attention on the table, so each has to be reachable without looking and
 * harmless if mistyped. Anything that belongs to prep lives in the Pinboard or the
 * Studio, where a GM has both hands and the time to read.
 *
 * `Alt` peek is the one binding players get. It fades every prop towards transparent
 * so the map underneath can be read — a prop lying across a corridor is exactly the
 * kind of immersive detail that becomes a nuisance the moment someone needs to count
 * squares, and taking that away from players would make GMs stop using props.
 */

import { MODULE_ID } from "../const";
import { cv, g, notify } from "../fvtt";
import * as api from "../api";
import { openPicker } from "../apps/DocumentPicker";
import { openPinboard, pinboardFocusedDoc } from "../apps/Pinboard";
import { armLastUsed, disarm, isArmed } from "../apps/PlacementGhost";
import { readPin } from "../data/PinData";

/** The class the peek state is carried by, so the CSS and the canvas agree. */
export const PEEK_CLASS = "dp-peeking";

/** Every controlled tile that is actually a pin. The target of the HUD bindings. */
function selectedPins(): any[] {
  return (cv()?.tiles?.controlled ?? [])
    .map((tile: any) => tile.document)
    .filter((doc: any) => readPin(doc));
}

/**
 * What a pin binding acts on: the selection, else the Pinboard's focused row, else
 * nothing — and "nothing" is said out loud. These used to return false in silence, so
 * a GM who pressed Alt+M with nothing selected learned nothing about why.
 */
function targets(): any[] {
  const selected = selectedPins();
  if (selected.length) return selected;
  const focused = pinboardFocusedDoc();
  if (focused) return [focused];
  notify({ key: "DP.notice.selectFirst" }, "warn");
  return [];
}

export function registerKeybindings(): void {
  const keybindings = g()?.keybindings;
  if (!keybindings?.register) return;

  keybindings.register(MODULE_ID, "pinLastUsed", {
    name: "DP.keys.pinLastUsed",
    hint: "DP.keys.pinLastUsedHint",
    editable: [{ key: "KeyP", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => {
      if (isArmed()) {
        disarm();
        return true;
      }
      // Nothing placed yet this session: what the GM wanted was to pick something.
      if (!armLastUsed()) openPicker();
      return true;
    },
  });

  keybindings.register(MODULE_ID, "openPinboard", {
    name: "DP.keys.openPinboard",
    hint: "DP.keys.openPinboardHint",
    editable: [{ key: "KeyP" }],
    restricted: true,
    onDown: () => {
      openPinboard();
      return true;
    },
  });

  keybindings.register(MODULE_ID, "cycleAudience", {
    name: "DP.keys.cycleAudience",
    hint: "DP.keys.cycleAudienceHint",
    editable: [{ key: "KeyV", modifiers: ["Alt", "Shift"] }],
    restricted: true,
    onDown: () => {
      for (const doc of targets()) void api.cycleAudience(doc);
      return true;
    },
  });

  // Not `restricted`: this is the one binding players have, and it is the reason a GM
  // can put a letter across a corridor without making the corridor unusable.
  keybindings.register(MODULE_ID, "peek", {
    name: "DP.keys.peek",
    hint: "DP.keys.peekHint",
    editable: [{ key: "AltLeft" }],
    onDown: () => {
      // Alt is also the ghost's scale modifier; scaling a ghost must not fade the map.
      if (!isArmed()) setPeek(true);
      return false;
    },
    onUp: () => {
      setPeek(false);
      return false;
    },
  });

  keybindings.register(MODULE_ID, "cancel", {
    name: "DP.keys.cancel",
    hint: "DP.keys.cancelHint",
    editable: [{ key: "Escape" }],
    // Above core's own Escape handling, so cancelling a placement does not also
    // deselect everything and close whatever else happened to be open.
    precedence: 1,
    onDown: () => {
      if (!isArmed()) return false;
      disarm();
      return true;
    },
  });

  // Registered unconditionally, like the four above it. This ran behind `if (isGM())`
  // from `Hooks.once("init")`, where `game.user` is not yet populated — so `isGM()` was
  // false for everyone, Alt+M was never registered at all, and it did not even appear in
  // Configure Controls while the README documented it. The gate was redundant anyway:
  // `restricted: true` is Foundry's own GM gate, and the other four already rely on it.
  keybindings.register(MODULE_ID, "toggleMode", {
    name: "DP.keys.toggleMode",
    hint: "DP.keys.toggleModeHint",
    editable: [{ key: "KeyM", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => {
      for (const doc of targets()) void api.toggleMode(doc);
      return true;
    },
  });

  // Alt+Shift+F rather than Alt+F: Alt+F is Chrome's menu accelerator on Windows and
  // Linux, and a page cannot reliably intercept it. Alt+Shift+V is the precedent.
  keybindings.register(MODULE_ID, "fitSelected", {
    name: "DP.keys.fitSelected",
    hint: "DP.keys.fitSelectedHint",
    editable: [{ key: "KeyF", modifiers: ["Alt", "Shift"] }],
    restricted: true,
    onDown: () => {
      for (const doc of targets()) void api.fitToContent(doc);
      return true;
    },
  });
}

/**
 * Fade every prop towards transparent while peeking.
 *
 * A class on the board rather than a per-prop write: one attribute toggle, and the
 * canvas layer and the DOM overlay both key off it, so the two tiers cannot disagree
 * about whether a peek is in progress.
 */
export function setPeek(active: boolean): void {
  document.getElementById("board")?.parentElement?.classList.toggle(PEEK_CLASS, active);
  document.getElementById("documents-pinner-overlay")?.classList.toggle(PEEK_CLASS, active);
  Hooks.callAll(`${MODULE_ID}.peek`, active);
}

declare const Hooks: any;
