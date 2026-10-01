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
import { describe, expect, it } from "vitest";
import { defaultPin, validatePin } from "../src/data/pin-schema";

const keys = (notices: { key: string }[]) => notices.map((n) => n.key);

describe("source.field in a stored pin", () => {
  it.each([
    ["a path under system", "details.biography.public", "details.biography.public", []],
    ["the automatic choice", null, null, []],
    ["an emptied select", "", null, []],
    ["a walk into the prototype", "__proto__.polluted", null, ["DP.pin.warn.badField"]],
    ["a constructor segment", "details.constructor.name", null, ["DP.pin.warn.badField"]],
    ["markup", '<img src=x onerror="alert(1)">', null, ["DP.pin.warn.badField"]],
    ["nine segments", "a.b.c.d.e.f.g.h.i", null, ["DP.pin.warn.badField"]],
    ["a number", 42, null, ["DP.pin.warn.badField"]],
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
