/**
 * The `?` cheat sheet on screen: one popover, whichever surface asked for it.
 *
 * IMPURE: the DOM, and Configure Controls through `game.keybindings`. What a sheet lists
 * is `ui/cheatsheet.ts`, which is pure; this file reads the bindings as they are at the
 * moment it opens, puts the sheet up, and takes it down again.
 *
 * A popover rather than a window. It is read in the middle of a gesture — with a ghost on
 * the cursor, or a row under the focus — so it takes nothing from the surface behind it:
 * it closes on Escape before that surface's own Escape does, on `?` again, on its ✕ and
 * on any click outside it, and gives the focus back to where it was. It lives in `body`,
 * so a Pinboard re-render cannot take it away, and it is built once per opening: nothing
 * in it moves while it is up.
 */

import { MODULE_ID } from "../const";
import { g, ns } from "../fvtt";
import { logger } from "../log";
import { cheatSheetMarkup, type CheatSurface } from "../ui/cheatsheet";
import { modifierGlyphs, platform } from "../ui/modifiers";
import { docOf } from "./focus-restore";

const log = logger("cheat");

interface Shown {
  surface: CheatSurface;
  element: HTMLElement;
  /** Where the focus was, to go back to — unless the GM clicked somewhere else. */
  returnTo: HTMLElement | null;
  off: () => void;
}

let shown: Shown | null = null;

/** A binding as the keyboard names it: core's own display string where there is one. */
export function bindingName(binding: { key: string; modifiers?: string[] }): string {
  const Keyboard = ns("helpers.interaction.KeyboardManager");
  const display = (code: string) =>
    Keyboard?.getKeycodeDisplayString?.(code) ??
    code.replace(/^(Key|Digit)/, "").replace(/(Left|Right)$/, "");
  return [...(binding.modifiers ?? []).map(display), display(binding.key)].join("+");
}

/**
 * An action's keys as Configure Controls holds them now: `[]` for none, `null` when they
 * cannot be read. `ClientKeybindings#get` throws for an action it does not know (RECALLED;
 * TYPES `client-keybindings.d.mts:85` only types the return), so a sheet opened before
 * `init` finished, or in a build that renamed the API, says "see Configure Controls"
 * instead of guessing.
 */
export function currentBindings(action: string): string[] | null {
  try {
    const bindings = g()?.keybindings?.get?.(MODULE_ID, action);
    if (!Array.isArray(bindings)) return null;
    return bindings.filter((b) => typeof b?.key === "string" && b.key).map(bindingName);
  } catch (error) {
    log.warn(`could not read the binding of ${action}`, error);
    return null;
  }
}

/**
 * Close the sheet — only `surface`'s, when one is named. Returns whether one closed, so an
 * Escape handler can stop there instead of also cancelling what the sheet was about.
 */
export function closeCheatSheet(surface?: CheatSurface, restoreFocus = true): boolean {
  if (!shown || (surface && shown.surface !== surface)) return false;
  const { element, off, returnTo } = shown;
  shown = null;
  off();
  element.remove();
  if (restoreFocus && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  return true;
}

/**
 * `?` and the `?` buttons: open this surface's sheet, or close it if it is the one up.
 *
 * `opener` is any element of the surface that asked, for the document the sheet goes up
 * in. A Pinboard can be detached into a window of its own (foundry.mjs 31375), and its
 * sheet then belongs there: put up in the main window, it opened where the GM was not
 * looking, and no click in the board's window could close it. The canvas surfaces live
 * in the main window and name none.
 */
export function toggleCheatSheet(surface: CheatSurface, opener?: Node | null): void {
  try {
    const was = shown?.surface;
    closeCheatSheet(undefined, was === surface);
    if (was !== surface) show(surface, docOf(opener) ?? document);
  } catch (error) {
    log.warn("the cheat sheet failed", error);
  }
}

function show(surface: CheatSurface, doc: Document): void {
  const wrapper = doc.createElement("div");
  wrapper.innerHTML = cheatSheetMarkup(surface, modifierGlyphs(platform()), currentBindings);
  const element = wrapper.firstElementChild as HTMLElement | null;
  if (!element) return;
  // Not `instanceof HTMLElement`: an element of another window is not an instance of
  // this window's class.
  const active = doc.activeElement as HTMLElement | null;
  const returnTo =
    active && active !== doc.body && typeof active.focus === "function" ? active : null;

  // Its own keys, stopped here: an Escape that closes the sheet must not reach core's
  // Escape too, which would close the window behind it or let go of the pin.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" && event.key !== "?") return;
    event.preventDefault();
    event.stopPropagation();
    closeCheatSheet();
  };
  const onClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement)?.closest?.("[data-dp-cheat-close]")) closeCheatSheet();
  };
  // Captured, so a surface that stops its own pointer events still dismisses the sheet.
  // The click goes on to whatever it was aimed at, and keeps the focus it gives — except
  // on a `?` button, whose own click is the toggle that closes it. Any `?` button, not the
  // one that opened it: the board and the HUD rebuild their markup on every render, and a
  // sheet opened from the keyboard had no opener at all, so the press closed it and the
  // click opened it again.
  const onPointer = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (target && (element.contains(target) || target.closest?.('[data-action="cheatSheet"]'))) {
      return;
    }
    closeCheatSheet(undefined, false);
  };

  element.addEventListener("keydown", onKey);
  element.addEventListener("click", onClick);
  // Listened for, and let go of, in the one document the sheet is in.
  doc.addEventListener("pointerdown", onPointer, true);
  doc.body.appendChild(element);
  shown = {
    surface,
    element,
    returnTo,
    off: () => doc.removeEventListener("pointerdown", onPointer, true),
  };
  element.querySelector<HTMLElement>("[data-dp-cheat-close]")?.focus({ preventScroll: true });
}
