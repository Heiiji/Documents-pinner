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
import { cv, g } from "../fvtt";
import { t } from "../i18n";
import { escapeAttr } from "../html";
import { readPin } from "../data/PinData";
import { resolveCard } from "../render/ContentResolver";
import { propManager } from "../canvas/PropManager";
import { mount, write } from "./OverlayRoot";

let element: HTMLElement | null = null;
let openId: string | null = null;
let listeners: (() => void)[] = [];

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

  const size = { width: tileDoc.width, height: tileDoc.height };
  const card = await resolveCard(pin, size, { tier: "L3", baked: false });
  if (!card.readable && !g()?.user?.isGM) return;

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
  for (const off of listeners) off();
  listeners = [];

  const doc = openId ? cv()?.scene?.tiles?.get(openId) : null;
  if (doc) setMeshDim(doc, false);

  element?.remove();
  element = null;
  openId = null;
  propManager().setFocused(null);
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
  write(node, () => {
    node.style.left = `${doc.x}px`;
    node.style.top = `${doc.y}px`;
    node.style.width = `${doc.width}px`;
    node.style.height = `${doc.height}px`;
    node.style.transform = `rotate(${doc.rotation ?? 0}deg)`;
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
