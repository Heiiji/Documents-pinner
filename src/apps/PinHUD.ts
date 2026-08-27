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
import { t, tn } from "../i18n";
import { escapeAttr, escapeHtml } from "../html";
import * as api from "../api";
import { readPin } from "../data/PinData";
import { CORE_PRESETS } from "../effects/presets/core-presets";
import { chipsMarkup, describeChips, type ChipUser } from "./chips";
import type { DpPinFlags } from "../types/dp";

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
  const swatches = CORE_PRESETS.map(
    (preset) =>
      `<button type="button" class="dp-hud__swatch" data-action="setEffect"` +
      ` data-dp-preset="${escapeAttr(preset.id)}" aria-pressed="${pin.effect.id === preset.id}"` +
      ` title="${escapeAttr(t(preset.label))}" data-dp-fx="${escapeAttr(preset.id)}">` +
      `<span class="dp-hud__swatch-label">${escapeHtml(t(preset.label))}</span></button>`
  ).join("");

  return (
    `<div class="dp-hud__palette" id="dp-hud-effects" data-dp-palette="effects" hidden>` +
    `<div class="dp-hud__swatches">${swatches}</div>` +
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
        openLocally: onOpenLocally,
        flash: onFlash,
        configure: onConfigure,
        setAudienceKind: onSetAudienceKind,
        setEffect: onSetEffect,
      },
    };

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
      content.replaceChildren(result);
      this.#wire(content);
    }

    #wire(root: HTMLElement) {
      const buttons = [...root.querySelectorAll<HTMLElement>(".dp-hud__btn")];
      if (buttons[0]) buttons[0].tabIndex = 0;

      root.addEventListener("keydown", (event) => {
        const target = event.target as HTMLElement;
        if (event.key === "Escape") {
          this.#closePalettes(root);
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
      // plain toggles, Shift solos, Alt changes access without changing presence.
      root.addEventListener("click", (event) => {
        const chip = (event.target as HTMLElement)?.closest?.<HTMLElement>(".dp-chip");
        if (!chip) return;
        event.preventDefault();
        const userId = chip.dataset.dpUser ?? "";
        const doc = this.anchorDoc;
        if (event.shiftKey) void api.soloUser(doc, userId);
        else if (event.altKey) void toggleAccessOnly(doc);
        else void api.setUserVisible(doc, userId, chip.getAttribute("aria-checked") !== "true");
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
  hudInstance.object = tile;

  const shown = hudInstance.bind ? hudInstance.bind(tile) : hudInstance.render(true);
  void Promise.resolve(shown).then(() => {
    const hud = document.getElementById("hud");
    const element = hudInstance?.element;
    if (hud && element && element.parentElement !== hud) hud.appendChild(element);
  });
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

  for (const other of root.querySelectorAll<HTMLElement>(".dp-hud__palette")) other.hidden = true;
  for (const button of root.querySelectorAll<HTMLElement>("[aria-expanded]")) {
    button.setAttribute("aria-expanded", "false");
  }

  if (!open && palette) {
    palette.hidden = false;
    target.setAttribute("aria-expanded", "true");
    palette.querySelector<HTMLElement>("button, input")?.focus();
  }
}

function onToggleLock(this: any) {
  const doc = this.anchorDoc;
  void doc?.update({ locked: !doc.locked })?.then(() => this.render());
}

function onToggleMode(this: any) {
  void api.toggleMode(this.anchorDoc)?.then(() => this.render());
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
  // hidden. Open the chips instead of applying a state the GM cannot tell apart.
  if (kind === "selected" && !pin.audience.users.length) {
    target.closest(".dp-hud")?.querySelector<HTMLElement>(".dp-chip")?.focus();
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

/** Alt-click on a chip: flip content access without touching who can see the pin. */
function toggleAccessOnly(anchorDoc: any): Promise<void> | undefined {
  const pin = readPin(anchorDoc);
  if (!pin) return undefined;
  return api.setOwnershipSync(anchorDoc, !pin.audience.ownershipSync.enabled);
}

declare const Hooks: any;
