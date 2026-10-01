/**
 * Pointing at a pin: the one door every ping in the module goes through.
 *
 * IMPURE: core's canvas. Cut out of `api.ts` with Reveal next (A29), which points at the pin
 * it revealed as `flash` and `spotlight` do; under `api/`, it imports nothing of `api.ts`,
 * so the verbs' façade can re-export what is cut out of it without an import cycle.
 */

import { cfg, cv, g } from "../fvtt";
import { logger } from "../log";
import { centreOf } from "../canvas/transform";

const log = logger("api");

/** What a ping did: sent to every client, drawn here only, or not at all and why. */
export type PingOutcome = "broadcast" | "local" | "elsewhere" | "outside" | "unavailable";

/** Whether a pin lies on the scene this client is viewing: the only map a ping reaches. */
export function onViewedScene(anchorDoc: any): boolean {
  const viewed = cv()?.scene?.id;
  const own = anchorDoc?.parent?.id;
  return !!viewed && (!own || own === viewed);
}

/**
 * Point at a pin. The one door every ping in the module goes through.
 *
 * `canvas.ping` draws here AND on every connected client, and whatever it is not told it
 * reads off the keyboard: core builds `{scene, pull: <Shift held>, style, zoom}` and merges
 * the options over it, so a GM holding Shift pulls every view to the spot. The Pinboard's
 * Shift+Space is exactly a Shift held while pinging. So a broadcast here always states
 * `pull` and `style`, and the keyboard decides nothing the table sees.
 *
 * `handlePing` draws on this client alone — and draws nothing unless it is handed the
 * viewed scene's id, which core compares against the one it is showing.
 *
 * A pin on another scene is not pinged at all: its coordinates on the map being viewed
 * point at nothing, and a ping there would send the table looking for it.
 */
export function pingAt(
  anchorDoc: any,
  { broadcast, pull }: { broadcast: boolean; pull: boolean }
): PingOutcome {
  const canvas = cv();
  if (!canvas?.scene?.id || !anchorDoc) return "unavailable";
  if (!onViewedScene(anchorDoc)) return "elsewhere";

  const origin = centreOf(anchorDoc);
  // Core refuses a broadcast outside the scene's rect; the local path is held to the same.
  const rect = canvas.dimensions?.rect;
  if (typeof rect?.contains === "function" && !rect.contains(origin.x, origin.y)) {
    return "outside";
  }

  const types = cfg()?.Canvas?.pings?.types;
  const style = pull ? (types?.PULL ?? "chevron") : (types?.PULSE ?? "pulse");
  const drawn = (ping: unknown) =>
    void Promise.resolve(ping).catch((error) => log.warn("a ping could not be drawn", error));

  try {
    if (broadcast) {
      if (typeof canvas.ping !== "function") return "unavailable";
      drawn(canvas.ping(origin, { pull, style }));
      return "broadcast";
    }
    if (typeof canvas.controls?.handlePing !== "function") return "unavailable";
    drawn(canvas.controls.handlePing(g()?.user, origin, { scene: canvas.scene.id, style }));
    return "local";
  } catch (error) {
    log.warn("a ping could not be drawn", error);
    return "unavailable";
  }
}
