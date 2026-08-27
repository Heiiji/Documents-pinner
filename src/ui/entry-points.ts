/**
 * The ways a document becomes a pin.
 *
 * IMPURE. Six entry points, ranked in `DESIGN.md` §5.1, all funnelling into `api`.
 *
 * The rule that shapes all of them: **native drag-to-canvas is not hijacked.** Dragging
 * a journal onto the map and getting a Map Note is the most established gesture in
 * Foundry, other modules build on it, and a module that silently changed it would be
 * blamed for every drag that ever behaved unexpectedly afterwards. So the drop handler
 * acts only with a modifier held, and every other route is additive.
 *
 * Cancellation is belt-and-braces on purpose. `dropCanvasData` returning `false` is
 * documented to cancel, but the v14 signature is typed as returning void, so we also
 * remove any Note that core creates from the same drop within a short window. If
 * cancellation works, the sweep finds nothing and costs nothing.
 */

import { MODULE_ID } from "../const";
import { g, isGM, isOurs, notify } from "../fvtt";
import { visibleSceneRect } from "../canvas/transform";
import { t } from "../i18n";
import * as api from "../api";
import * as settings from "../settings";
import { armAt } from "../apps/PlacementGhost";
import { openPicker } from "../apps/DocumentPicker";
import { readPin } from "../data/PinData";

/** Whether the configured drag modifier is currently held. */
export function modifierHeld(event?: DragEvent | MouseEvent): boolean {
  const which = settings.get("dropModifier");
  if (which === "none") return true;

  const keyboard = g()?.keyboard;
  const named = { alt: "Alt", ctrl: "Control", shift: "Shift" }[which];
  if (keyboard?.isModifierActive && named) {
    // Foundry's own modifier tracking survives an OS that eats the event's flags,
    // which macOS does for Option during an HTML5 drag.
    if (keyboard.isModifierActive(named)) return true;
  }
  if (!event) return false;
  return which === "alt" ? event.altKey : which === "ctrl" ? event.ctrlKey : event.shiftKey;
}

/**
 * `dropCanvasData`. Returns `false` to suppress core's own handling.
 *
 * Anything we do not recognise, or any drop without the modifier, falls straight
 * through to core untouched.
 */
export function onDropCanvasData(canvas: any, data: any, event?: DragEvent): boolean | void {
  if (!isGM() || !modifierHeld(event)) return;

  const source = api.sourceFromDropData(data);
  if (!source) return;

  const point = {
    x: data?.x ?? canvas?.mousePosition?.x ?? 0,
    y: data?.y ?? canvas?.mousePosition?.y ?? 0,
  };
  placeFromDrop(canvas, source, point);
  return false;
}

function placeFromDrop(canvas: any, source: any, point: { x: number; y: number }): void {
  const before = noteIds(canvas);
  armAt(source, point);
  // The ghost takes over from here; sweep away a Note core may have made anyway.
  window.setTimeout(() => void removeStrayNotes(canvas, before), 250);
}

function noteIds(canvas: any): Set<string> {
  return new Set((canvas?.scene?.notes?.contents ?? []).map((n: any) => n.id));
}

/**
 * Delete a Note that appeared from the drop we just cancelled.
 *
 * Only notes created since the drop began are considered, and only when the module is
 * the reason they would exist — so a GM who legitimately drops a second journal a
 * moment later never loses it.
 */
async function removeStrayNotes(canvas: any, before: Set<string>): Promise<void> {
  const strays = (canvas?.scene?.notes?.contents ?? [])
    .filter((note: any) => !before.has(note.id))
    .map((note: any) => note.id);
  if (!strays.length) return;

  await canvas.scene.deleteEmbeddedDocuments("Note", strays, { render: false });
  console.log(`${MODULE_ID} | removed ${strays.length} note(s) core created from a pin drop`);
}

/**
 * "Pin to scene" in a journal sheet's header.
 *
 * `getHeaderControlsApplicationV2` fires for every ApplicationV2, so the guard is on
 * the document type rather than on the application class — sheets get replaced by
 * systems and modules, document types do not.
 */
export function onGetHeaderControls(app: any, controls: any[]): void {
  if (!isGM()) return;

  const doc = app?.document;
  const source = api.sourceFromDocument(doc);
  if (!source) return;

  controls.push({
    icon: "fa-solid fa-thumbtack",
    label: "DP.controls.pinThis",
    onClick: () => armAt(source, viewportCentre()),
  });
}

/** Sidebar and page context menus. The hook name differs by collection, so both wire here. */
export function addContextOption(options: any[]): void {
  if (!isGM()) return;

  options.push({
    name: "DP.controls.pinThis",
    icon: '<i class="fa-solid fa-thumbtack"></i>',
    condition: () => isGM(),
    callback: (target: any) => {
      const uuid = uuidFromContextTarget(target);
      if (!uuid) return;
      armAt(
        { kind: "document", uuid, src: null, pageId: null, followName: true },
        viewportCentre()
      );
    },
  });
}

/**
 * The uuid behind a context-menu target.
 *
 * Core has handed this callback a jQuery element, a plain element and (in v13+) the
 * document itself across versions, so all three shapes are accepted rather than
 * guessing which one this build uses.
 */
function uuidFromContextTarget(target: any): string | null {
  if (typeof target?.uuid === "string") return target.uuid;

  const element: HTMLElement | null = target?.[0] ?? target;
  const id = element?.dataset?.entryId ?? element?.dataset?.documentId ?? element?.dataset?.pageId;
  if (!id) return null;

  const doc =
    g()?.journal?.get(id) ??
    g()
      ?.journal?.contents?.flatMap((e: any) => e.pages?.contents ?? [])
      ?.find((p: any) => p.id === id);
  return doc?.uuid ?? null;
}

/**
 * `/pin <search>` in chat.
 *
 * Returns `false` to swallow the message when it matched, so the command never posts
 * itself to the log.
 */
export function onChatMessage(_log: any, message: string): boolean | void {
  if (!isGM()) return;
  const match = /^\/pin\b\s*(.*)$/i.exec(message.trim());
  if (!match) return;

  const query = match[1].trim();
  if (!query) {
    openPicker();
    return false;
  }

  const needle = query.toLowerCase();
  const candidates = (g()?.journal?.contents ?? []).flatMap((entry: any) => [
    entry,
    ...(entry.pages?.contents ?? []),
  ]);
  const found = candidates.find((doc: any) => doc.name?.toLowerCase().includes(needle));

  if (!found) {
    notify(t("DP.chat.noMatch", { query }), "warn");
    return false;
  }
  armAt(
    { kind: "document", uuid: found.uuid, src: null, pageId: null, followName: true },
    viewportCentre()
  );
  return false;
}

/**
 * The three-element section injected into the Tile and Note config sheets.
 *
 * Deliberately tiny. Injecting into a core ApplicationV2's DOM is the most fragile
 * thing this module does, so the blast radius is one row: a switch, a thumbnail and a
 * link out to the Studio. It is also the one-click path for adopting an existing tile,
 * including one another module made.
 */
export function onRenderConfig(app: any, element: HTMLElement): void {
  if (!isGM()) return;

  const doc = app?.document;
  if (!doc || doc.documentName !== "Tile") return;
  if (element.querySelector(".dp-scope")) return;

  const pin = readPin(doc);
  const section = document.createElement("div");
  section.className = "dp-scope dp-config";
  section.innerHTML =
    `<label class="dp-config__row">` +
    `<input type="checkbox" class="dp-config__toggle"${pin ? " checked" : ""}>` +
    `<span>${t("DP.config.isPin")}</span></label>` +
    (pin
      ? `<button type="button" class="dp-config__studio">${t("DP.config.openStudio")}</button>`
      : "");

  const anchor = element.querySelector(".form-footer") ?? element.querySelector("footer");
  anchor?.before(section);

  section.querySelector(".dp-config__toggle")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    if (!checked) {
      void api.unpin(doc);
      return;
    }
    // Adopting needs a source, and the sheet is the wrong place to choose one.
    openPicker();
  });

  section.querySelector(".dp-config__studio")?.addEventListener("click", () => {
    Hooks.call(`${MODULE_ID}.openStudio`, doc);
  });
}

/** Keep a pin's label in step with a renamed source. */
export function onSourceRenamed(doc: any, changed: any, options: any): void {
  if (!isGM() || isOurs(options) || !changed?.name) return;

  for (const scene of g()?.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      const pin = readPin(tile);
      if (!pin?.source.followName || pin.source.uuid !== doc.uuid) continue;
      // The label is derived at render time from the source, so nothing needs writing;
      // the canvas just has to be told to redraw it.
      tile.object?.renderFlags?.set?.({ redraw: true });
    }
  }
}

/**
 * The centre of what the GM is currently looking at.
 *
 * Where a ghost armed from a menu or a chat command should appear: under the cursor is
 * wrong when the cursor is over the sidebar, and the scene origin is off-screen.
 */
function viewportCentre(): { x: number; y: number } {
  const rect = visibleSceneRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

declare const Hooks: any;
