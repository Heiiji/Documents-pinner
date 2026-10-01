/**
 * Pin Studio — everything about one pin.
 *
 * IMPURE. A bespoke ApplicationV2, deliberately NOT a tab bolted onto the core Tile
 * config: there are more than twenty controls and a live preview here, none of which
 * fit a sheet built for a tile's geometry, and mutating a core class's `static PARTS`
 * to make room would be monkey-patching a class other modules also extend.
 *
 * The interaction model is the point:
 *
 * - **No Save button.** `submitOnChange` with `closeOnSubmit: false` means every change
 *   lands on the canvas as it is made. A GM adjusting an effect against a specific map
 *   is asking "does this read *here*", and a dialog that answers only after you commit
 *   and reopen cannot answer it at all.
 * - **Three tabs, one question each.** Content is what it says, Appearance is what it
 *   looks like, Audience is who gets it. Nothing that belongs to one appears in another.
 * - **The audience tab is the same chip widget as the HUD and the Pinboard.** A GM
 *   should never have to learn a second vocabulary for the module's central idea.
 */

import { MODULE_ID } from "../const";
import { browseFiles, cfg, confirmDialog, g, notify, ns, playerIds } from "../fvtt";
import { previewIntensity } from "../canvas/DomPropTier";
import { t } from "../i18n";
import { escapeHtml } from "../html";
import * as api from "../api";
import { logger } from "../log";
import { hidden, resumeAfterEdit } from "../data/audience";
import type { EditHold } from "../settings";
import { readPin } from "../data/PinData";
import { freezeMetrics } from "../data/pin-schema";
import { registeredFontFamilies } from "../render/AssetInliner";
import { playRevealSound, revealSoundOf } from "../effects/reveal-sound";
import { soundPath } from "../normalise";
import { pdfPageCount } from "../render/PdfPage";
import { openPicker } from "./DocumentPicker";
import { docOf, restoreFocus, snapshotFocus } from "./focus-restore";
import { resumeOne, worldId, writeHolds } from "./edit-holds";
import {
  TABS,
  formToPatch,
  gridOf,
  pdfOf,
  studioId,
  studioMarkup,
  valueOf,
  type StudioLive,
  type TabId,
} from "./pin-studio-markup";
import type { DpNotice, DpPinFlags, DpSource } from "../types/dp";

// The `ready` sweep lives with the holds it ends; `main.ts` and the tests read it here.
export { resumeEditHolds } from "./edit-holds";
// The markup and the form's mapping live in `pin-studio-markup.ts`; the tests read them here.
export {
  formToPatch,
  liveBanner,
  studioMarkup,
  valueOf,
  type StudioLive,
  type StudioOptions,
} from "./pin-studio-markup";

const log = logger("studio");

let StudioClass: any = null;
/**
 * The open Studios, by their pin's UUID. Not its id: a duplicated scene — and one imported
 * twice from a compendium — keeps every tile's id, so opening the Studio for a pin on
 * "Tavern (night)" brought forward the one for its twin on "Tavern (day)", and every edit
 * went to the other scene's pin.
 */
const open = new Map<string, any>();

/** Whether a pin's tile is still on its scene. Where the scene cannot say, it is. */
function placed(doc: any): boolean {
  const tiles = doc?.parent?.tiles;
  if (typeof tiles?.get !== "function") return true;
  return tiles.get(doc.id) !== undefined && tiles.get(doc.id) !== null;
}

/** A pin's key in `open`. */
const keyOf = (doc: any): string => String(doc?.uuid ?? doc?.id ?? "");

/** How many pages the PDF a pin shows has, or 0 when there is no answer. */
async function pdfPageCountOf(shown: any): Promise<number> {
  const src = pdfOf(shown);
  if (!src) return 0;
  try {
    return await pdfPageCount(src);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

export function definePinStudio(): any {
  if (StudioClass) return StudioClass;

  const ApplicationV2 = ns("applications.api.ApplicationV2");
  if (!ApplicationV2) return null;

  StudioClass = class PinStudio extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ["dp-scope", "dp-studio-app"],
      tag: "form",
      window: { title: "DP.studio.title", icon: "fa-solid fa-sliders", resizable: true },
      // Tall enough for the Appearance tab's gallery to show without a scroll on a
      // laptop; the window is resizable for anything narrower.
      position: { width: 500, height: 700 },
      form: { submitOnChange: true, closeOnSubmit: false },
      actions: {
        setTab: onSetTab,
        browseIcon: onBrowseIcon,
        browseRevealSound: onBrowseRevealSound,
        previewRevealSound: onPreviewRevealSound,
        clearRevealSound: onClearRevealSound,
        setEffect: onSetEffect,
        locate: onLocate,
        fitHeight: onFitHeight,
        resetSize: onResetSize,
        editPresets: onEditPresets,
        retargetSource: onRetargetSource,
        deletePin: onDeletePin,
        holdForEdit: onHoldForEdit,
        resumeEdit: onResumeEdit,
      },
    };

    doc: any = null;
    tab: TabId = "content";
    /** Whether editing one dimension in the strip carries the other with it. */
    aspectLocked = false;
    /** Where the focus goes after the next render, when it is not where it was. */
    focusAfterRender: string | null = null;
    /**
     * The hold this Studio placed with "Hide while I edit", or null. Kept here for the
     * banner and the close, and in the `editHolds` setting for a reload.
     */
    hold: EditHold | null = null;
    /** The hide in flight, so a close in the middle of it ends the hold after it lands. */
    hiding: Promise<void> | null = null;

    /** Who is watching, and whether this Studio has hidden the pin from them. */
    liveState(pin: DpPinFlags): StudioLive {
      const doc = this.doc;
      return {
        revealed: api.isRevealed(doc, pin),
        count: playerIds().filter((id) => api.canUserSee(doc, id)).length,
        held: !!this.hold && resumeAfterEdit(pin.audience, this.hold.restore) !== null,
      };
    }

    /**
     * "Hide while I edit", in the order that can never strand the pin: the hold is
     * written, THEN the pin is hidden, then the hide is checked. A reload between the
     * first two finds the pin still showing and drops the hold; the other order could
     * leave it hidden with nothing to bring it back.
     */
    async holdForEdit() {
      const doc = this.doc;
      const pin = readPin(doc);
      if (!pin || !doc?.uuid || !api.isRevealed(doc, pin)) return;

      const next = hidden(pin.audience);
      const hold: EditHold = { anchor: doc.uuid, world: worldId(), restore: next.restore };
      const release = () => writeHolds((holds) => holds.filter((h) => h.anchor !== hold.anchor));
      await writeHolds((holds) => [...holds.filter((h) => h.anchor !== hold.anchor), hold]);
      // Closed while the hold was being written: nothing was hidden, so nothing is held.
      if (!this.rendered) return release();

      // Held before the hide lands, so the render the hide itself triggers already shows
      // the way back, and a hide that throws still has its hold ended by the close.
      this.hold = hold;
      this.hiding = api.setAudience(doc, next);
      try {
        await this.hiding;
      } finally {
        this.hiding = null;
      }

      // A write core refused still resolves: keep the hold only if the pin now hides.
      const after = readPin(doc);
      if (!after || (doc.hidden !== true && after.audience.kind !== "hidden")) {
        this.hold = null;
        await release();
        notify({ key: "DP.notice.editHoldFailed" }, "error");
        return;
      }
      this.render();
    }

    /**
     * End the hold: reveal the pin again if it is still as the hold left it, and forget
     * the hold whatever happens — a pin the GM revealed or re-hid by hand is theirs.
     */
    async resumeHold() {
      const hold = this.hold;
      if (!hold) return;
      this.hold = null;
      try {
        // A close in the middle of the hide waits for it: resuming first would find the
        // pin still showing, and the hide would land after, with no hold left to end it.
        await this.hiding?.catch(() => undefined);
        await resumeOne(hold);
      } finally {
        await writeHolds((holds) => holds.filter((h) => h.anchor !== hold.anchor));
      }
      if (this.rendered) this.render();
    }

    /**
     * The pin showed again since the hide: whatever the GM does to it next is theirs, not
     * the close's.
     *
     * `resumeAfterEdit` can only compare what the pin remembers with what the hold
     * remembers, and a pin shown again by hand and hidden again by hand remembers the
     * same audience — so the close revealed it against the GM's last word. The hold ends
     * the moment the pin is seen showing, in memory and in the setting a reload reads.
     */
    dropHold() {
      const hold = this.hold;
      if (!hold) return;
      this.hold = null;
      void writeHolds((holds) => holds.filter((h) => h.anchor !== hold.anchor)).catch(
        (error: unknown) => log.warn("could not forget the edit hold", error)
      );
    }

    /** The fire-and-forget form the close and the banner's button use. */
    runResume() {
      void this.resumeHold().catch((error: unknown) => {
        log.warn("could not reveal the pin again after editing", error);
        notify({ key: "DP.notice.editHoldResumeFailed" }, "error");
      });
    }

    /**
     * Closing the Studio ends its hold. Core calls this after the window has gone and
     * does not await it, so nothing here may throw into it; the reveal runs on its own.
     */
    _onClose(options: unknown) {
      try {
        super._onClose?.(options);
        if (this.hold) this.runResume();
      } catch (error) {
        log.warn("the Studio did not close cleanly", error);
      }
    }

    /**
     * The pin's name in the title bar. Every Studio said "Pin Studio", and a GM with
     * three of them open could tell them apart only by reading their fields.
     */
    get title(): string {
      const pin = readPin(this.doc);
      return pin ? t("DP.studio.titleFor", { name: api.labelFor(pin) }) : t("DP.studio.title");
    }

    async _renderHTML() {
      // A deleted tile keeps its data, flag and all, so a Studio left open over a pin deleted
      // elsewhere — the Pinboard, the Tiles layer, Ctrl+Z, another GM — rendered every
      // control, and every change then failed against a document that no longer exists.
      const pin = placed(this.doc) ? readPin(this.doc) : null;
      // Every audience change reaches an open Studio as a render — `refreshStudios` on the
      // tile's update, or the chip handler's own — so the first render that finds the pin
      // showing, outside the hide's own write, is where a hold learns it is over.
      const showing = this.doc?.hidden !== true && pin?.audience.kind !== "hidden";
      if (pin && showing && this.hold && !this.hiding) this.dropHold();
      // A compendium document is loaded to list its pages and read its PDF: the index
      // its pack keeps knows neither. A world one is at hand, as it always was.
      const shown = pin ? await api.shownSource(pin) : null;
      // The window's own document, which a detached Studio's popup has to itself.
      const wrapper = (docOf(this.element) ?? document).createElement("div");
      wrapper.innerHTML = pin
        ? studioMarkup(this.doc, pin, this.tab, {
            aspectLocked: this.aspectLocked,
            live: this.liveState(pin),
            pages: await api.pageChoicesFor(pin),
            // Awaited here and not in the markup: parsing a PDF is not free and the
            // markup builder must stay synchronous and world-free. A count that fails to
            // arrive leaves the field with no ceiling, which is still a usable control.
            pdfPages: await pdfPageCountOf(shown),
            shownIsPdf: pdfOf(shown) !== null,
            fields: api.fieldChoices(pin),
            icons: noteIcons(),
            fonts: registeredFontFamilies(),
            canBrowse: !!ns("applications.apps.FilePicker.implementation"),
          })
        : `<p class="dp-studio__gone">${escapeHtml(t("DP.studio.gone"))}</p>`;
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Every change re-renders the whole form, which started the tab at the top again
      // on each slider tick. Keep the scroll when the tab is the same one.
      const before = content.querySelector<HTMLElement>(".dp-studio__tab");
      const scrollTop = before?.dataset.dpTab === this.tab ? before.scrollTop : 0;
      // And keep the focus, which the same render destroyed: a slider moved with the
      // arrow keys commits on every step, so it could be moved exactly one step, and a
      // GM tabbing down the form was sent back to the window after each field.
      const focus = snapshotFocus(content);

      content.replaceChildren(result);
      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      this.#wire(result);

      const after = content.querySelector<HTMLElement>(".dp-studio__tab");
      if (after && scrollTop) after.scrollTop = scrollTop;

      // ApplicationV2 writes the title bar once, when the frame is built; a pin renamed
      // while its Studio is open is renamed here too.
      // An element, by its node type: in a detached window it is not an instance of the
      // main window's `HTMLElement`, and the title went stale there.
      const bar = this.window?.title;
      if (bar?.nodeType === 1 && bar.textContent !== this.title) bar.textContent = this.title;

      if (this.focusAfterRender) {
        content.querySelector<HTMLElement>(this.focusAfterRender)?.focus({ preventScroll: true });
        this.focusAfterRender = null;
      } else {
        restoreFocus(content, focus);
      }
    }

    #wire(root: HTMLElement) {
      // One listener for every control: `submitOnChange` fires on the form, and going
      // through it keeps the whole form on one code path rather than one per field.
      root.addEventListener("change", (event) => {
        const target = event.target as HTMLInputElement;
        if (!target?.name) return;
        api.fireAndReport(this.#apply(target));
      });

      root.addEventListener("input", (event) => {
        const target = event.target as HTMLInputElement;
        if (target?.type !== "range") return;
        const output = target.nextElementSibling;
        if (output?.tagName === "OUTPUT") {
          output.textContent = `${target.value}${target.dataset.dpUnit ?? ""}`;
        }
        // The prop previews the intensity as the slider moves; the commit is on change.
        if (target.name === "effect.intensity") {
          previewIntensity(this.doc?.id, valueOf(target) as number);
        }
      });

      // The arrows move along the tab row, and the tab they reach is the one shown.
      root.addEventListener("keydown", (event) => {
        const tab = (event.target as HTMLElement)?.closest?.<HTMLElement>(".dp-studio__tabbtn");
        if (!tab) return;
        const at = TABS.findIndex((entry) => entry.id === tab.dataset.dpTab);
        const next =
          event.key === "ArrowRight"
            ? (at + 1) % TABS.length
            : event.key === "ArrowLeft"
              ? (at - 1 + TABS.length) % TABS.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? TABS.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        this.tab = TABS[next].id;
        this.focusAfterRender = `.dp-studio__tabbtn[data-dp-tab="${TABS[next].id}"]`;
        this.render();
      });

      root.addEventListener("click", (event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>(".dp-chip");
        if (!chip) return;
        event.preventDefault();
        const change = api.chipClick(this.doc, chip.dataset.dpUser ?? "", {
          solo: (event as MouseEvent).shiftKey,
          wasOn: chip.getAttribute("aria-checked") === "true",
        });
        api.fireAndReport(change, () => this.render());
      });
    }

    async #apply(target: HTMLInputElement) {
      // The placement strip writes tile fields, not the pin payload.
      if (target.name.startsWith("_")) {
        const field = target.name.slice(1);
        if (field === "aspect") {
          this.aspectLocked = target.checked;
          return;
        }
        if (field === "icon") {
          await api.setPinIcon(this.doc, target.value);
          return;
        }
        // An emptied field is a GM part-way through typing, not a request for a
        // one-pixel tile — which is what `Number("")` clamped to on the way through
        // `#resize`. The same rule the payload's own number input follows in `valueOf`.
        if (target.type === "number" && target.value === "") return;
        if (field === "width" || field === "height") {
          await this.#resize(field, Number(target.value));
          return;
        }
        const value = target.type === "checkbox" ? target.checked : Number(target.value);
        await this.doc.update({ [field]: value });
        return;
      }

      if (target.name === "mode") {
        await api.setMode(this.doc, target.value as any);
        this.render();
        return;
      }

      // "Some players" with nobody chosen reaches nobody while its kind says otherwise —
      // the Pinboard counted such a pin as visible, over a row of hollow chips. The HUD
      // never allowed it; the dropdown wrote it. Now both ask for a player instead, and
      // both take back a selection the pin remembers from before it was hidden.
      if (target.name === "audience.kind" && target.value === "selected") {
        if (await api.chooseSome(this.doc)) return;
        target.value = readPin(this.doc)?.audience.kind ?? "hidden";
        const status = target
          .closest(".dp-studio")
          ?.querySelector<HTMLElement>(".dp-studio__status");
        if (status) status.textContent = t("DP.hud.chooseWho");
        target.closest(".dp-studio")?.querySelector<HTMLElement>(".dp-chip")?.focus();
        return;
      }

      const patch = formToPatch([[target.name, valueOf(target)]]);

      // Touching one metric must not leave the other proportional: a stored type with a
      // margin still derived from the short edge would drift on the next resize, which is
      // the exact thing storing the type exists to stop. So the first edit freezes both.
      if (target.name === "display.typeSize" || target.name === "display.margin") {
        const pin = readPin(this.doc);
        if (pin && (pin.display.typeSize === null || pin.display.margin === null)) {
          const frozen = freezeMetrics(pin, this.doc).display;
          patch.display = { typeSize: frozen.typeSize, margin: frozen.margin, ...patch.display };
        }
      }

      // Deep-merged and ownership-synced in one call: spreading the patch here would
      // replace a whole group, and `{ ownershipSync: { level } }` would then wipe the
      // `enabled` flag beside it.
      await api.patchAndSync(this.doc, patch);

      // Which controls exist depends on the chosen page: pick a PDF page and the PDF
      // field has to appear, the Appearance tab flips to its inert variant, and the pin
      // changes rendering tier. `refreshStudios` gets there on `updateTile` anyway; this
      // is the difference between instant and a hook away.
      if (target.name === "source.pageId") this.render();
    }

    /** One dimension from the strip, in squares; the other follows if the ratio is locked. */
    async #resize(axis: "width" | "height", squaresWanted: number) {
      const grid = gridOf(this.doc);
      const px = Math.max(1, Math.round(squaresWanted * grid));
      let width = Number(this.doc.width) || 1;
      let height = Number(this.doc.height) || 1;
      if (axis === "width") {
        const ratio = height / width;
        width = px;
        if (this.aspectLocked) height = Math.max(1, Math.round(px * ratio));
      } else {
        const ratio = width / height;
        height = px;
        if (this.aspectLocked) width = Math.max(1, Math.round(px * ratio));
      }
      await api.resize(this.doc, { width, height });
      this.render();
    }
  };

  return StudioClass;
}

function onSetTab(this: any, _event: Event, target: HTMLElement) {
  this.tab = (target.dataset.dpTab ?? "content") as TabId;
  this.render();
}

function onSetEffect(this: any, _event: Event, target: HTMLElement) {
  const id = target.dataset.dpPreset;
  if (!id) return;
  api.fireAndReport(api.setEffect(this.doc, id), () => this.render());
}

function onLocate(this: any) {
  void api.locate(this.doc);
}

function onFitHeight(this: any) {
  api.fireAndReport(api.fitToContent(this.doc), () => this.render());
}

/** The pin rides along, so the Preset Studio can offer to put a new preset on it. */
function onEditPresets(this: any) {
  Hooks.call(`${MODULE_ID}.openPresets`, readPin(this.doc)?.effect.id, this.doc);
}

/** Any image as this pin's icon, from the file browser. */
function onBrowseIcon(this: any) {
  const doc = this.doc;
  browseFiles("image", (path) => api.fireAndReport(api.setPinIcon(doc, path)), doc?.texture?.src);
}

/**
 * Store this prop's own reveal sound, or refuse it and say so.
 *
 * The pin normaliser refuses a bad path too — but silently, and by storing a null over
 * whatever the prop had. Checked here first, so a refused pick changes nothing.
 */
async function setRevealSound(doc: any, value: string | null): Promise<void> {
  const warnings: DpNotice[] = [];
  const path = soundPath(value, warnings, "effect.revealSound", "DP.pin.warn.badSound");
  for (const warning of warnings) notify(warning, "warn");
  if (warnings.length || !readPin(doc)) return;
  await api.patchAndSync(doc, { effect: { revealSound: path } });
}

/**
 * Choose this prop's reveal sound from the file browser, audio only. Closes over `doc`,
 * never `this`: the browser outlives the Studio if the GM closes it first.
 */
function onBrowseRevealSound(this: any) {
  const doc = this.doc;
  const pin = readPin(doc);
  if (pin?.mode !== "prop") return;
  browseFiles(
    "audio",
    (path) =>
      void setRevealSound(doc, path).catch((error: unknown) =>
        log.warn(`the reveal sound could not be set`, error)
      ),
    pin.effect.revealSound ?? ""
  );
}

/** Hear what the players will hear when this prop arrives. */
function onPreviewRevealSound(this: any) {
  const pin = readPin(this.doc);
  if (pin) playRevealSound(revealSoundOf(pin), { preview: true });
}

/** Back to the effect's own sound. */
function onClearRevealSound(this: any) {
  void setRevealSound(this.doc, null).catch((error: unknown) =>
    log.warn(`the reveal sound could not be cleared`, error)
  );
}

/**
 * Core's map-note icons, which is the set a GM already knows from placing notes.
 * Labels may be localisation keys; `localize` returns anything else unchanged.
 */
function noteIcons(): { label: string; src: string }[] {
  const icons = cfg()?.JournalEntry?.noteIcons;
  if (!icons || typeof icons !== "object") return [];
  const localize = (label: string) => g()?.i18n?.localize?.(label) ?? label;
  return Object.entries(icons)
    .filter(([, src]) => typeof src === "string" && src)
    .map(([label, src]) => ({ label: localize(label), src: src as string }));
}

function onResetSize(this: any) {
  api.fireAndReport(api.resetSize(this.doc), () => this.render());
}

/**
 * Delete asks first.
 *
 * The only action in the Studio that does. Everything else here is one change to undo;
 * this one is not, and it is sitting next to controls a GM is clicking quickly.
 */
function onDeletePin(this: any) {
  api.fireAndReport(deleteAfterAsking(this));
}

async function deleteAfterAsking(app: any): Promise<void> {
  if (!(await confirmDialog("DP.studio.delete", "DP.board.deleteBody", { count: 1 }))) return;

  await api.deletePin(app.doc);
  app.close();
}

function onHoldForEdit(this: any) {
  void this.holdForEdit().catch((error: unknown) => {
    log.warn("could not hide the pin for editing", error);
    notify({ key: "DP.notice.editHoldFailed" }, "error");
  });
}

function onResumeEdit(this: any) {
  this.runResume();
}

/**
 * Point this pin at a different document.
 *
 * Asks AFTER the picker, not before, so the dialog can name the document — which is what
 * makes the confirmation informative rather than ritual — and because a GM asked before
 * choosing is being asked to confirm a decision they have not made yet. It asks at all
 * for the reason delete does: this is not one change to undo. It rewrites the source,
 * moves an ownership grant between two documents, and changes what players looking at the
 * map are seeing right now. Two of those three are invisible from this window.
 *
 * Closes over `doc`, never `this`: the picker is a separate application and outlives the
 * Studio if the GM closes it while the picker is open.
 */
function onRetargetSource(this: any) {
  const doc = this.doc;
  openPicker({
    onChoose: (source) => {
      api.fireAndReport(confirmRetarget(source).then((ok) => ok && api.retarget(doc, source)));
    },
  });
}

function confirmRetarget(source: DpSource): Promise<boolean> {
  return confirmDialog("DP.studio.retargetTitle", "DP.studio.retargetBody", {
    name: api.labelForSource(source),
  });
}

/**
 * Open the Studio for a pin, reusing the window already showing it — that pin's, and no
 * other's. A window still holding another copy of the document is replaced, never edited
 * through.
 */
export function openStudio(doc: any, tab: TabId = "content"): any {
  const Studio = definePinStudio();
  if (!Studio || !doc) return null;

  const key = keyOf(doc);
  let app = open.get(key);
  if (app && app.doc !== doc) {
    void app.close();
    app = null;
  }
  if (!app) {
    app = new Studio({ id: studioId(doc) });
    app.doc = doc;
    open.set(key, app);
  }
  app.tab = tab;
  app.render({ force: true });
  return app;
}

/**
 * Re-render the open Studios for these pins, by UUID, or every one when none are given.
 * Wired to the tile hooks, which pass the pins that changed.
 */
export function refreshStudios(uuids?: readonly string[]): void {
  for (const [key, app] of open) {
    if (!app.rendered) {
      open.delete(key);
      continue;
    }
    if (!uuids || uuids.includes(key)) app.render();
  }
}

declare const Hooks: any;
