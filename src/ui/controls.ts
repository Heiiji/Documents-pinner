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

  /**
   * The gap between where pins are PLACED and where they are EDITED.
   *
   * §5.1 put these tools under Notes deliberately, and the anchors are Tiles — so a GM who
   * places a pin from here and then tries to drag it gets nothing at all. Core only lets a
   * Tile be selected while the Tiles layer is active: `control()` simply returns false
   * otherwise, with no error and no cursor change to explain it. Measured in a live world,
   * and it is exactly what "there is no way for me to resize or move the document" was.
   *
   * One click to cross that gap, next to the tools that created the problem.
   */
  notes.tools["dp-edit"] = {
    name: "dp-edit",
    title: "DP.controls.edit",
    icon: "fa-solid fa-up-down-left-right",
    order: order + 2,
    button: true,
    visible: true,
    onChange: () => activateTilesLayer(),
  };
}

/**
 * Switch to the Tiles layer, which is where a pin can be moved, resized and rotated.
 *
 * Exported because the Pinboard and the Studio need it too: "locate this pin" that leaves
 * the GM unable to touch what it just found is only half an answer.
 */
export function activateTilesLayer(): boolean {
  const tiles = cv()?.tiles;
  if (!tiles?.activate) return false;
  tiles.activate();
  return true;
}
