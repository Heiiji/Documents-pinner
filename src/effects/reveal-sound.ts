/**
 * The reveal sound: "the wax seal cracks as the letter appears".
 *
 * IMPURE: core's audio helper, and the browser's audio lock. Which sound a prop arrives
 * with, and playing one on this client. The manager plays it when a prop arrives; the two
 * Studios' ▶ play it for the GM, whose client never sees a prop arrive. It lived in
 * `PropManager`, which pulled the whole manager into both Studios for two functions;
 * `PropManager` re-exports both, where `reveal-sound.test.ts` reads them.
 */

import { g, ns, nsAny } from "../fvtt";
import { logger } from "../log";
import { soundPath } from "../normalise";
import { findPreset } from "./preset-library";
import type { DpPinFlags } from "../types/dp";

// The manager's scope: these lines read in the console as they always did.
const log = logger("props");

/**
 * The sound a prop arrives with: its own, else its preset's. The one definition, shared
 * with the Pin Studio's ▶ so the GM hears what the players will.
 */
export function revealSoundOf(pin: DpPinFlags): string | null {
  return pin.effect.revealSound ?? findPreset(pin.effect.id)?.reveal.sound ?? null;
}

/**
 * Play a reveal sound, on THIS client only.
 *
 * Every client in the audience hears its own copy when its own prop arrives — the module
 * has no socket and needs none — which is also why the GM, whose client never sees a
 * prop "appear", hears one only through the Studios' ▶, the `preview` path.
 *
 * On the `environment` channel with no volume of its own, so it follows each player's
 * Environment slider rather than a level this module guessed; skipped while the browser
 * has not yet had the gesture that unlocks audio, where core queues it to burst out on the
 * first click, long after the reveal. The path is re-checked by the one same-origin rule
 * the normalisers apply: this is the last step before the audio stack fetches it. Never
 * throws — a reveal is a LOD pass, and a failed sound must not cost the prop its arrival.
 */
export function playRevealSound(
  src: string | null,
  { preview = false }: { preview?: boolean } = {}
): boolean {
  const path = soundPath(src, [], "", "");
  if (!path) return false;
  try {
    if (!preview && g()?.audio?.locked === true) return false;
    const AudioHelper = nsAny("audio.AudioHelper", "helpers.AudioHelper");
    if (typeof AudioHelper?.play !== "function") {
      log.debug(`no audio helper; reveal sound ${path} not played`);
      return false;
    }
    const channels = ns("CONST.AUDIO_CHANNELS") ?? (globalThis as any).CONST?.AUDIO_CHANNELS;
    const data =
      channels && "environment" in channels ? { src: path, channel: "environment" } : { src: path };
    void Promise.resolve(AudioHelper.play(data, false)).catch((error: unknown) =>
      log.warn(`could not play reveal sound ${path}`, error)
    );
    return true;
  } catch (error) {
    log.warn(`could not play reveal sound ${path}`, error);
    return false;
  }
}
