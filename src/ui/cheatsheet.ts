/**
 * The `?` cheat sheet: the keys each surface answers to, as data.
 *
 * PURE. One table per surface — the placement ghost, the Pinboard, the HUD — and one
 * builder that turns a table into the sheet. The Pinboard's help line (`DP.board.help`)
 * is prose, to be read at a glance; this is the reference, and it is data so that
 * `tests/cheatsheet.test.ts` can press every key on every surface and fail when a table
 * and its handler disagree in either direction. The handlers stay where they are; the
 * test is what keeps the two in step.
 *
 * Two kinds of row. A surface's own keys are window handlers that cannot be rebound, so
 * they are written here and named in the keyboard's words (`ui/modifiers.ts`). A binding
 * from Configure Controls is written by its action only: what it is bound to is read as
 * the sheet opens, so a GM who moved Alt+M is shown their key, and an unbound one is
 * shown as unbound rather than as the default it no longer has.
 */

import { escapeAttr, escapeHtml } from "../html";
import { t } from "../i18n";
import type { modifierGlyphs } from "./modifiers";

export type CheatSurface = "ghost" | "board" | "hud";

type Glyphs = ReturnType<typeof modifierGlyphs>;

/**
 * One key or gesture. `key` is `KeyboardEvent.key` exactly as the handler matches it (a
 * letter in lower case); `pointer` is a mouse gesture; neither is a modifier held alone.
 */
export interface Chord {
  key?: string;
  pointer?: "wheel" | "click" | "rightClick" | "rightDrag" | "chip";
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** A surface's own key, or a Configure Controls action by its `keybindings.ts` name. */
export type CheatRow = { chords: Chord[]; does: string } | { action: string };

const TOGGLE: CheatRow = { chords: [{ key: "?" }], does: "DP.cheat.toggle" };
const CHIPS: CheatRow[] = [
  { chords: [{ pointer: "chip" }], does: "DP.cheat.chipToggle" },
  { chords: [{ pointer: "chip", shift: true }], does: "DP.cheat.chipSolo" },
];

export const CHEAT_SHEETS: Record<CheatSurface, { title: string; rows: CheatRow[] }> = {
  // `PlacementGhost.stepKey` and the wheel, pointer and modifier listeners in `attach`.
  ghost: {
    title: "DP.cheat.titleGhost",
    rows: [
      { chords: [{ pointer: "wheel" }], does: "DP.cheat.rotate" },
      { chords: [{ pointer: "wheel", shift: true }], does: "DP.cheat.rotateFine" },
      { chords: [{ key: "r" }], does: "DP.cheat.square" },
      { chords: [{ pointer: "wheel", alt: true }], does: "DP.cheat.scale" },
      { chords: [{ pointer: "wheel", shift: true, alt: true }], does: "DP.cheat.textSize" },
      { chords: [{ pointer: "wheel", ctrl: true }], does: "DP.cheat.zoom" },
      { chords: [{ key: " " }], does: "DP.cheat.shape" },
      { chords: [{ key: "e" }], does: "DP.cheat.effectNext" },
      { chords: [{ key: "e", shift: true }], does: "DP.cheat.effectBack" },
      { chords: [{ key: "v" }], does: "DP.cheat.audience" },
      { chords: [{ key: "f" }], does: "DP.cheat.fit" },
      { chords: [{ ctrl: true }], does: "DP.cheat.freePlace" },
      { chords: [{ pointer: "click" }], does: "DP.cheat.place" },
      { chords: [{ pointer: "click", shift: true }], does: "DP.cheat.stamp" },
      { chords: [{ key: "Escape" }, { pointer: "rightClick" }], does: "DP.cheat.cancel" },
      { chords: [{ pointer: "rightDrag" }], does: "DP.cheat.pan" },
      TOGGLE,
      { action: "pinLastUsed" },
    ],
  },
  // `Pinboard#onKey`, and the row and chip clicks in `Pinboard#wire`.
  board: {
    title: "DP.cheat.titleBoard",
    rows: [
      { chords: [{ key: "ArrowUp" }, { key: "ArrowDown" }], does: "DP.cheat.move" },
      {
        chords: [
          { key: "ArrowUp", shift: true },
          { key: "ArrowDown", shift: true },
        ],
        does: "DP.cheat.extend",
      },
      {
        chords: [
          { key: "ArrowUp", alt: true },
          { key: "ArrowDown", alt: true },
        ],
        does: "DP.cheat.reorder",
      },
      { chords: [{ key: " " }], does: "DP.cheat.eye" },
      { chords: [{ key: "n" }], does: "DP.cheat.revealNext" },
      { chords: [{ key: " ", shift: true }], does: "DP.cheat.spotlight" },
      { chords: [{ key: "Enter" }], does: "DP.cheat.studio" },
      { chords: [{ key: "l" }], does: "DP.cheat.locate" },
      { chords: [{ key: "o" }], does: "DP.cheat.openForMe" },
      { chords: [{ key: "s", shift: true }], does: "DP.cheat.show" },
      { chords: [{ key: "f" }], does: "DP.cheat.flash" },
      { chords: [{ key: "m" }], does: "DP.cheat.shape" },
      { chords: [{ key: "/" }], does: "DP.cheat.search" },
      { chords: [{ key: "Escape" }], does: "DP.cheat.clear" },
      { chords: [{ pointer: "click", shift: true }], does: "DP.cheat.range" },
      { chords: [{ pointer: "click", ctrl: true }], does: "DP.cheat.add" },
      ...CHIPS,
      TOGGLE,
      { action: "openPinboard" },
      { action: "revealNext" },
    ],
  },
  // The toolbar's keydown listener in `PinHUD#wire`, and its chip clicks.
  hud: {
    title: "DP.cheat.titleHud",
    rows: [
      {
        chords: [
          { key: "ArrowLeft" },
          { key: "ArrowRight" },
          { key: "ArrowUp" },
          { key: "ArrowDown" },
        ],
        does: "DP.cheat.buttons",
      },
      { chords: [{ key: "Escape" }], does: "DP.cheat.dismiss" },
      ...CHIPS,
      TOGGLE,
      { action: "cycleAudience" },
      { action: "toggleMode" },
      { action: "fitSelected" },
      { action: "peek" },
    ],
  },
};

const ARROWS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** A chord as this keyboard names it: "Shift+Space" here, "⇧␣" on a Mac. */
function chordLabel(chord: Chord, glyphs: Glyphs): string {
  const mods =
    (chord.shift ? glyphs.shift : "") +
    (chord.alt ? glyphs.alt : "") +
    (chord.ctrl ? glyphs.ctrl : "");
  if (chord.pointer) {
    const pointer = chord.pointer === "wheel" ? glyphs.wheel : t(`DP.cheat.${chord.pointer}`);
    return mods + pointer;
  }
  // A modifier held on its own: "Ctrl", not "Ctrl+".
  if (!chord.key) return mods.replace(/\+$/, "");
  const key =
    chord.key === " "
      ? glyphs.space
      : chord.key === "Escape"
        ? glyphs.esc
        : chord.key === "Enter"
          ? glyphs.enter
          : (ARROWS[chord.key] ?? chord.key.toUpperCase());
  return mods + key;
}

const kbd = (text: string) => `<kbd>${escapeHtml(text)}</kbd>`;

function rowMarkup(keys: string, does: string, unbound = false): string {
  return (
    `<div class="dp-cheat__row"${unbound ? ` data-dp-unbound="true"` : ""}>` +
    `<dt>${keys}</dt><dd>${escapeHtml(does)}</dd></div>`
  );
}

/**
 * The sheet for one surface.
 *
 * `bound` reads an action's bindings as Configure Controls holds them now, already named
 * (`[]` when it has none, `null` when they cannot be read). The sheet never falls back to
 * a default: a key it cannot confirm is not printed as if it were bound.
 */
export function cheatSheetMarkup(
  surface: CheatSurface,
  glyphs: Glyphs,
  bound: (action: string) => string[] | null
): string {
  const sheet = CHEAT_SHEETS[surface];
  const local: string[] = [];
  const global: string[] = [];
  for (const row of sheet.rows) {
    if ("action" in row) {
      const keys = bound(row.action);
      const cell = keys?.length
        ? keys.map(kbd).join(" ")
        : `<span class="dp-cheat__unbound">${escapeHtml(t(keys ? "DP.cheat.unbound" : "DP.cheat.unknown"))}</span>`;
      global.push(rowMarkup(cell, t(`DP.keys.${row.action}`), !keys?.length));
    } else {
      local.push(
        rowMarkup(row.chords.map((c) => kbd(chordLabel(c, glyphs))).join(" "), t(row.does))
      );
    }
  }
  return (
    `<div class="dp-scope dp-cheat" role="dialog" aria-labelledby="dp-cheat-title"` +
    ` data-dp-surface="${escapeAttr(surface)}">` +
    `<header class="dp-cheat__head">` +
    `<h2 class="dp-cheat__title" id="dp-cheat-title">${escapeHtml(t(sheet.title))}</h2>` +
    `<button type="button" class="dp-cheat__close" data-dp-cheat-close` +
    ` aria-label="${escapeAttr(t("DP.cheat.close"))}" data-tooltip-text="${escapeAttr(t("DP.cheat.close"))}">` +
    `<i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` +
    `</header>` +
    `<dl class="dp-cheat__keys">${local.join("")}</dl>` +
    (global.length
      ? `<h3 class="dp-cheat__sub">${escapeHtml(t("DP.cheat.controls"))}</h3>` +
        `<dl class="dp-cheat__keys">${global.join("")}</dl>`
      : "") +
    `</div>`
  );
}

/**
 * Whether a keystroke is text going into a field — the chat box, a search — and so is
 * not a shortcut. The Pinboard's guard adds buttons to this, for its Space and letters.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    element?.tagName === "INPUT" ||
    element?.tagName === "SELECT" ||
    element?.tagName === "TEXTAREA" ||
    element?.isContentEditable === true
  );
}
