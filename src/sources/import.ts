/**
 * Import & pin: a world copy of a compendium document, for players who cannot open the
 * pack it is in.
 *
 * IMPURE, GM-only. A pack's permissions are per role and pack-wide, so there is no way to
 * share one letter from it with one player — and no way this module may try: it never
 * writes a pack's ownership. A world copy is an ordinary document, which the pin's own
 * audience and ownership sync can share like any journal, and which starts with core's
 * cleared ownership, so importing it widens nothing by itself.
 *
 * Copies go to one folder per document type, found by a flag rather than by name so a GM
 * may rename it, and are found again by the pack uuid core records on the copy
 * (`_stats.compendiumSource`) or, should a core not record it, by the module's own flag —
 * a uuid VALUE, never a key, so v14's dotted-key expansion leaves it alone. Choosing the
 * same compendium letter twice pins the copy made the first time.
 *
 * Generic over the document type: what is imported is whatever the pack holds.
 */

import { MODULE_ID } from "../const";
import { cfg, g, isGM, notify, worldCollection } from "../fvtt";
import { t } from "../i18n";
import { logger } from "../log";
import type { DpSource } from "../types/dp";
import { packFacts, packOf } from "./packs";
import { parseSourceUuid } from "./uuid";

const log = logger("import");

/** The world copy of a pack document, as a source to pin; null when there is none. */
export async function importForPin(uuid: string): Promise<DpSource | null> {
  if (!isGM()) return null;
  const parsed = parseSourceUuid(uuid);
  const pack = packOf(uuid);
  const indexed = pack?.index?.get?.(parsed?.rootId ?? "");
  const name = typeof indexed?.name === "string" ? indexed.name : "";
  const failed = () => {
    notify({ key: "DP.notice.importFailed", data: { name } }, "warn");
    return null;
  };

  // A whole document only: a page belongs to its journal, and the picker offers entries.
  if (!parsed?.packId || !pack || parsed.embedded.length) return failed();
  const documentName = parsed.documentName ?? packFacts(pack).documentName;
  const collection = worldCollection(documentName);
  if (typeof collection?.importFromCompendium !== "function") return failed();

  const existing = importedCopyOf(collection, uuid);
  if (existing) return sourceOf(existing);

  try {
    const folder = await importFolder(documentName);
    // Nested, not a dotted key: core applies this through a clone of the pack document
    // (TYPES `world-collection.d.mts:52-53`), and nothing here should rest on that clone
    // expanding paths the way an update does.
    const copy = await collection.importFromCompendium(pack, parsed.rootId, {
      ...(folder?.id ? { folder: folder.id } : {}),
      flags: { [MODULE_ID]: { importedFrom: uuid } },
    });
    if (typeof copy?.uuid !== "string") return failed();
    notify(
      { key: "DP.notice.imported", data: { name: copy.name ?? name, folder: folder?.name ?? "" } },
      "info"
    );
    return sourceOf(copy);
  } catch (error) {
    log.warn(`could not import ${uuid}`, error);
    return failed();
  }
}

function sourceOf(doc: any): DpSource {
  return {
    kind: "document",
    uuid: doc.uuid,
    src: null,
    pageId: null,
    pdfPage: null,
    followName: true,
  };
}

/** A world document already imported from this pack uuid, if there is one. */
function importedCopyOf(collection: any, uuid: string): any {
  const all: any[] = collection?.contents ?? [];
  return (
    all.find(
      (doc) =>
        doc?._stats?.compendiumSource === uuid || doc?.flags?.[MODULE_ID]?.importedFrom === uuid
    ) ?? null
  );
}

/**
 * The module's import folder for this document type, made the first time. A core with no
 * Folder class imports to the root, which is still a copy the GM can find.
 */
async function importFolder(documentName: string): Promise<any> {
  const folders: any[] = g()?.folders?.contents ?? [];
  const found = folders.find(
    (folder) => folder?.type === documentName && folder?.flags?.[MODULE_ID]?.imports === true
  );
  if (found) return found;
  const Folder = cfg()?.Folder?.documentClass;
  if (typeof Folder?.create !== "function") return null;
  return (
    (await Folder.create({
      name: t("DP.import.folder"),
      type: documentName,
      flags: { [MODULE_ID]: { imports: true } },
    })) ?? null
  );
}
