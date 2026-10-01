/**
 * "Hide while I edit", across a reload: the holds a Pin Studio places, and the `ready` sweep
 * that ends the ones no Studio could.
 *
 * IMPURE: the `editHolds` setting, and the pin's audience through the API. A hold is the
 * pin's uuid, its world and the audience it hid; the Studio writes one before it hides the
 * pin and drops it when it reveals it again, so a reload in between strands nothing.
 * `PinStudio` re-exports `resumeEditHolds`, which `main.ts` calls at `ready`.
 */

import { g, isGM, notify, resolveUuidSync } from "../fvtt";
import * as api from "../api";
import { logger } from "../log";
import { resumeAfterEdit } from "../data/audience";
import * as settings from "../settings";
import type { EditHold } from "../settings";
import { readPin } from "../data/PinData";

const log = logger("studio");

/** The world this client is in, or null on a build that does not say. */
export function worldId(): string | null {
  const id = g()?.world?.id;
  return typeof id === "string" && id ? id : null;
}

/** The holds this client has placed, read defensively: the setting is ours, but stored. */
function readHolds(): EditHold[] {
  const stored = settings.get("editHolds");
  if (!Array.isArray(stored)) return [];
  return stored.filter((hold): hold is EditHold => typeof hold?.anchor === "string");
}

export function writeHolds(change: (holds: EditHold[]) => EditHold[]): Promise<void> {
  return settings.set("editHolds", change(readHolds()));
}

/**
 * Reveal a held pin again iff it is still exactly as the hold left it.
 *
 * The anchor is resolved afresh from its uuid, never taken from a Studio: the pin may have
 * been deleted meanwhile, and a deleted pin is simply not there to reveal.
 */
export async function resumeOne(hold: EditHold): Promise<boolean> {
  const doc = resolveUuidSync(hold.anchor);
  const pin = readPin(doc);
  const next = pin ? resumeAfterEdit(pin.audience, hold.restore) : null;
  if (!next) return false;
  await api.setAudience(doc, next);
  return true;
}

/**
 * The `ready` sweep: end every hold a Studio could not end itself — the page reloaded,
 * or the browser closed, with a pin hidden for editing.
 *
 * Each pin still as its hold left it is revealed again, to the same players; one the GM
 * changed since is left as it is. Every hold of this world is then dropped in one write,
 * resumed or not, and the GM is told how many came back. A hold of another world is kept
 * for that world. A GM who never returns leaves the pin hidden with its audience
 * remembered: one Space from where it was.
 */
export async function resumeEditHolds(): Promise<number> {
  if (!isGM()) return 0;
  const world = worldId();
  const mine = readHolds().filter((hold) => !hold.world || !world || hold.world === world);
  if (!mine.length) return 0;

  let resumed = 0;
  for (const hold of mine) {
    try {
      if (await resumeOne(hold)) resumed++;
    } catch (error) {
      log.warn(`could not reveal ${hold.anchor} again after a reload`, error);
    }
  }
  const swept = new Set(mine.map((hold) => hold.anchor));
  await writeHolds((holds) => holds.filter((hold) => !swept.has(hold.anchor)));
  if (resumed) notify({ key: "DP.notice.editHoldsResumed", data: { count: resumed } }, "info");
  return resumed;
}
