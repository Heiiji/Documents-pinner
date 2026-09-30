import { describe, expect, it } from "vitest";
import { concernsPins } from "../src/data/PinData";
import { defaultPin } from "../src/data/pin-schema";

const pinned = { flags: { "documents-pinner": { pin: defaultPin() } } };
const plain = { flags: { core: {} } };

/**
 * Every tile change used to cost a full LOD pass, a hit-layer rebuild and a re-render of
 * every open window, whoever's tile it was. Only a pin — or a tile that just stopped being
 * one — is this module's business.
 */
describe("concernsPins", () => {
  it("claims a pin, whatever changed on it", () => {
    expect(concernsPins(pinned, { x: 10 })).toBe(true);
    expect(concernsPins(pinned)).toBe(true);
  });

  it("ignores another tile's change", () => {
    expect(concernsPins(plain, { x: 10 })).toBe(false);
    expect(concernsPins(plain, { flags: { "other-module": { a: 1 } } })).toBe(false);
  });

  it("claims the unpin, which leaves no flag on the document to read", () => {
    expect(concernsPins(plain, { flags: { "documents-pinner": { "-=pin": null } } })).toBe(true);
    expect(concernsPins(plain, { flags: { "-=documents-pinner": null } })).toBe(true);
  });

  it("treats a create or delete's options object as no diff at all", () => {
    expect(concernsPins(plain, { render: true, modifiedTime: 1 })).toBe(false);
    expect(concernsPins(plain, null)).toBe(false);
  });
});
