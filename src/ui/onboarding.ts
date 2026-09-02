/**
 * The first five minutes, and "what changed since last week".
 *
 * IMPURE below the helpers. The module's two headline ideas are invisible without this:
 * the placement gesture is Alt-drag from the sidebar, which nothing on screen suggests,
 * and a release that changes what a resize does is a release a GM would otherwise
 * discover by accident. So, once per client, GM only: a welcome the first time, and a
 * short "what's new" when the version has moved — never re-offered, never for players,
 * never on a scene's draw path. The same once-per-session-GM-only shape the migration
 * offer uses.
 */

import { MODULE_ID } from "../const";
import { g, isGM } from "../fvtt";
import { t } from "../i18n";
import { escapeHtml } from "../html";
import * as settings from "../settings";
import { openPicker } from "../apps/DocumentPicker";

/**
 * What each minor version brought, as i18n keys — a few bullets, not the changelog.
 * Keyed by "major.minor" so a patch release says nothing.
 */
export const WHATS_NEW: Record<string, string[]> = {
  "0.2": [
    "DP.whatsnew.v0_2.resize",
    "DP.whatsnew.v0_2.fit",
    "DP.whatsnew.v0_2.grab",
    "DP.whatsnew.v0_2.reader",
    "DP.whatsnew.v0_2.menu",
  ],
};

/** PURE. Compare two dotted versions numerically: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** PURE. The bullets for every minor version above `seen` and up to `current`. */
export function whatsNewFor(seen: string, current: string): string[] {
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  return Object.entries(WHATS_NEW)
    .filter(([version]) => compareVersions(version, minor(seen)) > 0)
    .filter(([version]) => compareVersions(version, minor(current)) <= 0)
    .sort(([a], [b]) => compareVersions(a, b))
    .flatMap(([, keys]) => keys);
}

function moduleVersion(): string {
  return g()?.modules?.get(MODULE_ID)?.version ?? "0.0.0";
}

/** Run at `ready`. GM only; nothing is awaited by the caller. */
export async function onboardingReady(): Promise<void> {
  if (!isGM()) return;
  const DialogV2 = (globalThis as any).foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.confirm) return;

  const version = moduleVersion();
  const seen = settings.get("seenVersion");

  if (!seen) {
    const lines = [
      "DP.onboarding.dragLine",
      "DP.onboarding.boardLine",
      "DP.onboarding.lastLine",
      "DP.onboarding.grabLine",
    ]
      .map((key) => `<li>${escapeHtml(t(key))}</li>`)
      .join("");
    const wants = await DialogV2.confirm({
      window: { title: t("DP.onboarding.title") },
      content: `<p>${escapeHtml(t("DP.onboarding.welcome"))}</p><ul>${lines}</ul>`,
      yes: { label: t("DP.onboarding.place"), default: true },
      no: { label: t("DP.onboarding.later") },
    }).catch(() => false);
    await settings.set("seenVersion", version);
    if (wants) openPicker();
    return;
  }

  if (compareVersions(version, seen) <= 0) return;
  const keys = whatsNewFor(seen, version);
  await settings.set("seenVersion", version);
  if (!keys.length) return;

  const bullets = keys.map((key) => `<li>${escapeHtml(t(key))}</li>`).join("");
  const content = `<ul>${bullets}</ul>`;
  const title = t("DP.onboarding.whatsNewTitle", { version });
  if (DialogV2.prompt) {
    await DialogV2.prompt({
      window: { title },
      content,
      ok: { label: t("DP.onboarding.ok") },
    }).catch(() => null);
  } else {
    await DialogV2.confirm({
      window: { title },
      content,
      yes: { label: t("DP.onboarding.ok"), default: true },
      no: { label: t("DP.onboarding.ok") },
    }).catch(() => null);
  }
}
