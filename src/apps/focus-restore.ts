/**
 * Keeping the keyboard's place across a re-render.
 *
 * Every window in the module renders by replacing its whole subtree, and every change a
 * GM makes re-renders the window that made it. Without this, the element holding the
 * focus is destroyed on each change and the focus falls to `<body>`: a slider moved with
 * the arrow keys commits on every step, so it could only ever be moved one step, and a
 * GM tabbing down a form was sent back to the top after each field.
 *
 * Identity-based, never positional: a chip is found by its user, a form control by its
 * name and a button by what it does, so the focus survives a render that changed how many
 * of anything there are.
 */

/** A selector that will find the focused control again in freshly built markup. */
export function focusSelectorIn(root: ParentNode): string | null {
  const active = typeof document === "undefined" ? null : (document.activeElement as HTMLElement);
  if (!active || !root.contains?.(active)) return null;

  // An element that names itself for this purpose — a disclosure's summary, which has no
  // name, no action and nothing else to be found by.
  const own = active.dataset?.dpFocusKey;
  if (own) return `[data-dp-focus-key="${CSS.escape(own)}"]`;

  const user = active.dataset?.dpUser;
  if (user) return `.dp-chip[data-dp-user="${CSS.escape(user)}"]`;

  const kind = active.dataset?.dpKind;
  if (kind) return `[data-dp-kind="${CSS.escape(kind)}"]`;

  const preset = active.dataset?.dpPreset;
  if (preset) {
    const action = active.dataset?.action;
    return action
      ? `[data-action="${CSS.escape(action)}"][data-dp-preset="${CSS.escape(preset)}"]`
      : `[data-dp-preset="${CSS.escape(preset)}"]`;
  }

  // A form control is its name: `display.paper` is the paper select whatever tab it is on.
  const name = active.getAttribute?.("name");
  if (name) return `[name="${CSS.escape(name)}"]`;

  const action = active.dataset?.action;
  if (!action) return null;
  // Buttons that share an action are told apart by what they act on.
  for (const key of ["dpTab", "dpFilter", "dpBg", "dpGroup"] as const) {
    const value = active.dataset?.[key];
    if (value) {
      const attr = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return `[data-action="${CSS.escape(action)}"][data-${attr}="${CSS.escape(value)}"]`;
    }
  }
  // `togglePalette` appears twice in the HUD; the palette it controls is what tells them apart.
  const controls = active.getAttribute("aria-controls");
  return controls
    ? `[data-action="${CSS.escape(action)}"][aria-controls="${CSS.escape(controls)}"]`
    : `[data-action="${CSS.escape(action)}"]`;
}

/**
 * What a re-render must carry over from the element that had the focus: where it is, and
 * — for a text field the GM is part-way through — what they had typed. `change` commits a
 * text field only on blur or Enter, so a render landing mid-word would otherwise replace
 * the word with the stored value.
 */
export interface FocusSnapshot {
  selector: string;
  /** Present only for a text-like field whose value differs from the one it was drawn with. */
  draft?: { value: string; start: number | null; end: number | null };
}

const TEXT_TYPES = new Set(["text", "search", "number", "url", ""]);

export function snapshotFocus(root: ParentNode): FocusSnapshot | null {
  const selector = focusSelectorIn(root);
  if (!selector) return null;
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement &&
    TEXT_TYPES.has(active.type) &&
    active.value !== active.defaultValue
  ) {
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = active.selectionStart;
      end = active.selectionEnd;
    } catch {
      /* a number input has no selection API */
    }
    return { selector, draft: { value: active.value, start, end } };
  }
  return { selector };
}

/** Put the focus — and a half-typed draft — back after a render. */
export function restoreFocus(root: ParentNode, snapshot: FocusSnapshot | null): HTMLElement | null {
  if (!snapshot) return null;
  const target = root.querySelector<HTMLElement>(snapshot.selector);
  if (!target) return null;
  if (snapshot.draft && target instanceof HTMLInputElement) {
    target.value = snapshot.draft.value;
    try {
      if (snapshot.draft.start !== null) {
        target.setSelectionRange(snapshot.draft.start, snapshot.draft.end ?? snapshot.draft.start);
      }
    } catch {
      /* a number input has no selection API */
    }
  }
  target.focus({ preventScroll: true });
  return target;
}
