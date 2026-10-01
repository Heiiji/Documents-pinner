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

import { DELETE_PREFIX, INTERNAL_OPTION } from "./const";
import { logger } from "./log";
import { t, tn } from "./i18n";
import { escapeHtml } from "./html";
import type { DpNotice } from "./types/dp";

const log = logger("core");

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

/**
 * A value that deletes the field it is written to, in the syntax this core speaks.
 *
 * v14 replaced the `-=key` special keys with `DataFieldOperator` values. The old keys
 * still work there, but each write that uses one logs a compatibility warning, and they
 * are removed in v16. `null` when the operators are not there, for the caller to fall
 * back to the old key.
 */
export function forcedDeletion(): unknown {
  const ForcedDeletion = ns("data.operators.ForcedDeletion");
  return typeof ForcedDeletion === "function" ? new ForcedDeletion() : null;
}

/** An update that deletes `parent.key`, as an operator where core has one. */
export function deletionUpdate(parent: string, key: string): Record<string, unknown> {
  const operator = forcedDeletion();
  return operator
    ? { [`${parent}.${key}`]: operator }
    : { [`${parent}.${DELETE_PREFIX}${key}`]: null };
}

/**
 * A value that replaces the field it is written to whole, rather than being merged into
 * it — or `null` on a core without operators.
 */
export function forcedReplacement(value: unknown): unknown {
  const ForcedReplacement = ns("data.operators.ForcedReplacement");
  return typeof ForcedReplacement?.create === "function" ? ForcedReplacement.create(value) : null;
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
  else log.info(message);
}

/**
 * Ask the GM a yes/no question, and resolve whether the answer was yes.
 *
 * A dialog closed with its ✕ is a no, and so is a build with no `DialogV2` to ask with:
 * an action that cannot ask does not act unasked. The body is one escaped paragraph of
 * `bodyKey` formatted with `data`; `options` pass on to `DialogV2.confirm` — the
 * migration's `yes: { default: true }`.
 */
export async function confirmDialog(
  titleKey: string,
  bodyKey: string,
  data: Record<string, unknown> = {},
  options: Record<string, unknown> = {}
): Promise<boolean> {
  const DialogV2 = ns("applications.api.DialogV2");
  if (!DialogV2?.confirm) return false;
  try {
    const answer = await DialogV2.confirm({
      window: { title: t(titleKey) },
      content: `<p>${escapeHtml(t(bodyKey, data))}</p>`,
      ...options,
    });
    return answer === true;
  } catch {
    return false;
  }
}

/**
 * Open core's file browser on one type of file — `"image"`, `"audio"`, `"imagevideo"` —
 * and hand the chosen path to `pick`. Returns whether it opened: not on a build with no
 * browser, and not when the browser throws, which is logged rather than thrown into the
 * button that asked. `current` is the path it opens on.
 */
export function browseFiles(type: string, pick: (path: string) => void, current?: string): boolean {
  const FilePicker = ns("applications.apps.FilePicker.implementation");
  if (!FilePicker) return false;
  const failed = (error: unknown) => log.warn(`the file browser could not open`, error);
  try {
    const picker = new FilePicker({ type, current, callback: pick });
    void Promise.resolve(picker.render({ force: true })).catch(failed);
    return true;
  } catch (error) {
    failed(error);
    return false;
  }
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

/**
 * The synchronous form, for render paths that cannot await.
 *
 * World uuids return the Document. A compendium document returns its INDEX ENTRY — a
 * plain object (`_id`, `uuid`, `name`, …, no methods) — or, for five minutes after
 * anything loaded it, the Document; an embedded compendium document (a page) throws unless
 * its parent is cached, and the throw becomes null here. Never infer a source's shape
 * from this: ask `describeSource` (`sources/describe.ts`), which never calls it for a pack.
 */
export function resolveUuidSync(uuid: string | null | undefined): any {
  if (!uuid) return null;
  const fn = (globalThis as any).fromUuidSync ?? ns("utils.fromUuidSync");
  try {
    return fn ? fn(uuid) : null;
  } catch {
    return null;
  }
}

/**
 * Every compendium pack this client holds, in `game.packs` order.
 *
 * Empty before `setup`, and only the packs core sends this client: a player's client may
 * not hold a pack hidden from them at all (unverified, DESIGN A27's probe C2).
 */
export function packs(): any[] {
  const all = g()?.packs;
  if (!all) return [];
  return all.contents ?? [...(all.values?.() ?? [])];
}

/** The world collection of a document type: `game.journal` for `JournalEntry`, and so on. */
export function worldCollection(documentName: string): any {
  const game = g();
  const named = game?.collections?.get?.(documentName);
  if (named) return named;
  const known: Record<string, any> = {
    JournalEntry: game?.journal,
    Actor: game?.actors,
    Item: game?.items,
  };
  return known[documentName] ?? null;
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
