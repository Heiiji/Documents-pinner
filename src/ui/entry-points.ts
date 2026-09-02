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
import { logger } from "../log";
import { g, isGM, isOurs, notify, ns } from "../fvtt";
import { visibleSceneRect } from "../canvas/transform";
import { t } from "../i18n";
import { escapeHtml } from "../html";
import * as api from "../api";
import * as settings from "../settings";
import { armAt } from "../apps/PlacementGhost";
import { openPicker } from "../apps/DocumentPicker";
import { readPin } from "../data/PinData";

const log = logger("entry");

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
  log.info(`removed ${strays.length} note(s) core created from a pin drop`);
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
        { kind: "document", uuid, src: null, pageId: null, pdfPage: null, followName: true },
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
    {
      kind: "document",
      uuid: found.uuid,
      src: null,
      pageId: null,
      pdfPage: null,
      followName: true,
    },
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
 * including one another module made — and, from the Note sheet, the module's only
 * concrete ecosystem-integration surface.
 */
export function onRenderConfig(app: any, element: HTMLElement): void {
  if (!isGM()) return;

  const doc = app?.document;
  if (!doc) return;
  if (element.querySelector(".dp-scope")) return;

  if (doc.documentName === "Note") {
    // Only for a note that actually exists. The config sheet also opens for the preview
    // document created by dropping a journal on the map, which has no id yet and cannot
    // be converted or deleted.
    if (doc.id) injectSection(element, noteSection(doc));
    return;
  }
  if (doc.documentName !== "Tile") return;

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

  injectSection(element, section);

  section.querySelector(".dp-config__toggle")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.checked) {
      // Unpinning drops the payload and releases the ownership grant, and the sheet is
      // still holding the pre-toggle data — so this one asks, and puts the switch back
      // when the answer is no.
      void confirmUnpin().then((ok) => {
        if (ok) void api.unpin(doc);
        else input.checked = true;
      });
      return;
    }
    // Adopting needs a source, and the sheet is the wrong place to choose one — but the
    // picker is told WHICH tile it is choosing for. A bare `openPicker()` armed the
    // ghost and placed an unrelated new pin somewhere else, leaving this tile untouched.
    openPicker({ adopt: doc });
  });

  section.querySelector(".dp-config__studio")?.addEventListener("click", () => {
    Hooks.call(`${MODULE_ID}.openStudio`, doc);
  });
}

/**
 * The Note sheet's row.
 *
 * A Note cannot BE an anchor — `BaseNote` has no `hidden`, `width`, `height` or
 * `rotation`, which is exactly why DESIGN §2 chose Tile — so this converts: it places a
 * real anchor where the note stands and removes the note. Destructive, so it asks.
 */
function noteSection(doc: any): HTMLElement {
  const section = document.createElement("div");
  section.className = "dp-scope dp-config";
  section.innerHTML =
    `<button type="button" class="dp-config__adopt">${t("DP.config.adoptNote")}</button>` +
    `<p class="dp-config__hint">${t("DP.config.adoptNoteHint")}</p>`;

  section.querySelector(".dp-config__adopt")?.addEventListener("click", () => {
    void confirmAdoptNote().then((ok) => {
      if (!ok) return;
      // A note that links a journal already knows its source; one that does not asks.
      if (api.sourceFromNote(doc)) void api.adoptNote(doc);
      else openPicker({ adopt: doc });
    });
  });
  return section;
}

/**
 * Put the section in the sheet.
 *
 * Appending is the fallback, not an afterthought: `anchor?.before()` on a sheet with no
 * footer is a silent no-op, and a row that quietly fails to appear is the worst outcome
 * for the one piece of DOM this module injects into a core application.
 */
function injectSection(element: HTMLElement, section: HTMLElement): void {
  const anchor = element.querySelector(".form-footer") ?? element.querySelector("footer");
  if (anchor) anchor.before(section);
  else (element.querySelector("form") ?? element).appendChild(section);
}

function confirmUnpin(): Promise<boolean> {
  return confirmAction("DP.config.unpinTitle", "DP.config.unpinBody");
}

function confirmAdoptNote(): Promise<boolean> {
  return confirmAction("DP.config.adoptNote", "DP.config.adoptNoteBody");
}

/** A yes/no dialog. A build with no DialogV2 refuses rather than acting unasked. */
async function confirmAction(titleKey: string, bodyKey: string): Promise<boolean> {
  const DialogV2 = ns("applications.api.DialogV2");
  if (!DialogV2?.confirm) return false;
  return DialogV2.confirm({
    window: { title: t(titleKey) },
    content: `<p>${escapeHtml(t(bodyKey))}</p>`,
  }).catch(() => false);
}

/** Keep a pin's label in step with a renamed source. */
export function onSourceRenamed(doc: any, changed: any, options: any): void {
  if (!isGM() || isOurs(options) || !changed?.name) return;

  for (const scene of g()?.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      const pin = readPin(tile);
      if (!pin?.source.followName) continue;
      // Two ways this pin can be about the renamed document: it points straight at it,
      // or it points at the entry and has chosen this page. The second only became
      // possible at schema 4, and without it renaming the chosen page redrew nothing.
      const named =
        pin.source.uuid === doc.uuid ||
        (!!pin.source.pageId &&
          pin.source.pageId === doc.id &&
          doc.parent?.uuid === pin.source.uuid);
      if (!named) continue;
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
