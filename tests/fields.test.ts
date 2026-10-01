/**
 * @vitest-environment jsdom
 *
 * Which text of an Actor or an Item a card shows.
 *
 * Systems differ — dnd5e keeps a public and a private biography, pf2e an item's GM-only
 * description beside the players' — so the module reads the system's own data model for
 * its HTML fields and lets the GM choose one in the Studio. The choice is a path stored in
 * the pin, and a path is data: it is checked for its shape when the pin is read, and for
 * membership in what the data model declares when the card is drawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin, validatePin } from "../src/data/pin-schema";
import {
  DATA_FIELDS,
  dataModel,
  installSources,
  installWorld,
  uninstallWorld,
} from "./helpers/fake-foundry";

const { ArrayField, EmbeddedDataField, HTMLField, SchemaField, StringField, TypedSchemaField } =
  DATA_FIELDS;

const keys = (notices: { key: string }[]) => notices.map((n) => n.key);

describe("source.field in a stored pin", () => {
  it.each([
    ["a path under system", "details.biography.public", "details.biography.public", []],
    ["the automatic choice", null, null, []],
    ["an emptied select", "", null, []],
    ["a walk into the prototype", "__proto__.polluted", null, ["DP.pin.warn.badField"]],
    ["a constructor segment", "details.constructor.name", null, ["DP.pin.warn.badField"]],
    ["nine segments", "a.b.c.d.e.f.g.h.i", null, ["DP.pin.warn.badField"]],
  ])("normalises %s, at schema 5", (_what, field, stored, warned) => {
    const { pin, warnings } = validatePin({
      ...defaultPin(),
      source: { ...defaultPin().source, uuid: "Actor.bandit", field },
    });
    expect(pin.source.field).toBe(stored);
    expect(keys(warnings)).toEqual(warned);
    expect(pin.v).toBe(5);
  });
});

describe("the HTML fields of a document type", () => {
  beforeEach(() => {
    vi.resetModules();
    installSources(installWorld({ isGM: true }));
  });
  afterEach(() => uninstallWorld());

  /** Nine schemas deep: one level more than a stored path may have. */
  const tooDeep = (depth: number): any =>
    depth ? new SchemaField({ inner: tooDeep(depth - 1) }) : new HTMLField();

  it.each([
    [
      "through nested schemas, labelled by the path where the model gives no label",
      {
        name: new StringField(),
        details: new SchemaField({
          biography: new SchemaField({ value: new HTMLField(), public: new HTMLField() }),
        }),
      },
      [
        ["details.biography.value", "Details › Biography › Value"],
        ["details.biography.public", "Details › Biography › Public"],
      ],
    ],
    [
      "through an embedded data model, labelled by the model",
      {
        description: new EmbeddedDataField(
          dataModel({
            value: new HTMLField({ label: "PF2E.Description" }),
            gm: new HTMLField({ label: "PF2E.GMDescription" }),
          })
        ),
      },
      [
        ["description.value", "PF2E.Description"],
        ["description.gm", "PF2E.GMDescription"],
      ],
    ],
    [
      "skipping arrays, typed schemas and anything deeper than a path may go",
      {
        entries: new ArrayField(new HTMLField()),
        effects: new TypedSchemaField({ note: new HTMLField() }),
        lore: tooDeep(9),
        publicNotes: new HTMLField(),
      },
      [["publicNotes", "Public Notes"]],
    ],
  ])("are found %s, walking each type once", async (_how, fields, expected) => {
    const config = (globalThis as any).CONFIG;
    let reads = 0;
    const model = dataModel(fields);
    Object.defineProperty(config.Actor.dataModels, "npc", {
      get: () => (reads++, model),
      configurable: true,
    });
    const { fieldsFor } = await import("../src/sources/fields");

    const found = fieldsFor("Actor", "npc").map((field) => [field.path, field.label]);
    fieldsFor("Actor", "npc");

    expect(found).toEqual(expected);
    expect(reads).toBe(1);
  });
});
