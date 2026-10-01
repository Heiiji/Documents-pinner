/**
 * Which text of an Actor or an Item a card can show.
 *
 * Systems differ: dnd5e keeps a public and a private biography, pf2e an NPC's public and
 * private notes and an item's GM-only description beside the players' one, a homebrew
 * system something else again. So nothing here names a system. The document type's own
 * data model is walked for its HTML fields — the fields a system declares as rich text —
 * and the GM chooses one in the Studio (`source.field`). Null means the automatic choice,
 * which is ranked and never falls on text a GM wrote for themselves.
 *
 * Two halves. The PURE core (`discoverHtmlFields`, `rankDefault`, `readableLabel`,
 * `readField`) touches no global and is the traversal `docs/spike-2-sources-probe.js`
 * section E runs in a live world — they must agree. The impure wrapper (`fieldsFor`)
 * finds the schema through `fvtt.ts` and caches the answer per document type for the
 * session: a type's schema is fixed once `init` has run, and the Studio and every card
 * read the cache, never the schema, after the first time.
 */

import { cfg, g, ns } from "../fvtt";
import { isFieldPath } from "../data/pin-schema";

/** One HTML field of a document type's system data. */
export interface FieldChoice {
  /** Dotted, under `system`: `details.biography.public`. */
  path: string;
  /** What the GM reads in the Studio: the data model's label, else the path made readable. */
  label: string;
}

/** A field as discovery found it, before its label is translated. */
export interface FoundField {
  path: string;
  /** The field's own label, often a localisation key; "" when it has none. */
  label: string;
  hint: string;
}

/** How deep a schema is walked. Eight segments is also the most a stored path may have. */
const MAX_DEPTH = 8;

/**
 * Every HTML field in a schema, depth first, in declaration order.
 *
 * PURE. Recurses into schema fields — which covers a data model's own schema and an
 * embedded data model's, both being schema fields — and records HTML fields; skips
 * everything else. Arrays, sets, typed schemas and free objects have no stable path to a
 * single text, so a card could not name one.
 */
export function discoverHtmlFields(
  schema: any,
  isHtml: (field: unknown) => boolean,
  isSchema: (field: unknown) => boolean
): FoundField[] {
  const found: FoundField[] = [];
  const walk = (field: any, path: string, depth: number) => {
    if (!field || depth > MAX_DEPTH) return;
    if (isHtml(field)) {
      if (path) found.push({ path, label: textOf(field.label), hint: textOf(field.hint) });
      return;
    }
    if (!isSchema(field)) return;
    for (const [name, child] of Object.entries(field.fields ?? {})) {
      walk(child, path ? `${path}.${name}` : name, depth + 1);
    }
  };
  walk(schema, "", 0);
  return found;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The automatic choice, by rank: the first field matching the first pattern that any matches. */
const RANK = [/public/i, /biograph/i, /description/i, /notes/i];

/**
 * Text a GM wrote for themselves, by the name of the segment that holds it: any segment
 * that STARTS with `gm`, `private` or `secret`, whatever follows — `gm`, `gmNotes`,
 * `gmDescription`, `privateNotes`, `privateDescription`, `secret`, `secretNotes`. Never the
 * automatic choice: a `.secret` section is stripped for players, but pf2e's
 * `description.gm` is a whole field of GM text that no section marks.
 *
 * A prefix rather than a list of whole names, because systems name these freely and a
 * name this rule misses reaches the table. Its cost is the other way round and bounded: a
 * player-facing field whose name happens to start so (a `secretary`, a `privateer`) is
 * only left out of the AUTOMATIC choice — the GM can still choose it in the Studio. No
 * text field of dnd5e or pf2e starts with these except GM text.
 */
const NEVER_AUTOMATIC = /(^|\.)(gm|private|secret)[^.]*(\.|$)/i;

/**
 * The field a card shows when the GM has not chosen one, or null when none will do.
 *
 * PURE. Public text first, then a biography, a description, notes; never a GM-only path;
 * failing all of those the first field that is not GM-only.
 */
export function rankDefault(found: readonly { path: string }[]): string | null {
  const eligible = found.filter((field) => !NEVER_AUTOMATIC.test(field.path));
  for (const pattern of RANK) {
    const hit = eligible.find((field) => pattern.test(field.path));
    if (hit) return hit.path;
  }
  return eligible[0]?.path ?? null;
}

/** "details.biography.public" → "Details › Biography › Public". PURE. */
export function readableLabel(path: string): string {
  return path
    .split(".")
    .map((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/^./, (first) => first.toUpperCase())
    )
    .join(" › ");
}

/**
 * The text at a field path under `system`, or "" when there is none.
 *
 * PURE, and walked by hand rather than with core's `getProperty`: the path has already
 * been checked for its shape and against the declared fields, and this refuses the
 * object-machinery segments again, so a path can only ever reach data.
 */
export function readField(system: unknown, path: string): string {
  if (!isFieldPath(path)) return "";
  let node: any = system;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object") return "";
    node = node[segment];
  }
  return typeof node === "string" ? node : "";
}

/**
 * The string leaves of a template.json system's data whose path ranks, for a system with
 * no data model. Such a system declares no field types, so only a path that reads like
 * text is offered at all.
 */
function templateFields(data: unknown, path = "", out: FoundField[] = [], depth = 1): FoundField[] {
  if (!data || typeof data !== "object" || depth > MAX_DEPTH) return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const at = path ? `${path}.${key}` : key;
    if (typeof value === "string" && RANK.some((pattern) => pattern.test(at))) {
      out.push({ path: at, label: "", hint: "" });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      templateFields(value, at, out, depth + 1);
    }
  }
  return out;
}

/** Per `${documentName}:${type}`, for the session: a type's schema is fixed after `init`. */
const discovered = new Map<string, FieldChoice[]>();

/**
 * The HTML fields of one document type's system data, labelled for the Studio.
 *
 * The data model registered for the type (`CONFIG[documentName].dataModels[type]`), else
 * the document's own instance schema, else — for a system with no data model at all —
 * the ranked string leaves of `game.model`. No field classes on this core: no fields, and
 * a card that shows the portrait and the name. Paths that could not be stored are left
 * out, so every choice offered is one the pin can keep.
 */
export function fieldsFor(documentName: string, type: unknown, doc?: any): FieldChoice[] {
  const kind = typeof type === "string" ? type : "";
  const key = `${documentName}:${kind}`;
  const cached = discovered.get(key);
  if (cached) return cached;

  const HTMLField = ns("data.fields.HTMLField");
  const SchemaField = ns("data.fields.SchemaField");
  const classes = typeof HTMLField === "function" && typeof SchemaField === "function";
  const schema = cfg()?.[documentName]?.dataModels?.[kind]?.schema ?? doc?.system?.schema ?? null;
  let found: FoundField[] = [];
  if (schema && classes) {
    found = discoverHtmlFields(
      schema,
      (field) => field instanceof HTMLField,
      (field) => field instanceof SchemaField
    );
  } else if (!schema) {
    found = templateFields(g()?.model?.[documentName]?.[kind]);
  }

  const localize = (text: string): string => {
    const out = text ? g()?.i18n?.localize?.(text) : "";
    return typeof out === "string" ? out : "";
  };
  const fields = found
    .filter((field) => isFieldPath(field.path))
    .map((field) => ({
      path: field.path,
      label: localize(field.label) || readableLabel(field.path),
    }));
  // A schema read without the classes to read it with is no answer about the type: it is
  // asked again next time rather than kept, empty, for the whole session.
  if (schema && !classes) return fields;
  discovered.set(key, fields);
  return fields;
}

/**
 * The field a card of this document shows: the GM's choice when the document's type
 * declares it, else the automatic one. A path the type does not declare — a choice made
 * for another type, or anything a stranger wrote into the flag — reads the automatic
 * field and nothing else.
 */
export function shownField(
  documentName: string,
  type: unknown,
  chosen: string | null | undefined,
  doc?: any
): string | null {
  const fields = fieldsFor(documentName, type, doc);
  if (chosen && fields.some((field) => field.path === chosen)) return chosen;
  return rankDefault(fields);
}
