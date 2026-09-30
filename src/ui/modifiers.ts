/**
 * The modifier keys, named the way this keyboard names them.
 *
 * PURE apart from `platform()`, which reads `navigator` and nothing else. Shared by the
 * placement legend and the Pinboard's help line, which used to print Mac glyphs to every
 * GM: "⌥" names a key that a Windows or Linux keyboard does not have.
 *
 * On a Mac the "Control" modifier is shown as ⌘, because that is how Foundry itself
 * presents it there and because a Control-click on a Mac is a right-click. Every handler
 * that reads this modifier accepts `metaKey` beside `ctrlKey`, so the glyph is the truth.
 */

export type Platform = "mac" | "other";

export function modifierGlyphs(platform: Platform) {
  return platform === "mac"
    ? { alt: "⌥", shift: "⇧", ctrl: "⌘", wheel: "⟳", space: "␣", esc: "⎋" }
    : { alt: "Alt+", shift: "Shift+", ctrl: "Ctrl+", wheel: "⟳", space: "Space", esc: "Esc" };
}

export function platform(): Platform {
  const nav = (globalThis as any).navigator;
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? "";
  return /mac/i.test(String(name)) ? "mac" : "other";
}
