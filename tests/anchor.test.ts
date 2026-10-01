/**
 * A pin's texture anchor stays at its centre.
 *
 * Every placement in the module comes from `tileRect`, which takes the document's point as
 * the tile's centre (DESIGN A20). Core draws a tile's bounds from `texture.anchorX` and
 * `anchorY`, which default to 0.5 and which TileConfig lets a GM edit — so a pin whose
 * anchor moved had core's frame, grip and canvas page about one point and its card, hit
 * area and reader about another. The two pre-hooks fold such a change back in the same
 * write.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { onPreCreateTile, onPreUpdateTile } from "../src/data/core-hidden";
import { defaultPin } from "../src/data/pin-schema";
import { internal } from "../src/fvtt";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

function pinTile(texture: Record<string, unknown> = {}) {
  const tile = fakeTile({
    id: "t1",
    uuid: "Scene.s1.Tile.t1",
    texture: { src: "icons/svg/book.svg", anchorX: 0.5, anchorY: 0.5, ...texture },
  });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        source: { ...defaultPin().source, uuid: "JournalEntry.letter" },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return tile;
}

/** What `doc.updateSource` was asked to write, in order. */
function recordSource(doc: any): Record<string, unknown>[] {
  const written: Record<string, unknown>[] = [];
  doc.updateSource = (patch: Record<string, unknown>) => written.push(patch);
  return written;
}

beforeEach(() => installWorld({ isGM: true }));
afterEach(() => uninstallWorld());

describe("a pin's anchor, through an update", () => {
  it("is folded back to the centre when TileConfig moves it", () => {
    const changed: any = { texture: { anchorX: 0, anchorY: 1 } };
    onPreUpdateTile(pinTile(), changed, {});
    expect(changed.texture).toEqual({ anchorX: 0.5, anchorY: 0.5 });
  });

  it("is held even when the same save changes nothing about `hidden`", () => {
    // TileConfig submits every field; `hidden` arrives unchanged, which the fold below
    // returns on — the anchor has to be decided before that.
    const changed: any = { hidden: false, texture: { anchorX: 0.25 } };
    onPreUpdateTile(pinTile(), changed, {});
    expect(changed.texture.anchorX).toBe(0.5);
    expect("anchorY" in changed.texture).toBe(false);
  });

  it("leaves the rest of the texture change alone", () => {
    const changed: any = { texture: { src: "icons/svg/door.svg", tint: "#ff0000", anchorY: 0 } };
    onPreUpdateTile(pinTile(), changed, {});
    expect(changed.texture).toEqual({ src: "icons/svg/door.svg", tint: "#ff0000", anchorY: 0.5 });
  });

  it("is still folded with a hide in the same save", () => {
    const changed: any = { hidden: true, texture: { anchorX: 1 } };
    onPreUpdateTile(pinTile(), changed, {});
    expect(changed.texture.anchorX).toBe(0.5);
    expect(changed.flags[MODULE_ID][FLAGS.PIN].audience.kind).toBe("hidden");
  });

  it("does not touch an ordinary tile, or a write the module made itself", () => {
    const plain = fakeTile({ id: "plain" });
    const changed: any = { texture: { anchorX: 0 } };
    onPreUpdateTile(plain, changed, {});
    expect(changed.texture.anchorX).toBe(0);

    const ours: any = { texture: { anchorX: 0 } };
    onPreUpdateTile(pinTile(), ours, internal());
    expect(ours.texture.anchorX).toBe(0);
  });
});

describe("a pin's anchor, on a creation core makes", () => {
  it("is centred on a pin pasted from one whose anchor was moved", () => {
    const doc = pinTile({ anchorX: 0, anchorY: 0.75 });
    const written = recordSource(doc);
    onPreCreateTile(doc, {}, {});
    expect(written).toEqual([{ "texture.anchorX": 0.5, "texture.anchorY": 0.5 }]);
  });

  it("writes nothing for a pin already centred, or an ordinary tile", () => {
    const centred = pinTile();
    const plain = fakeTile({ id: "plain", texture: { src: "x.webp", anchorX: 0 } });
    const a = recordSource(centred);
    const b = recordSource(plain);
    onPreCreateTile(centred, {}, {});
    onPreCreateTile(plain, {}, {});
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it("is centred and hidden in its audience on a hidden paste", () => {
    const doc = pinTile({ anchorX: 1 });
    doc.hidden = true;
    const written = recordSource(doc);
    onPreCreateTile(doc, {}, {});
    expect(written[0]).toEqual({ "texture.anchorX": 0.5 });
    expect(written[1][`flags.${MODULE_ID}.${FLAGS.PIN}.audience`]).toMatchObject({
      kind: "hidden",
    });
  });
});
