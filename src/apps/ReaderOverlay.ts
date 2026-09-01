/**
 * The focus reader — the DOM tier, and the only one.
 *
 * IMPURE. Clicking a prop dims its mesh and fades a live HTML card in over it, in
 * exact registration: same position, same size, same rotation, because it is mounted
 * inside the scene-transformed overlay rather than floating in screen space.
 *
 * This is the whole reason the DOM tier is bounded. A design that rendered every prop
 * as DOM would need fifty live cards, all unlit and unoccluded over a dark map — the
 * single most immersion-breaking thing this module could ship. Rendering into the
 * canvas instead and keeping DOM for the ONE card being read costs 1–3 elements and
 * buys back everything the canvas gives: selectable text, working `@UUID` links and
 * live inline rolls, which a texture can never have.
 *
 * It also turns the out-of-focus preset from a gimmick into the module's signature
 * affordance: unfocused props are soft, and focusing one sharpens it.
 *
 * The reader is deliberately NOT lit or occluded. It is a UI surface at that moment,
 * not a scene object, and a reader dimmed by the room's darkness would be unreadable
 * exactly when someone is trying to read it.
 */

import { MODULE_ID } from "../const";
import { cv, notify } from "../fvtt";
import { t } from "../i18n";
import { escapeAttr } from "../html";
import { readPin } from "../data/PinData";
import { resolveCard } from "../render/ContentResolver";
import { propManager } from "../canvas/PropManager";
import { leave, mount, write } from "./OverlayRoot";

let element: HTMLElement | null = null;
let openId: string | null = null;
let listeners: (() => void)[] = [];
/**
 * Which open attempt is the current one.
 *
 * `openReader` awaits before it assigns `element`, so two clicks in quick succession both
 * got past the guard, both mounted a card, and the first was orphaned in the overlay
 * permanently — a second copy of a prop that nothing could close.
 */
let openToken = 0;
/** The geometry the reader was last placed at, so a pan writes nothing. */
let placedAt: { x: number; y: number; width: number; height: number; rotation: number } | null =
  null;

export function focusedPinId(): string | null {
  return openId;
}

export function isReaderOpen(): boolean {
  return openId !== null;
}

/**
 * Open the reader over a prop.
 *
 * Re-entrant: clicking the prop that is already open closes it, which is what a second
 * click on the thing you are reading should do.
 */
export async function openReader(tileDoc: any): Promise<void> {
  if (!tileDoc) return;
  if (openId === tileDoc.id) {
    closeReader();
    return;
  }
  closeReader();

  const pin = readPin(tileDoc);
  if (!pin) return;

  // Claimed before the first await; anything older than this stops when it comes back.
  const token = ++openToken;

  const size = { width: tileDoc.width, height: tileDoc.height };
  const card = await resolveCard(pin, size, { tier: "L3", baked: false });
  if (token !== openToken) return;

  // NOT gated on permission, deliberately. With ownership sync off — a documented
  // setting, and the whole point of DESIGN §3.1 — a player can be in a pin's audience
  // without holding OBSERVER on the journal behind it, and refusing here gave them a
  // cursor that said "clickable" and a click that did nothing at all: no reader, no
  // sheet, no notification. That is acceptance criterion 17 verbatim, and exactly the
  // "I can see it but nothing happens" failure the key glyph exists to warn about.
  //
  // Be clear about what this is and is not. It is NOT that permission was checked
  // somewhere else: `enrichFor` strips `.secret` sections, it does not gate on read
  // permission, and Foundry ships world-document data to every client anyway — which is
  // the same fact that lets `Journal.show(doc, { force })` display a document regardless
  // of permission. It IS the module's stated position that the pin's own audience is the
  // authority over who reads a pinned document, and ownership sync is a convenience on
  // top of that rather than the gate. A GM who wants the gate leaves ownership sync on,
  // and the ⚿ glyph tells them when presence and access disagree.
  //
  // The refusal belongs to a source that is genuinely gone, and that one says so.
  if (card.missing) {
    notify({ key: "DP.notice.sourceMissing" }, "warn");
    return;
  }

  element = document.createElement("div");
  element.className = "dp-reader";
  element.setAttribute("role", "dialog");
  // Not modal: the map behind stays live, and a GM must still be able to move a token
  // while a player is reading.
  element.setAttribute("aria-modal", "false");
  element.setAttribute("aria-label", escapeAttr(card.title || t("DP.reader.title")));
  element.tabIndex = -1;
  element.innerHTML =
    card.html +
    `<button type="button" class="dp-reader__close" aria-label="${escapeAttr(t("DP.reader.close"))}">` +
    `<i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;

  mount(element);
  place(element, tileDoc);
  openId = tileDoc.id;

  // Dimming the mesh is what makes the reader read as the SAME object sharpening,
  // rather than a second copy appearing on top of the first.
  setMeshDim(tileDoc, true);
  propManager().setFocused(tileDoc.id);

  attach();
  requestAnimationFrame(() => element?.classList.add("dp-reader--in"));
  element.focus({ preventScroll: true });
  Hooks.callAll(`${MODULE_ID}.readerOpened`, tileDoc);
}

export function closeReader(): void {
  // Supersede any open still in flight, so it cannot mount after this.
  openToken++;
  placedAt = null;

  for (const off of listeners) off();
  listeners = [];

  const doc = openId ? cv()?.scene?.tiles?.get(openId) : null;
  if (doc) setMeshDim(doc, false);

  // The state resets at once, so a second open can begin immediately; the node itself
  // dissolves over the already-restored prop, which is the opening in reverse.
  const node = element;
  element = null;
  openId = null;
  propManager().setFocused(null);
  if (node) void leave(node, "dp-reader--out");
  Hooks.callAll(`${MODULE_ID}.readerClosed`);
}

/** Keep the reader glued to its prop through a pan, a zoom or a move. */
export function repositionReader(): void {
  if (!element || !openId) return;
  const doc = cv()?.scene?.tiles?.get(openId);
  if (!doc) {
    closeReader();
    return;
  }
  place(element, doc);
}

/**
 * Position in SCENE space.
 *
 * The overlay root already carries the stage matrix, so the reader needs no transform
 * of its own beyond the prop's rotation, and it stays in exact registration with the
 * prop through any pan or zoom without a single per-frame write.
 */
function place(node: HTMLElement, doc: any): void {
  // Dirty-checked, as `canvasPan`'s comment in `main.ts` already claimed it was. Without
  // this it wrote five style values on every tick of an animated pan, for a rectangle
  // that had not moved in scene space at all.
  const next = {
    x: doc.x,
    y: doc.y,
    width: doc.width,
    height: doc.height,
    rotation: doc.rotation ?? 0,
  };
  if (
    placedAt &&
    placedAt.x === next.x &&
    placedAt.y === next.y &&
    placedAt.width === next.width &&
    placedAt.height === next.height &&
    placedAt.rotation === next.rotation
  ) {
    return;
  }
  placedAt = next;

  write(node, () => {
    node.style.left = `${next.x}px`;
    node.style.top = `${next.y}px`;
    node.style.width = `${next.width}px`;
    node.style.height = `${next.height}px`;
    node.style.transform = `rotate(${next.rotation}deg)`;
  });
}

function setMeshDim(doc: any, dim: boolean): void {
  const mesh = doc?.object?.mesh;
  if (!mesh) return;
  mesh.alpha = dim ? 0.15 : (doc.alpha ?? 1);
}

function attach(): void {
  const on = (target: EventTarget, type: string, handler: any, options?: any) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  on(element!, "click", (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(".dp-reader__close")) closeReader();
  });

  // "There is more below." The fade the sheet carries is gated on the scroll position
  // here, because the reader scrolls where a prop clips: it shows while the body can
  // still scroll and goes once the last line is in view. One layout read per scroll
  // event, off the frame path.
  const body = element!.querySelector<HTMLElement>(".dp-card__body");
  if (body) {
    const node = element!;
    const update = () => {
      node.dataset.dpMore = String(body.scrollTop + body.clientHeight < body.scrollHeight - 1);
    };
    on(body, "scroll", update, { passive: true });
    requestAnimationFrame(update);
  }

  on(
    window,
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeReader();
    },
    { capture: true }
  );

  // A click anywhere else on the map closes it — the same gesture that would move on
  // to the next thing, rather than requiring a deliberate dismissal first.
  on(document.getElementById("board") ?? document.body, "pointerdown", () => closeReader(), {
    capture: true,
  });
}

declare const Hooks: any;
