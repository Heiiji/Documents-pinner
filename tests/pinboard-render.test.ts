/**
 * @vitest-environment jsdom
 *
 * The Pinboard renders once for a change, and reads the pins once for a render (A29).
 *
 * A verb re-rendered the board after its write, and the tile hook that write fires on every
 * client re-rendered it again (`refreshPinboard`) — a scene write of many pins, or a source
 * edit, once per hook more. Core queues renders and does not merge them, and every render
 * fires every module's render hooks. And each render called `rowsFor` — every pin, its
 * source and each player's access — twice, and every arrow key a third time.
 *
 * The frames here are the board's window's own `requestAnimationFrame`, held and run by
 * hand, so "in one frame" means exactly that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { contentOf, fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));
// The real rows, counted.
vi.mock("../src/apps/pinboard-markup", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/apps/pinboard-markup")>();
  return { ...real, rowsFor: vi.fn(real.rowsFor) };
});

function pinned(id: string, sort: number, kind = "everyone") {
  const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, sort, hidden: kind === "hidden" });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        display: { ...defaultPin().display, label: `Pin ${id}` },
        audience: { ...defaultPin().audience, kind },
      },
    },
  };
  return tile;
}

/** The frames asked of a window, run only when the test says the window paints. */
function holdFrames(view: Window) {
  const asked: FrameRequestCallback[] = [];
  const spy = vi.spyOn(view, "requestAnimationFrame").mockImplementation((callback) => {
    asked.push(callback);
    return asked.length;
  });
  return {
    spy,
    get waiting() {
      return asked.length;
    },
    /** A window gone — a closed popup: the frames it was asked for never run. */
    drop() {
      asked.splice(0);
    },
    /** Paint: run every callback asked for so far, then let the renders they began land. */
    async paint() {
      for (const callback of asked.splice(0)) callback(performance.now());
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
  };
}

let tiles: any[];
let board: any;
let mod: typeof import("../src/apps/Pinboard");
let rowsFor: ReturnType<typeof vi.fn>;
let settled: () => Promise<void>;
let frames: ReturnType<typeof holdFrames>;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "";
  tiles = [pinned("t1", 0, "hidden"), pinned("t2", 10), pinned("t3", 20)];
  installWorld({ isGM: true, tiles });
  frames = holdFrames(window);

  mod = await import("../src/apps/Pinboard");
  rowsFor = (await import("../src/apps/pinboard-markup")).rowsFor as any;
  ({ settled } = await import("../src/data/PinStore"));
  board = mod.openPinboard();
  document.body.appendChild(contentOf(board));
  await board.render();
  // The first render's deferred focus (`focusRow`) is a frame too.
  await frames.paint();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallWorld();
});

const row = (id: string) =>
  contentOf(board).querySelector<HTMLElement>(`.dp-row[data-dp-id="${id}"]`)!;
const press = (key: string, target: HTMLElement = row(board.focusedId)) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("a change the board made, and the hooks it fired", () => {
  it("is one render: two hook refreshes and a verb's own, in one frame", async () => {
    const before = board.renderCount;
    // Space on t1, which is hidden: the eye reveals it and asks for its render.
    press(" ", row("t1"));
    await settled();
    // The write's `updateTile` on this client, and a second hook in the same batch.
    mod.refreshPinboard();
    mod.refreshPinboard();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(tiles[0].hidden).toBe(false);
    expect(board.renderCount).toBe(before);
    expect(frames.waiting).toBe(1);

    await frames.paint();
    expect(board.renderCount).toBe(before + 1);
    // And it drew the pins as the write left them.
    expect(row("t1").dataset.dpVisible).toBe("true");

    await frames.paint();
    expect(board.renderCount).toBe(before + 1);
  });

  it("carries what a verb set before it asked: Reveal next's status and the focus", async () => {
    tiles[2].hidden = true;
    tiles[2].flags["documents-pinner"].pin.audience.kind = "hidden";
    board.runRevealNext();
    await settled();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    mod.refreshPinboard();

    await frames.paint();
    expect(tiles[0].hidden).toBe(false);
    expect(contentOf(board).querySelector(".dp-board__status")?.textContent).toContain(
      "DP.board.statusRevealed"
    );
    // The next hidden row in the order, chosen from the pins as the reveal left them.
    expect(board.focusedId).toBe("t3");
    expect(row("t3").tabIndex).toBe(0);
  });

  it("leaves the frame nothing to do when a render began before it", async () => {
    const before = board.renderCount;
    mod.refreshPinboard();
    // An arrow key renders at once, and reads everything the request was for.
    press("ArrowDown");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(board.renderCount).toBe(before + 1);

    await frames.paint();
    expect(board.renderCount).toBe(before + 1);
  });

  it("asks nothing of a closed board", async () => {
    await board.close();
    mod.refreshPinboard();
    expect(frames.waiting).toBe(0);
  });
});

describe("the board's own window", () => {
  it("waits on a detached board's frame, not the main window's", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const other = frame.contentDocument!;
    other.body.appendChild(board.content);
    board.element = board.content;
    const popup = holdFrames(other.defaultView!);
    frames.spy.mockClear();

    const before = board.renderCount;
    mod.refreshPinboard();
    expect(popup.waiting).toBe(1);
    expect(frames.spy).not.toHaveBeenCalled();

    await popup.paint();
    expect(board.renderCount).toBe(before + 1);
  });

  it("renders on its floor when its window paints no frame, and only once", async () => {
    const before = board.renderCount;
    mod.refreshPinboard();
    expect(frames.waiting).toBe(1);
    // A minimised popup, a hidden tab: the frame never comes.
    await new Promise((resolve) => setTimeout(resolve, mod.RENDER_FLOOR_MS + 30));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(board.renderCount).toBe(before + 1);

    // The frame arriving late finds nothing left to do.
    await frames.paint();
    expect(board.renderCount).toBe(before + 1);
  });

  it("is not stuck behind a request its window took with it", async () => {
    // Asked, then the board closes before any frame: a re-attach closes the popup the
    // frame was asked of, synchronously.
    mod.refreshPinboard();
    expect(frames.waiting).toBe(1);
    await board.close();
    frames.drop();

    const again = mod.openPinboard();
    await again.render();
    await frames.paint();
    const before = again.renderCount;
    mod.refreshPinboard();
    expect(frames.waiting).toBe(1);
    await frames.paint();
    expect(again.renderCount).toBe(before + 1);
  });

  it("renders on a microtask where there is no frame to wait for", async () => {
    // A document with no window at all: nothing would ever paint it.
    const bare = document.implementation.createHTMLDocument("bare");
    bare.body.appendChild(board.content);
    board.element = board.content;

    const before = board.renderCount;
    await board.requestRender();
    expect(board.renderCount).toBe(before + 1);
    expect(frames.waiting).toBe(0);
  });
});

describe("the rows of one render", () => {
  it("are read once per render", async () => {
    const before = rowsFor.mock.calls.length;
    await board.render();
    expect(rowsFor.mock.calls.length).toBe(before + 1);
  });

  it("are the ones the keyboard moves through until the next render reads them again", async () => {
    const before = rowsFor.mock.calls.length;
    // The arrow moves through the drawn rows, then renders: one read, the render's.
    press("ArrowDown");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(board.focusedId).toBe("t2");
    expect(rowsFor.mock.calls.length).toBe(before + 1);
  });
});
