/**
 * @vitest-environment jsdom
 *
 * The Pinboard's bulk and global visibility buttons — the module's stated differentiator,
 * the "as the ritual completes, all three glyphs light up" gesture the README and the
 * CHANGELOG both name as this window's reason to exist.
 *
 * ApplicationV2 invokes an action as `handler.call(app, event, target)`, so four of the
 * ten handlers were reading the PointerEvent as if it were the application. Two threw;
 * two failed SILENTLY, because `store.all(event)` reads `event.tiles`, finds nothing and
 * returns an empty list. Every other handler in the file gets the signature right, which
 * is why nothing looked wrong on review.
 *
 * These tests therefore go through the real dispatch path rather than calling the
 * handlers directly: the signature IS the defect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

function pinnedTile(id: string, kind: string, users: string[] = []) {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}` });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        audience: { ...defaultPin().audience, kind, users },
      },
    },
  };
  return tile;
}

/** The audience kind actually written for each anchor, read out of the scene write. */
function writtenKinds(scene: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const call of scene.updates ?? []) {
    for (const update of call) {
      out[update._id] = update["flags.documents-pinner.pin"].audience.kind;
    }
  }
  return out;
}

let tiles: any[];
let board: any;

beforeEach(async () => {
  vi.resetModules();
  tiles = [pinnedTile("t1", "hidden"), pinnedTile("t2", "hidden"), pinnedTile("t3", "everyone")];
  const world = installWorld({ isGM: true, tiles });

  world.canvas.scene.updates = [];
  world.canvas.scene.updateEmbeddedDocuments = async (_type: string, updates: any[]) => {
    world.canvas.scene.updates.push(updates);
    return updates;
  };

  const { definePinboard } = await import("../src/apps/Pinboard");
  const Board = definePinboard();
  board = new Board();
  board.query = { filter: "all", search: "", level: null };
  board.selected = [];
  board.focusedId = null;
  board.render = vi.fn();
});

afterEach(() => uninstallWorld());

describe("Pinboard bulk actions", () => {
  it("reveals exactly the selected pins", async () => {
    board.selected = ["t1", "t2"];
    await board.dispatch("bulkReveal");

    expect(writtenKinds(board.scene)).toEqual({ t1: "everyone", t2: "everyone" });
  });

  it("hides exactly the selected pins", async () => {
    board.selected = ["t3"];
    await board.dispatch("bulkHide");

    expect(writtenKinds(board.scene)).toEqual({ t3: "hidden" });
  });

  it("does nothing at all when nothing is selected, rather than throwing", async () => {
    board.selected = [];
    await expect(board.dispatch("bulkReveal")).resolves.not.toThrow();
    expect(board.scene.updates).toHaveLength(0);
  });
});

describe("Pinboard global actions", () => {
  it("reveals every pin on the scene — silently a no-op before", async () => {
    await board.dispatch("revealAll");

    const written = writtenKinds(board.scene);
    expect(Object.keys(written).sort()).toEqual(["t1", "t2", "t3"]);
    expect(new Set(Object.values(written))).toEqual(new Set(["everyone"]));
  });

  it("hides every pin on the scene", async () => {
    await board.dispatch("hideAll");

    const written = writtenKinds(board.scene);
    expect(Object.keys(written).sort()).toEqual(["t1", "t2", "t3"]);
    expect(new Set(Object.values(written))).toEqual(new Set(["hidden"]));
  });

  it("lands as ONE scene write, so every client sees one change", async () => {
    await board.dispatch("revealAll");
    expect(board.scene.updates).toHaveLength(1);
  });
});

describe("Pinboard bulk hide and the remembered audience", () => {
  it("does not overwrite the remembered audience of an already-hidden pin", async () => {
    // A pin narrowed to Ali, then hidden by hand, then caught by "Hide all". Writing
    // `restore` unconditionally stored `{kind: "hidden"}`, which normalises back to
    // "everyone" — so the next reveal showed a private note to the whole table.
    const tile = pinnedTile("t4", "hidden", []);
    tile.flags["documents-pinner"].pin.audience.restore = { kind: "selected", users: ["ali"] };
    tiles.push(tile);

    board.selected = ["t4"];
    await board.dispatch("bulkHide");

    const written = board.scene.updates[0][0]["flags.documents-pinner.pin"].audience;
    expect(written.restore).toEqual({ kind: "selected", users: ["ali"] });
  });
});
