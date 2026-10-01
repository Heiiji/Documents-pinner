/**
 * A key a window has handled is that window's: core's keyboard does not act on it too.
 *
 * Core listens for `keydown` on the WINDOW, as it bubbles, and never asks whether the
 * event was `defaultPrevented` (foundry.mjs 133518, 133972). It holds its bindings back
 * only while `hasFocus` says a field has the keyboard (133681): an input, a select, a
 * textarea, an editable element — or a button INSIDE A FORM. A Pinboard row is an `<li>`,
 * and the board, the picker and the Preset Studio are `<section>`s, so every key they
 * handled went on to core as well: Space on a row revealed the pin and paused the game
 * for the whole table, an Escape that cleared the search closed every window, and an
 * arrow moved the row and panned the map (A29).
 */

/** Handled here: no default action, and nothing outside the window hears it. */
export function consume(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

/** Whether Space or Enter activates the focused element — a button, a summary, an item. */
function activates(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (element?.nodeType !== 1) return false;
  if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") return true;
  const role = element.getAttribute("role");
  return (
    role === "button" ||
    role === "menuitem" ||
    role === "menuitemradio" ||
    role === "menuitemcheckbox"
  );
}

const guarded = new WeakSet<HTMLElement>();

/**
 * Keep Space and Enter on a focused button inside `root` from reaching core.
 *
 * Stopped, never prevented: pressing the button IS the key's default action, and it must
 * still happen. A button in a `<form>` would be safe already; a `<section>` window's are
 * not, and Space on the board's Hide button hid the pins and paused the game. Once per
 * element, so a window can call it on every render.
 */
export function guardActivationKeys(root: HTMLElement | null | undefined): void {
  if (!root || guarded.has(root)) return;
  guarded.add(root);
  root.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && activates(event.target)) {
      event.stopPropagation();
    }
  });
}
