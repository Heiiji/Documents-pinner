/**
 * Logging.
 *
 * PURE apart from `console` itself, so every module can reach it without a cycle: it
 * takes its level through `setLogLevel` rather than reading the setting, because
 * `settings.ts` imports half the module and a logger that imports settings would make
 * the dependency graph circular for something that has to work before `init`.
 *
 * Why a level at all, when the module already had a handful of `console.warn`s:
 *
 * - **The default is `warn`.** Foundry's console is shared by every module and a system,
 *   and one that chatters in a GM's log is a module they will disable. Nothing routine
 *   prints unless it is asked for.
 * - **`debug` is a real diagnostic surface**, not decoration. The three failures this
 *   module is prone to — a card that will not rasterise, a texture budget that keeps
 *   evicting, an ownership write that did not land — are all invisible from the outside,
 *   and the first thing a bug report needs is which one it was.
 * - **Every message names the subsystem**, so a filter of `documents-pinner | render`
 *   shows the rendering path and nothing else.
 */

import { MODULE_ID } from "./const";

export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

let level: LogLevel = "warn";

export function setLogLevel(next: LogLevel): void {
  level = ORDER[next] === undefined ? "warn" : next;
}

export function logLevel(): LogLevel {
  return level;
}

function enabled(want: LogLevel): boolean {
  return ORDER[want] <= ORDER[level];
}

function emit(
  method: "error" | "warn" | "info" | "debug",
  want: LogLevel,
  scope: string,
  message: string,
  detail: unknown[]
): void {
  if (!enabled(want)) return;
  // The one place in the module that talks to the console directly, and the method is
  // chosen at runtime — which the allow-list rule cannot see through.
  // eslint-disable-next-line no-console
  console[method](`${MODULE_ID} | ${scope} | ${message}`, ...detail);
}

/**
 * A logger bound to one subsystem.
 *
 * Built once per module at import time, so the scope is a constant rather than a string
 * repeated at every call site — which is what makes filtering the console by subsystem
 * work at all.
 */
export function logger(scope: string) {
  return {
    error: (message: string, ...detail: unknown[]) =>
      emit("error", "error", scope, message, detail),
    warn: (message: string, ...detail: unknown[]) => emit("warn", "warn", scope, message, detail),
    info: (message: string, ...detail: unknown[]) => emit("info", "info", scope, message, detail),
    debug: (message: string, ...detail: unknown[]) =>
      emit("debug", "debug", scope, message, detail),
    /** Whether `debug` would print, for messages that cost something to build. */
    get verbose(): boolean {
      return enabled("debug");
    },
  };
}

export type Logger = ReturnType<typeof logger>;
