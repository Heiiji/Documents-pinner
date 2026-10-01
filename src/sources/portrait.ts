/**
 * Actors and items, as a source: a portrait card.
 *
 * IMPURE only where it opens a sheet and reads the viewed scene's pins. A wanted poster on
 * the tavern's notice board is the bandit's portrait, his name, and the line of his
 * biography the GM chose; a found object is the item's picture, its name and its
 * description. Both are the same card: a picture above the name, the chosen text below,
 * in the shell every other card uses, so papers, effects, typefaces and Fit to content
 * keep working. The layout follows from the source; nothing about it is stored.
 *
 * What differs between the two is said by `PortraitKind`: an actor's artwork may be its
 * prototype token's, and a reveal grants it LIMITED at most — OBSERVER opens an NPC's whole
 * sheet, stat block included, and is very likely to share its tokens' sight as well
 * (RECALLED, unverified). What a LIMITED sheet shows is the game system's choice.
 *
 * Owned items and token actors are refused: their ownership is their parent's, so a grant
 * on one would land on the wrong document, and a pin cannot follow a token's actor across
 * scenes. A drop of one says so; nothing else offers them.
 */

import { MODULE_ID } from "../const";
import { cfg, cv, ns } from "../fvtt";
import { rawPinFlag } from "../data/PinData";
import { documentSource } from "../data/pin-schema";
import type { DpSource } from "../types/dp";
import { readField, shownField } from "./fields";
import type { GrantTarget, Refusal, ShownFacts, SourceAdapter, SourceFacts } from "./index";
import { parseSourceUuid } from "./uuid";

/** What tells an actor's adapter from an item's. */
export interface PortraitKind {
  documentName: "Actor" | "Item";
  /** A Font Awesome class for the kind of thing it is. */
  icon: string;
  /** The highest level a reveal grants on it. */
  maxGrant: 1 | 2;
  /** Whether a new pin on it follows the world's ownership-sync setting, or starts off. */
  syncOnCreate: boolean;
  /** Whether its prototype token's texture stands in for a default portrait. */
  tokenArt: boolean;
}

const REFUSED: Refusal = { refused: "DP.notice.embeddedRefused" };

const sourceOf = (uuid: string): DpSource => documentSource(uuid);

/**
 * Whether a uuid names a top-level document of this type — not an item an actor owns, not
 * the actor of a token — or null when it is not a uuid at all. A compendium uuid of the
 * older four-segment form names no type, and the pack's own stands in.
 */
function topLevel(uuid: unknown, documentName: string): boolean | null {
  const parsed = parseSourceUuid(uuid);
  if (!parsed) return null;
  if (parsed.embedded.length) return false;
  return parsed.rootType === null || parsed.rootType === documentName;
}

/** Core's own pictures for this type: a portrait that is one of these is no portrait. */
const defaults = new Map<string, Set<string>>();

/**
 * The default artwork of a type, once per type for the session. `getDefaultArtwork` is
 * asked with the type alone: a system that overrides it picks by type, and handing it the
 * whole document (`toObject`) would copy every actor's data on every label read.
 */
function defaultArt(documentName: string, type: unknown): Set<string> {
  const key = `${documentName}:${typeof type === "string" ? type : ""}`;
  const known = defaults.get(key);
  if (known) return known;

  const found = new Set<string>();
  const add = (src: unknown) => {
    if (typeof src === "string" && src) found.add(src);
  };
  const cls = cfg()?.[documentName]?.documentClass;
  add(cls?.DEFAULT_ICON);
  if (documentName === "Actor") add(ns("CONST.DEFAULT_TOKEN"));
  try {
    const art = cls?.getDefaultArtwork?.({ type, name: "" });
    add(art?.img);
    add(art?.texture?.src);
  } catch {
    /* a system's override that wanted more than a type: the core defaults still apply */
  }
  defaults.set(key, found);
  return found;
}

/**
 * The picture a card sets above the name, or null: the document's own image unless it is
 * a default, else — for an actor — its prototype token's texture unless that is one too.
 * A mystery man on a wanted poster says less than no picture at all.
 */
export function portraitOf(documentName: string, shown: ShownFacts | null, tokenArt: boolean) {
  if (!shown) return null;
  const known = defaultArt(documentName, shown.type);
  const usable = (src: unknown): src is string =>
    typeof src === "string" && !!src && !known.has(src);
  if (usable(shown.img)) return shown.img;
  const token = shown.prototypeToken?.texture?.src;
  return tokenArt && usable(token) ? token : null;
}

/**
 * Whether an update hook's change reaches the field at `path` under `system`: it names
 * the field, a parent of it, or replaces a parent whole.
 */
function touches(system: unknown, path: string): boolean {
  let node: any = system;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object") return node !== undefined;
    const proto = Object.getPrototypeOf(node);
    // An operator — a replacement of the whole subtree — rather than a plain diff.
    if (proto !== Object.prototype && proto !== null) return true;
    if (!(segment in node)) return false;
    node = node[segment];
  }
  return true;
}

/** Keys of a change that redraw a card on this document whatever text it shows. */
const DRAWN = ["name", "img", "prototypeToken", "ownership"];

export function portraitAdapter(kind: PortraitKind): SourceAdapter {
  const { documentName } = kind;
  const isSource = (doc: any) => !!doc && !doc.parent && doc.isToken !== true;
  const picture = (shown: any) => portraitOf(documentName, shown, kind.tokenArt);

  return {
    names: [documentName],
    layout: "portrait",
    // Core's own sheets ask LIMITED of a viewer (TYPES `document-sheet.d.mts:140`); what a
    // LIMITED sheet then shows is the system's.
    openLevel: "LIMITED",
    maxGrant: kind.maxGrant,
    syncOnCreate: kind.syncOnCreate,
    // `Journal.show` resolves without showing anything for any other document (TYPES
    // `journal.d.mts:40-46`): claiming it was shown would be a lie.
    canShow: false,
    // The directory's own hook, as for a journal (foundry.mjs 14.368, 131819).
    contextHooks: [`get${documentName}ContextOptions`],

    fromDrop(data) {
      if (data?.type !== documentName || typeof data.uuid !== "string") return null;
      const top = topLevel(data.uuid, documentName);
      if (top === null) return null;
      return top ? sourceOf(data.uuid) : REFUSED;
    },
    fromDocument(doc) {
      if (typeof doc?.uuid !== "string") return null;
      if (!isSource(doc) || topLevel(doc.uuid, documentName) === false) return REFUSED;
      return sourceOf(doc.uuid);
    },
    isSource,

    /**
     * DESIGN A28, P5. An actor's update hook fires on every hit-point change in combat, and
     * each one that passed would re-enrich and re-rasterise a wanted poster. So: only for a
     * pin on the scene being viewed, and only when the change reaches its name, its
     * pictures, its ownership, this module's flags, or the very field the pin shows.
     */
    redrawsOn(doc, change) {
      if (!isSource(doc) || !change || typeof change !== "object") return false;
      const drawn = DRAWN.some((key) => key in change) || change.flags?.[MODULE_ID] !== undefined;
      const flat = Object.keys(change).filter((key) => key.startsWith("system."));
      if (!drawn && change.system === undefined && !flat.length) return false;

      for (const tile of cv()?.scene?.tiles?.contents ?? []) {
        const source = (rawPinFlag(tile) as any)?.source;
        if (source?.uuid !== doc.uuid) continue;
        if (drawn) return true;
        const path = shownField(documentName, doc.type, source.field, doc);
        if (!path) continue;
        if (change.system !== undefined && touches(change.system, path)) return true;
        const full = `system.${path}`;
        if (flat.some((key) => key === full || full.startsWith(`${key}.`))) return true;
      }
      return false;
    },

    shown: (named) => named,
    describe(shown): SourceFacts {
      const name = typeof shown.name === "string" ? shown.name : "";
      return { name, breadcrumb: name, icon: kind.icon, thumbnail: picture(shown), isPage: false };
    },
    pdf: () => null,
    rawContent(shown, pin) {
      const path = shownField(documentName, shown?.type, pin.source.field, shown);
      return {
        text: path ? readField(shown?.system, path) : "",
        kind: documentName.toLowerCase(),
        figure: picture(shown),
      };
    },
    pages: () => [],

    grantTargets(named, _pageId, level): GrantTarget[] {
      // A compendium's is per role and pack-wide; an owned item's and a token actor's is
      // their parent's. None of them is this document's to grant.
      if (!isSource(named) || named.pack) return [];
      return [{ doc: named, level: Math.min(level, kind.maxGrant) }];
    },
    family: (doc) => (isSource(doc) && !doc.pack ? [doc] : []),
    open: (shown) => shown.sheet?.render?.({ force: true }),
  };
}
