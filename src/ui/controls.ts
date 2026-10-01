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

import { isGM } from "../fvtt";
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
