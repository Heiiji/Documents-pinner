/**
 * The boundary with Foundry.
 *
 * IMPURE by design, and deliberately the only place that reaches for a global without
 * a guard. Everything here answers one of two questions: "does this build actually
 * have that API?" and "is this client the one that should act?".
 *
 * Namespaces are resolved by path at call time rather than imported, because the v14
 * type definitions are immature and the namespaces moved twice during v13. A missing
 * API returns `undefined` and the caller degrades; it never throws at import time and
 * takes the whole module down with it.
 */

import { INTERNAL_OPTION, MODULE_ID } from "./const";
import { tn } from "./i18n";
import type { DpNotice } from "./types/dp";

declare const game: any;
declare const canvas: any;
declare const ui: any;
declare const foundry: any;
declare const CONFIG: any;

export const g = (): any => (typeof game === "undefined" ? undefined : game);
export const cv = (): any => (typeof canvas === "undefined" ? undefined : canvas);
export const notifications = (): any => (typeof ui === "undefined" ? undefined : ui?.notifications);
export const cfg = (): any => (typeof CONFIG === "undefined" ? undefined : CONFIG);

/**
 * Resolve a dotted path under `foundry`, e.g. `"applications.api.DialogV2"`.
 * Returns `undefined` for any missing segment rather than throwing.
 */
export function ns(path: string): any {
  if (typeof foundry === "undefined") return undefined;
  let node: any = foundry;
  for (const segment of path.split(".")) {
    if (node === null || node === undefined) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * The first of `paths` that resolves. Names moved between v12 and v14 and may move
 * again; a caller states every place an API has lived and gets whichever exists.
 */
export function nsAny(...paths: string[]): any {
  for (const path of paths) {
    const found = ns(path);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function isGM(): boolean {
  return g()?.user?.isGM === true;
}

/**
 * Whether this client is the one GM that should perform world-wide writes.
 *
 * Migrations, the ledger sweep and discovery recording must happen exactly once even
 * with four GMs connected. Core designates one; if that ever disappears, fall back to
 * the lowest user id among active GMs, which every client computes identically.
 */
export function isPrimaryGM(): boolean {
  const game = g();
  if (!game?.user?.isGM) return false;

  const designated = game.users?.activeGM;
  if (designated) return designated.id === game.user.id;

  const active = (game.users?.contents ?? [])
    .filter((u: any) => u.active && u.isGM)
    .map((u: any) => u.id)
    .sort();
  return active[0] === game.user.id;
}

/** Every non-GM user id, in a stable order. The audience chips iterate this. */
export function playerIds(): string[] {
  return (g()?.users?.contents ?? [])
    .filter((u: any) => !u.isGM)
    .map((u: any) => u.id)
    .sort();
}

export function notify(notice: DpNotice | string, type: "info" | "warn" | "error" = "info"): void {
  const message = typeof notice === "string" ? notice : tn(notice);
  const target = notifications();
  if (target?.[type]) target[type](message);
  else console.log(`${MODULE_ID} | ${message}`);
}

/** Options every document write from this module carries, so our hooks can stand down. */
export function internal<T extends Record<string, unknown>>(options?: T): T & { render?: boolean } {
  return { ...(options ?? ({} as T)), [INTERNAL_OPTION]: true };
}

/** Whether a hook is reporting a change this module itself made. */
export function isOurs(options: any): boolean {
  return options?.[INTERNAL_OPTION] === true;
}

export async function resolveUuid(uuid: string | null | undefined): Promise<any> {
  if (!uuid) return null;
  const fn = (globalThis as any).fromUuid ?? ns("utils.fromUuid");
  try {
    return fn ? await fn(uuid) : null;
  } catch {
    return null;
  }
}

/** The synchronous form, for render paths that cannot await. Compendia return null. */
export function resolveUuidSync(uuid: string | null | undefined): any {
  if (!uuid) return null;
  const fn = (globalThis as any).fromUuidSync ?? ns("utils.fromUuidSync");
  try {
    return fn ? fn(uuid) : null;
  } catch {
    return null;
  }
}

export function randomId(): string {
  return ns("utils.randomID")?.() ?? Math.random().toString(36).slice(2, 18);
}

/**
 * The renderer's pixel ratio.
 *
 * NOT `window.devicePixelRatio`: Foundry runs its renderer at a resolution the user
 * controls, measured at 1 even on a Retina display in the probe. Sizing textures from
 * the display's ratio would allocate four times the VRAM for pixels Foundry never
 * puts on screen.
 */
export function rendererResolution(): number {
  const value = cv()?.app?.renderer?.resolution;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** `requestIdleCallback`, or a timeout shim — WebKit still has no native one. */
export function onIdle(fn: () => void, timeout = 200): number {
  const ric = (globalThis as any).requestIdleCallback;
  if (typeof ric === "function") return ric(fn, { timeout });
  return window.setTimeout(fn, 1);
}

export function cancelIdle(handle: number): void {
  const cic = (globalThis as any).cancelIdleCallback;
  if (typeof cic === "function") cic(handle);
  else window.clearTimeout(handle);
}
