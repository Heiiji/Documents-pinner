/**
 * The Pin HUD — the surface that answers "this pin, right now".
 *
 * IMPURE. Built in a factory rather than declared at module scope because it extends
 * a Foundry class, and this file has to stay importable under Node.
 *
 * It extends `BasePlaceableHUD` when that exists, so positioning, `bind`, `clear` and
 * core's own styling come for free, and falls back to a bare `ApplicationV2` when it
 * does not. Both paths render the same markup, so the fallback is a positioning
 * difference, never a missing control.
 *
 * Two design rules run through the layout:
 *
 * 1. **Everything reversible acts immediately and asks nothing.** Revealing, hiding,
 *    switching shape and toggling a player are all one click with no confirmation,
 *    because they are all one click to undo and the GM is doing this while four people
 *    watch. Only destructive actions live behind a dialog, and none of them are here.
 *
 * 2. **The palettes are disclosures, not menus.** They open in place, keep the pin
 *    visible behind them, and close on Escape — a menu that covered the thing being
 *    edited would make "does this read against the map?" unanswerable at the moment it
 *    is being asked.
 *
 * Accessibility is not a coat of paint on this one: the whole HUD is a `toolbar` with
 * roving tabindex, the palettes are `aria-expanded` disclosures, and the chips are
 * `role="checkbox"`. A GM running a session one-handed is the normal case, not an edge
 * case.
 */

import { MODULE_ID } from "../const";
import { g, ns, playerIds } from "../fvtt";
import { logger } from "../log";
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import { previewIntensity } from "../canvas/DomPropTier";
import { readPin } from "../data/PinData";
import { allPresets } from "../effects/preset-library";
import { swatchStyle } from "../effects/preset-css";
import { chipsMarkup, describeChips, type ChipUser } from "./chips";
import type { DpPinFlags } from "../types/dp";

const log = logger("hud");

let PinHUDClass: any = null;

/** The users a chip row is built from, with both facts each chip encodes. */
export function chipUsersFor(anchorDoc: any): ChipUser[] {
  return playerIds().map((id) => {
    const user = g()?.users?.get(id);
    return {
      id,
      name: user?.name ?? id,
      color: typeof user?.color === "string" ? user.color : (user?.color?.css ?? "#7a7971"),
      avatar: user?.avatar ?? null,
      canSee: api.canUserSee(anchorDoc, id),
      canOpen: api.canUserOpen(anchorDoc, id),
    };
  });
}

interface ButtonSpec {
  action: string;
  icon: string;
  key: string;
  /** Rendered pressed when true; omitted entirely when the control is stateless. */
  pressed?: boolean;
  expands?: string;
}

function buttonMarkup(spec: ButtonSpec): string {
  const label = t(spec.key);
  const state =
    spec.expands !== undefined
      ? ` aria-expanded="false" aria-controls="${escapeAttr(spec.expands)}"`
      : spec.pressed !== undefined
        ? ` aria-pressed="${spec.pressed}"`
        : "";

  return (
    `<button type="button" class="dp-hud__btn" data-action="${escapeAttr(spec.action)}"` +
    `${state} tabindex="-1" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">` +
    `<i class="${escapeAttr(spec.icon)}" aria-hidden="true"></i></button>`
  );
}

function audiencePaletteMarkup(anchorDoc: any, pin: DpPinFlags): string {
  const users = chipUsersFor(anchorDoc);
  const presets: { kind: string; key: string }[] = [
    { kind: "everyone", key: "DP.hud.audienceAll" },
    { kind: "selected", key: "DP.hud.audienceSome" },
    { kind: "hidden", key: "DP.hud.audienceNone" },
  ];

  const quick = presets
    .map(
      (p) =>
        `<button type="button" class="dp-hud__quick" data-action="setAudienceKind"` +
        ` data-dp-kind="${escapeAttr(p.kind)}" aria-pressed="${pin.audience.kind === p.kind}">` +
        `${escapeHtml(t(p.key))}</button>`
    )
    .join("");

  const sync =
    `<label class="dp-hud__sync"><input type="checkbox" data-action="toggleSync"` +
    `${pin.audience.ownershipSync.enabled ? " checked" : ""}>` +
    `<span>${escapeHtml(t("DP.hud.syncAccess"))}</span></label>`;

  return (
    `<div class="dp-hud__palette" id="dp-hud-audience" data-dp-palette="audience" hidden>` +
    `<div class="dp-hud__row">${quick}${sync}</div>` +
    chipsMarkup(users, { t: tn }) +
    `<p class="dp-hud__status" aria-live="polite">${escapeHtml(tn(describeChips(users)))}</p>` +
    `</div>`
  );
}

function effectsPaletteMarkup(pin: DpPinFlags): string {
  // The whole library. A gallery that offered only the shipped ten made the Preset
  // Studio a producer with no consumer.
  // The preset's OWN variables, so a GM can tell Glitch from Torn Edges without applying
  // it. Every swatch used to be the same beige rectangle: the markup carried a preset id
  // and nothing anywhere styled from it, so the gallery was name-only in both live
  // surfaces while `presetToCssVars` sat one import away.
  const swatches = allPresets()
    .map(
      (preset) =>
        `<button type="button" class="dp-hud__swatch" data-action="setEffect"` +
        ` data-dp-preset="${escapeAttr(preset.id)}" aria-pressed="${pin.effect.id === preset.id}"` +
        ` title="${escapeAttr(t(preset.label))}" data-dp-fx="${escapeAttr(preset.id)}">` +
        `<span class="dp-hud__swatch-preview dp-card" aria-hidden="true"` +
        ` style="${escapeAttr(swatchStyle(preset))}"></span>` +
        `<span class="dp-hud__swatch-label">${escapeHtml(t(preset.label))}</span></button>`
    )
    .join("");

  return (
    `<div class="dp-hud__palette" id="dp-hud-effects" data-dp-palette="effects" hidden>` +
    `<div class="dp-hud__swatches">${swatches}</div>` +
    // Where a preset is chosen is where a GM decides they want one that is not there.
    `<button type="button" class="dp-hud__link" data-action="editPresets">` +
    `${escapeHtml(t("DP.presets.edit"))}</button>` +
    `<label class="dp-hud__slider">${escapeHtml(t("DP.hud.intensity"))}` +
    `<input type="range" min="0" max="100" step="5" value="${Math.round(pin.effect.intensity * 100)}"` +
    ` data-action="setIntensity"></label>` +
    `</div>`
  );
}

export function hudMarkup(anchorDoc: any, pin: DpPinFlags): string {
  const visible = pin.audience.kind !== "hidden";
  const left: ButtonSpec[] = [
    {
      action: "toggleVisibility",
      icon: visible ? "fa-solid fa-eye" : "fa-solid fa-eye-slash",
      key: visible ? "DP.hud.hide" : "DP.hud.reveal",
      pressed: visible,
    },
    {
      action: "togglePalette",
      icon: "fa-solid fa-users",
      key: "DP.hud.audience",
      expands: "dp-hud-audience",
    },
    {
      action: "togglePalette",
      icon: "fa-solid fa-wand-magic-sparkles",
      key: "DP.hud.effects",
      expands: "dp-hud-effects",
    },
    {
      action: "toggleLock",
      icon: anchorDoc?.locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open",
      key: "DP.hud.lock",
      pressed: anchorDoc?.locked === true,
    },
  ];
  const right: ButtonSpec[] = [
    {
      action: "toggleMode",
      icon: "fa-solid fa-right-left",
      key: pin.mode === "prop" ? "DP.hud.toPin" : "DP.hud.toProp",
    },
    // A prop's verb only: a pin is one grid square and has no content to fit.
    ...(pin.mode === "prop"
      ? [{ action: "fitHeight", icon: "fa-solid fa-text-height", key: "DP.hud.fitHeight" }]
      : []),
    { action: "openLocally", icon: "fa-solid fa-book-open", key: "DP.hud.openForMe" },
    { action: "flash", icon: "fa-solid fa-bolt", key: "DP.hud.flash" },
    { action: "configure", icon: "fa-solid fa-gear", key: "DP.hud.configure" },
  ];

  return (
    `<div class="dp-hud" role="toolbar" aria-label="${escapeAttr(t("DP.hud.title"))}">` +
    `<div class="dp-hud__col dp-hud__col--left">${left.map(buttonMarkup).join("")}</div>` +
    `<div class="dp-hud__name">${escapeHtml(api.labelFor(pin))}</div>` +
    `<div class="dp-hud__col dp-hud__col--right">${right.map(buttonMarkup).join("")}</div>` +
    audiencePaletteMarkup(anchorDoc, pin) +
    effectsPaletteMarkup(pin) +
    `</div>`
  );
}

/**
 * Move focus along the toolbar with the arrow keys.
 *
 * Roving tabindex rather than every button being tabbable: a toolbar is ONE tab stop,
 * so a GM tabbing through the sheet behind it does not have to walk eight icons to get
 * past the HUD.
 */
export function focusStep(
  buttons: HTMLElement[],
  current: HTMLElement | null,
  delta: number
): void {
  if (!buttons.length) return;
  const index = current ? buttons.indexOf(current) : -1;
  const next = buttons[(index + delta + buttons.length) % buttons.length];
  for (const button of buttons) button.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

/** Build the HUD class. Call once, at `init`. Returns null if the base is missing. */
export function definePinHUD(): any {
  if (PinHUDClass) return PinHUDClass;

  const Base = ns("applications.hud.BasePlaceableHUD") ?? ns("applications.api.ApplicationV2");
  if (!Base) return null;

  PinHUDClass = class PinHUD extends Base {
    static DEFAULT_OPTIONS = {
      ...(Base.DEFAULT_OPTIONS ?? {}),
      id: "dp-pin-hud",
      classes: ["dp-scope", "dp-hud-app"],
      window: { frame: false, positioned: true },
      actions: {
        toggleVisibility: onToggleVisibility,
        togglePalette: onTogglePalette,
        toggleLock: onToggleLock,
        toggleMode: onToggleMode,
        fitHeight: onFitHeight,
        openLocally: onOpenLocally,
        flash: onFlash,
        configure: onConfigure,
        setAudienceKind: onSetAudienceKind,
        setEffect: onSetEffect,
        editPresets: onEditPresets,
      },
    };

    /**
     * The palette that is open, and the control that had focus.
     *
     * Kept on the INSTANCE rather than read back off the DOM, because the DOM is
     * replaced wholesale on every render — which is precisely the thing that made the
     * palette close after every chip click. A tile update re-renders the HUD, the fresh
     * markup has both palettes `hidden`, and revealing to three of five players cost
     * three reopenings and lost focus three times.
     */
    openPaletteId: string | null = null;
    focusedSelector: string | null = null;

    /** The anchor this HUD is bound to. `object` is core's; `document` is its doc. */
    get anchorDoc(): any {
      return this.object?.document ?? this.document ?? null;
    }

    async _renderHTML() {
      const doc = this.anchorDoc;
      const pin = readPin(doc);
      if (!pin) return document.createElement("div");

      const wrapper = document.createElement("div");
      wrapper.innerHTML = hudMarkup(doc, pin);
      return wrapper.firstElementChild ?? wrapper;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      // Read before the DOM is thrown away; re-applied after the new one is in place.
      //
      // Only when the focus is CURRENTLY inside the HUD. Keeping the last selector when
      // it is not meant that any later render yanked focus back — a GM who clicked a chip
      // and then started typing in chat had the caret pulled out from under them by the
      // next tile update. The Pinboard guards the same way with `hadRowFocus`.
      this.focusedSelector = focusSelectorIn(content);

      content.replaceChildren(result);
      // Wired to `result`, the NEW subtree, not to `content`. ApplicationV2 hands back
      // the same `content` element on every render, so listeners attached there
      // accumulate one set per render — and because these handlers trigger renders, the
      // growth compounds.
      this.#wire(result);
      this.#restoreState(result);
    }

    /**
     * Put the disclosure and the focus back where the GM left them.
     *
     * Both halves matter and they fail together: a palette that closes takes the focused
     * chip with it, so the next click needs a reopen AND a re-aim.
     */
    #restoreState(root: HTMLElement) {
      if (this.openPaletteId) {
        const palette = root.querySelector<HTMLElement>(`#${CSS.escape(this.openPaletteId)}`);
        const button = root.querySelector<HTMLElement>(
          `[aria-controls="${CSS.escape(this.openPaletteId)}"]`
        );
        if (palette && button) {
          palette.hidden = false;
          palette.classList.add("dp-hud__palette--in");
          button.setAttribute("aria-expanded", "true");
        } else {
          this.openPaletteId = null;
        }
      }

      if (!this.focusedSelector) return;
      const target = root.querySelector<HTMLElement>(this.focusedSelector);
      if (!target) return;
      // The toolbar is one tab stop: whatever regains focus becomes the tabbable one.
      if (target.classList.contains("dp-hud__btn")) {
        for (const button of root.querySelectorAll<HTMLElement>(".dp-hud__btn")) {
          button.tabIndex = -1;
        }
        target.tabIndex = 0;
      }
      target.focus({ preventScroll: true });
    }

    #wire(root: HTMLElement) {
      const buttons = [...root.querySelectorAll<HTMLElement>(".dp-hud__btn")];
      if (buttons[0]) buttons[0].tabIndex = 0;
      // `#restoreState` runs after this and may move the tab stop to whichever button
      // the GM actually had focused.

      root.addEventListener("keydown", (event) => {
        const target = event.target as HTMLElement;
        if (event.key === "Escape") {
          // A palette closes first; with none open, Escape lets go of the pin, which is
          // what closes the HUD — it used to do nothing at all.
          if (this.openPaletteId) this.#closePalettes(root);
          else this.object?.release?.();
          return;
        }
        if (!target?.classList?.contains("dp-hud__btn")) return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          focusStep(buttons, target, 1);
          event.preventDefault();
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          focusStep(buttons, target, -1);
          event.preventDefault();
        }
      });

      // Chips are not `actions` because they carry a modifier vocabulary of their own:
      // plain toggles, Shift solos — the same two gestures on every surface. Alt-click
      // used to flip the pin-wide access sync from here, which duplicated the checkbox
      // three lines up, ignored WHICH chip was clicked, and peeked the whole map on the
      // way, because Alt is the peek key.
      root.addEventListener("click", (event) => {
        const chip = (event.target as HTMLElement)?.closest?.<HTMLElement>(".dp-chip");
        if (!chip) return;
        event.preventDefault();
        const userId = chip.dataset.dpUser ?? "";
        const doc = this.anchorDoc;
        if (event.shiftKey) void api.soloUser(doc, userId);
        else void api.setUserVisible(doc, userId, chip.getAttribute("aria-checked") !== "true");
      });

      // The slider previews as it moves: one custom-property write the compositor
      // interpolates, on the DOM tier only — a texture cannot preview, and faking it
      // would be the lie A15 forbids. The commit lands on `change`.
      root.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input?.dataset?.action !== "setIntensity") return;
        previewIntensity(this.anchorDoc?.id, Number(input.value) / 100);
      });

      root.addEventListener("change", (event) => {
        const input = event.target as HTMLInputElement;
        const doc = this.anchorDoc;
        if (input?.dataset?.action === "toggleSync") void api.setOwnershipSync(doc, input.checked);
        if (input?.dataset?.action === "setIntensity") {
          void api.patch(doc, { effect: { intensity: Number(input.value) / 100 } });
        }
      });
    }

    #closePalettes(root: HTMLElement) {
      this.openPaletteId = null;
      for (const palette of root.querySelectorAll<HTMLElement>(".dp-hud__palette")) {
        palette.hidden = true;
      }
      for (const button of root.querySelectorAll<HTMLElement>("[aria-expanded]")) {
        button.setAttribute("aria-expanded", "false");
      }
    }
  };

  return PinHUDClass;
}

let hudInstance: any = null;

/**
 * Show the HUD over a pin.
 *
 * The element is moved into `#hud` after rendering when that container exists: core's
 * own HUDs live there, and sharing the container means sharing its stacking context
 * and its coordinate origin rather than guessing at both from `body`.
 */
export function showPinHUD(tile: any): void {
  const HUD = definePinHUD();
  if (!HUD || !tile) return;

  hudInstance ??= new HUD();

  // One HUD instance serves every pin, so its remembered disclosure and focus belong to
  // the anchor it was showing. Carrying them to a different pin would open a palette the
  // GM never opened on THIS one, and pull focus into it.
  if (hudInstance.anchorDoc?.id !== tile.document?.id) {
    hudInstance.openPaletteId = null;
    hudInstance.focusedSelector = null;
  }

  // `BasePlaceableHUD#object` is a GETTER, with no setter, and `bind()` is what owns it.
  // Assigning to it threw `TypeError: Cannot set property object` from inside
  // `PlaceableObject#control()` — which sets `_controlled` and then never reaches its own
  // `renderFlags.set({ refreshState: true })`, so a selected pin got no frame and no
  // resize handles. "I can't even move or resize them" was this one line.
  //
  // The assignment stays only on the ApplicationV2 fallback path, where `object` is our
  // own plain property and there is no `bind` to do it for us.
  let shown;
  if (typeof hudInstance.bind === "function") {
    shown = hudInstance.bind(tile);
  } else {
    hudInstance.object = tile;
    shown = hudInstance.render(true);
  }

  void Promise.resolve(shown)
    .then(() => {
      const hud = document.getElementById("hud");
      const element = hudInstance?.element;
      if (hud && element && element.parentElement !== hud) hud.appendChild(element);
    })
    .catch((error) => log.warn("could not show the pin HUD", error));
}

export function hidePinHUD(): void {
  if (!hudInstance) return;
  if (hudInstance.clear) hudInstance.clear();
  else hudInstance.close();
}

/** Re-render the HUD if it is showing this anchor. Wired to the tile hooks. */
export function refreshPinHUD(doc: any): void {
  if (!hudInstance?.rendered) return;
  if (doc && hudInstance.anchorDoc?.id !== doc.id) return;
  hudInstance.render();
}

// ---------------------------------------------------------------------------
// Action handlers. `this` is the application instance.
// ---------------------------------------------------------------------------

function onToggleVisibility(this: any) {
  void api.toggleVisibility(this.anchorDoc)?.then(() => this.render());
}

/**
 * Core's disclosure idiom: the button owns `aria-expanded`, the palette it names owns
 * `hidden`, and opening one closes the others so two palettes never fight for the same
 * space below a HUD that is itself floating over the map.
 */
function onTogglePalette(this: any, _event: Event, target: HTMLElement) {
  const root = target.closest(".dp-hud") as HTMLElement | null;
  const id = target.getAttribute("aria-controls");
  if (!root || !id) return;

  const palette = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  const open = target.getAttribute("aria-expanded") === "true";

  for (const other of root.querySelectorAll<HTMLElement>(".dp-hud__palette")) {
    other.hidden = true;
    other.classList.remove("dp-hud__palette--in");
  }
  for (const button of root.querySelectorAll<HTMLElement>("[aria-expanded]")) {
    button.setAttribute("aria-expanded", "false");
  }

  // Remembered on the instance so the next render can put it back; see `#restoreState`.
  this.openPaletteId = open ? null : id;

  if (!open && palette) {
    palette.hidden = false;
    // On the NEXT frame, so the palette has a style to transition from. `#restoreState`
    // adds it synchronously instead, so a re-render never re-plays the opening.
    requestAnimationFrame(() => palette.classList.add("dp-hud__palette--in"));
    target.setAttribute("aria-expanded", "true");
    palette.querySelector<HTMLElement>("button, input")?.focus();
  }
}

/**
 * A selector that will find the focused control again in freshly built markup.
 *
 * Identity-based, never positional: a chip is found by its user and a button by its
 * action, so restoring focus survives a re-render that changed how many chips there are.
 */
export function focusSelectorIn(root: ParentNode): string | null {
  const active = typeof document === "undefined" ? null : (document.activeElement as HTMLElement);
  if (!active || !root.contains?.(active)) return null;

  const user = active.dataset?.dpUser;
  if (user) return `.dp-chip[data-dp-user="${CSS.escape(user)}"]`;

  const kind = active.dataset?.dpKind;
  if (kind) return `[data-dp-kind="${CSS.escape(kind)}"]`;

  const preset = active.dataset?.dpPreset;
  if (preset) return `[data-dp-preset="${CSS.escape(preset)}"]`;

  const action = active.dataset?.action;
  if (!action) return null;
  // `togglePalette` appears twice; the palette it controls is what tells them apart.
  const controls = active.getAttribute("aria-controls");
  return controls
    ? `[data-action="${CSS.escape(action)}"][aria-controls="${CSS.escape(controls)}"]`
    : `[data-action="${CSS.escape(action)}"]`;
}

function onToggleLock(this: any) {
  const doc = this.anchorDoc;
  void doc?.update({ locked: !doc.locked })?.then(() => this.render());
}

function onToggleMode(this: any) {
  void api.toggleMode(this.anchorDoc)?.then(() => this.render());
}

function onFitHeight(this: any) {
  void api.fitToContent(this.object?.document);
}

function onOpenLocally(this: any) {
  void api.openLocally(this.anchorDoc);
}

function onFlash(this: any) {
  api.flash(this.anchorDoc);
}

function onConfigure(this: any) {
  Hooks.call(`${MODULE_ID}.openStudio`, this.anchorDoc);
}

function onSetAudienceKind(this: any, _event: Event, target: HTMLElement) {
  const doc = this.anchorDoc;
  const pin = readPin(doc);
  const kind = target.dataset.dpKind;
  if (!pin || !kind) return;

  // "Some" with nobody chosen yet would mean nobody, which is indistinguishable from
  // hidden. Open the chips instead of applying a state the GM cannot tell apart — and
  // say so on the status line, because a click that only moved the focus read as a
  // click that did nothing.
  if (kind === "selected" && !pin.audience.users.length) {
    const root = target.closest(".dp-hud");
    const status = root?.querySelector<HTMLElement>(".dp-hud__status");
    if (status) status.textContent = t("DP.hud.chooseWho");
    root?.querySelector<HTMLElement>(".dp-chip")?.focus();
    return;
  }
  void api
    .setAudience(doc, { ...pin.audience, kind: kind as any, restore: null })
    ?.then(() => this.render());
}

function onSetEffect(this: any, _event: Event, target: HTMLElement) {
  const id = target.dataset.dpPreset;
  if (!id) return;
  void api.patch(this.anchorDoc, { effect: { id } })?.then(() => this.render());
}

function onEditPresets(this: any) {
  Hooks.call(`${MODULE_ID}.openPresets`, readPin(this.anchorDoc)?.effect.id);
}

declare const Hooks: any;
