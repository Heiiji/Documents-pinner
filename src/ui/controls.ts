/**
 * Scene control buttons.
 *
 * IMPURE. Two tools, both under **Notes** — no new top-level group. The control rail
 * is contested space and pins belong beside map notes conceptually, so taking a whole
 * rail slot for a module would cost every other module's users room they need more.
 *
 * v14 hands `getSceneControlButtons` a RECORD keyed by control name, and the tools
 * inside it are a record too. A tool with neither `onChange` nor `onClick` throws in
 * core, so both of ours are `button: true` with an `onChange`.
 */

import { cv, isGM } from "../fvtt";
import { openPicker } from "../apps/DocumentPicker";
import { openPinboard } from "../apps/Pinboard";

/**
 * Add the tools to the Notes control.
 *
 * Everything is guarded: `controls.notes` may be absent on a scene-less client, and a
 * module that throws inside this hook takes the entire control rail down with it —
 * which reads to the user as "Foundry is broken", not "that module is broken".
 */
export function onGetSceneControlButtons(controls: any): void {
  if (!isGM()) return;

  const notes = controls?.notes;
  if (!notes?.tools) return;

  const order = Object.keys(notes.tools).length;

  notes.tools["dp-pin"] = {
    name: "dp-pin",
    title: "DP.controls.pin",
    icon: "fa-solid fa-thumbtack",
    order,
    button: true,
    visible: true,
    onChange: () => openPicker(),
  };

  notes.tools["dp-board"] = {
    name: "dp-board",
    title: "DP.controls.board",
    icon: "fa-solid fa-list-check",
    order: order + 1,
    button: true,
    visible: true,
    onChange: () => openPinboard(),
  };

}

/**
 * Switch to the Tiles layer, which is where a pin can be moved, resized and rotated.
 *
 * Used by `locate`: "here it is" that leaves the GM unable to touch what was just found
 * is half an answer. The "Move and resize pins" toolbar button that used to sit beside
 * the two tools above is gone: a press on a prop from the Notes layer now does this
 * itself, through the hit layer, so the detour no longer needs a sign.
 */
export function activateTilesLayer(): boolean {
  const tiles = cv()?.tiles;
  if (!tiles?.activate) return false;
  tiles.activate();
  return true;
}
