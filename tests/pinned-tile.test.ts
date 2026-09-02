/**
 * @vitest-environment jsdom
 *
 * The Tile subclass, driven the way core drives it: control, a drag with its preview
 * clone, drop and cancel. `fakeTileClass` models what matters — a clone is a PinnedTile
 * carrying the original's id, it draws from the original's placeholder, core writes
 * `document.alpha` back onto the mesh on every state refresh, and the originals stay put
 * until the drop's update lands.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, fakeTileClass, installWorld, uninstallWorld } from "./helpers/fake-foundry";

/** Which tier this client draws a prop on; the manager's answer, mocked. */
const tier = { dom: true };

vi.mock("../src/canvas/PropManager", () => ({
  drawsAsDom: vi.fn(() => tier.dom),
  propManager: () => ({ setFocused: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../src/canvas/DomPropTier", () => ({
  followDomProp: vi.fn(),
  setDomPropControlled: vi.fn(),
}));
vi.mock("../src/apps/PinHUD", () => ({ showPinHUD: vi.fn(), hidePinHUD: vi.fn() }));
vi.mock("../src/apps/ReaderOverlay", () => ({ repositionReader: vi.fn() }));

import { definePinnedTile, onTileRefreshed } from "../src/canvas/PinnedTile";
import { followDomProp, setDomPropControlled } from "../src/canvas/DomPropTier";
import { repositionReader } from "../src/apps/ReaderOverlay";

function propDoc(id: string, mode: "prop" | "pin" = "prop") {
  const doc = fakeTile({
    id,
    uuid: `Scene.s1.Tile.${id}`,
    x: 300,
    y: 400,
    width: 400,
    height: 560,
  });
  doc.flags = {
    [MODULE_ID]: {
      pin: {
        ...defaultPin(),
        mode,
        source: {
          kind: "document",
          uuid: "JournalEntry.a",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
        },
        audience: { ...defaultPin().audience, kind: "everyone" },
      },
    },
  };
  return doc;
}

/** The chained class, built once: `definePinnedTile` latches on its first install. */
let Tile: any;
let world: ReturnType<typeof installWorld>;
let doc: any;

beforeAll(() => {
  installWorld({ isGM: true });
  (globalThis as any).CONFIG.Tile.objectClass = fakeTileClass();
  expect(definePinnedTile()).toBe(true);
  Tile = (globalThis as any).CONFIG.Tile.objectClass;
  uninstallWorld();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="board"></div>';
  tier.dom = true;
  vi.clearAllMocks();
  // The fake layer is shared by every instance of the class; each test starts it empty.
  Tile.layer.controlled = [];
  Tile.layer.preview.children = [];
  doc = propDoc("t1");
  world = installWorld({ isGM: true, tiles: [doc] });
});

afterEach(() => uninstallWorld());

function dragEvent(dx = 50, dy = 30) {
  return {
    interactionData: { origin: { x: 0, y: 0 }, destination: { x: dx, y: dy }, clones: [] as any[] },
  };
}

/** Press on a controlled original: core clones it and draws the clone asynchronously. */
async function startDrag(original: any) {
  const event = dragEvent();
  original._onDragLeftStart(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return event;
}

async function drawn() {
  const original = new Tile(doc);
  await original.draw();
  original.control();
  return original;
}

describe("the drag preview", () => {
  it("hides the placeholder on a DOM-path preview, and keeps it hidden through core's refreshes", async () => {
    const original = await drawn();
    const event = await startDrag(original);
    const [clone] = event.interactionData.clones;

    expect(clone.isPreview).toBe(true);
    expect(clone.id).toBe("t1");
    expect(clone.mesh.alpha).toBe(0);

    // Core writes `document.alpha` back on every state refresh; the zero holds.
    clone._refreshState();
    clone._refreshMesh();
    expect(clone.mesh.alpha).toBe(0);

    // The original's own mesh is the manager's business, not the clone's.
    expect(original.mesh.alpha).toBe(1);
  });

  it("hands a canvas-path preview the page bound to the original's mesh, and gives it back on destroy", async () => {
    tier.dom = false;
    const original = await drawn();
    const page = { id: "the-page" };
    original.mesh.texture = page; // what the manager bound
    const event = await startDrag(original);
    const [clone] = event.interactionData.clones;

    expect(clone.mesh.texture).toBe(page);
    expect(clone.mesh.alpha).toBe(1);

    original._onDragLeftDrop(event);
    expect(clone.destroyed).toBe(true);
    expect(clone.mesh.texture).toBe(original.texture);
  });

  it("leaves a canvas-path preview the book while the original has no page yet", async () => {
    tier.dom = false;
    const original = await drawn();
    const event = await startDrag(original);
    const [clone] = event.interactionData.clones;
    expect(clone.mesh.texture).toBe(original.texture);
  });

  it("never reports a preview's draw or destroy as the original's", async () => {
    const original = await drawn();
    const event = await startDrag(original);
    original._onDragLeftDrop(event);

    const drawnHooks = world.hooks.filter((h) => h.name === `${MODULE_ID}.tileDrawn`);
    expect(drawnHooks).toHaveLength(1);
    expect(drawnHooks[0].args[0]).toBe(original);
    expect(world.hooks.filter((h) => h.name === `${MODULE_ID}.tileDestroyed`)).toHaveLength(0);
  });

  it("moves the card with every clone on a drag move, under the original's id", async () => {
    const original = await drawn();
    const event = await startDrag(original);
    vi.mocked(followDomProp).mockClear();

    original._onDragLeftMove(event);
    const [clone] = event.interactionData.clones;
    expect(clone.document.x).toBe(350);
    expect(clone.document.y).toBe(430);
    expect(followDomProp).toHaveBeenCalledWith(clone.document, "t1");
    // The original's document did not move; it is not what the card follows.
    expect(doc.x).toBe(300);
  });

  it("puts the card back on the original when the drag is cancelled", async () => {
    const original = await drawn();
    const event = await startDrag(original);
    original._onDragLeftMove(event);
    vi.mocked(followDomProp).mockClear();

    original._onDragLeftCancel(event);
    expect(followDomProp).toHaveBeenCalledWith(doc);
    expect(original.hasPreview).toBe(false);
  });

  it("holds the card still between the drop and the update that commits it", async () => {
    const original = await drawn();
    const event = await startDrag(original);
    original._onDragLeftMove(event);
    original._onDragLeftDrop(event);
    vi.mocked(followDomProp).mockClear();

    // A refresh of the original in the window: its document is still where the drag
    // started, and following it would pull the card back under the pointer.
    onTileRefreshed(original);
    expect(followDomProp).not.toHaveBeenCalled();

    original._onUpdate({ x: 350, y: 430 }, {}, "gm");
    onTileRefreshed(original);
    expect(followDomProp).toHaveBeenCalledWith(doc);
  });
});

describe("control", () => {
  it("marks the card controlled on control and clears it on release", async () => {
    const original = new Tile(doc);
    await original.draw();

    original.control();
    expect(setDomPropControlled).toHaveBeenLastCalledWith("t1", true);
    original.release();
    expect(setDomPropControlled).toHaveBeenLastCalledWith("t1", false);
  });

  it("leaves an ordinary tile alone", async () => {
    const plain = fakeTile({ id: "plain" });
    const tile = new Tile(plain);
    await tile.draw();
    tile.control();
    expect(setDomPropControlled).not.toHaveBeenCalled();
    expect(world.hooks.filter((h) => h.name === `${MODULE_ID}.tileDrawn`)).toHaveLength(0);
  });
});

describe("onTileRefreshed", () => {
  it("follows a preview under the original's id", async () => {
    const original = new Tile(doc);
    const clone = original.clone();
    clone.document.x = 900;

    onTileRefreshed(clone);
    expect(followDomProp).toHaveBeenCalledWith(clone.document, "t1");
  });

  it("stays silent for an original that has a preview", async () => {
    const original = new Tile(doc);
    original.clone();

    onTileRefreshed(original);
    expect(followDomProp).not.toHaveBeenCalled();
    expect(repositionReader).not.toHaveBeenCalled();
  });

  it("follows a lone prop and repositions the reader, as a handle drag needs", async () => {
    const original = new Tile(doc);

    onTileRefreshed(original);
    expect(followDomProp).toHaveBeenCalledWith(doc);
    expect(repositionReader).toHaveBeenCalledTimes(1);
  });

  it("ignores a pin-mode anchor and an ordinary tile", async () => {
    onTileRefreshed(new Tile(propDoc("p", "pin")));
    onTileRefreshed(new Tile(fakeTile({ id: "plain" })));
    expect(followDomProp).not.toHaveBeenCalled();
  });
});
