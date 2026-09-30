/**
 * @vitest-environment jsdom
 *
 * Acceptance criterion 17, verbatim: "with ownership sync off, a player without
 * permission still opens the viewer". DESIGN §3.1 says the same thing — ownership sync
 * is a convenience, not a security necessity, and with it off the module opens its own
 * read-only viewer instead.
 *
 * The reader refused on `!card.readable`, so the prop was visible, the cursor said
 * clickable, and the click did nothing: no reader, no sheet, no notification. And the
 * card had ALREADY been built and secret-stripped for that user at the point of refusal,
 * so the module was withholding content it was holding in its hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const card = {
  html:
    '<div class="dp-card"><div class="dp-card__sheet">' +
    '<h1 class="dp-card__title">The Duke\'s Letter</h1>' +
    '<div class="dp-card__body"><p>The Duke is dead.</p></div></div></div>',
  title: "The Duke's Letter",
  readable: false,
  contentHash: "h",
  missing: false,
  naturalHeight: null,
};

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => card),
}));

vi.mock("../src/canvas/PropManager", () => ({
  propManager: () => ({ setFocused: vi.fn() }),
}));

let tile: any;
let world: ReturnType<typeof installWorld>;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';

  tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
  tile.flags = {
    "documents-pinner": {
      pin: {
        ...defaultPin(),
        mode: "prop",
        audience: {
          ...defaultPin().audience,
          kind: "everyone",
          ownershipSync: { enabled: false, level: 2 },
        },
      },
    },
  };
  // A player, not the GM: the GM escape hatch is not what criterion 17 is about.
  world = installWorld({ isGM: false, tiles: [tile] });
  card.readable = false;
  card.missing = false;
});

afterEach(() => uninstallWorld());

/** The OPEN reader: one on its way out is still in the document while it fades. */
const reader = () => document.querySelector<HTMLElement>(".dp-reader:not(.dp-reader--out)");

describe("the focus reader", () => {
  it("opens for a player who can see the prop but lacks OBSERVER on the source", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    expect(reader()).not.toBeNull();
    expect(reader()!.innerHTML).toContain("The Duke is dead.");
  });

  it("still opens when the user CAN read it — the permitted path is unchanged", async () => {
    card.readable = true;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    expect(reader()).not.toBeNull();
  });

  it("refuses only a genuinely missing source, and says so", async () => {
    card.missing = true;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    expect(reader()).toBeNull();
    expect(world.notifications.map((n) => n.type)).toContain("warn");
  });

  it("says there is more below while the body can still scroll, and stops at the end", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    const body = reader()!.querySelector<HTMLElement>(".dp-card__body")!;

    // jsdom lays nothing out, so the scroll geometry is stated.
    let scrollTop = 0;
    Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(body, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => (scrollTop = v),
      configurable: true,
    });

    body.dispatchEvent(new Event("scroll"));
    expect(reader()!.dataset.dpMore).toBe("true");

    body.scrollTop = 600;
    body.dispatchEvent(new Event("scroll"));
    expect(reader()!.dataset.dpMore).toBe("false");
  });

  it("leaves with its exit class, and is gone once the exit has run", async () => {
    const { openReader, closeReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    closeReader();

    // The state is reset at once; the node dissolves.
    expect(reader()).toBeNull();
    expect(document.querySelector(".dp-reader--out")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector(".dp-reader")).toBeNull();
  });

  it("opens a pin-mode anchor at a readable sheet centred on it, not one grid square", async () => {
    tile.flags["documents-pinner"].pin.mode = "pin";
    tile.width = 100;
    tile.height = 100;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // Centred on the pin's own point, which is the tile's centre.
    expect(reader()!.style.width).toBe("400px");
    expect(reader()!.style.height).toBe("566px");
    expect(reader()!.style.left).toBe("-200px");
    expect(reader()!.style.top).toBe("-283px");
  });

  it("brings the view in first when the type is too small to read, and not otherwise", async () => {
    const pans: any[] = [];
    world.canvas.animatePan = async (target: any) => {
      pans.push(target);
    };
    // A natural-size prop derives ~15.4px type; zoomed well out it reads as 4.6px.
    tile.width = 400;
    tile.height = 560;
    world.canvas.stage.worldTransform.a = 0.3;
    world.canvas.stage.worldTransform.d = 0.3;
    const { openReader, closeReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    expect(pans).toHaveLength(1);
    expect(pans[0].scale).toBeGreaterThan(0.3);
    expect(pans[0].scale).toBeLessThanOrEqual(3);
    expect(reader()).not.toBeNull();

    closeReader();
    world.canvas.stage.worldTransform.a = 1;
    world.canvas.stage.worldTransform.d = 1;
    await openReader(tile);
    expect(pans).toHaveLength(1);
  });

  /** A press and its release, `moved` pixels apart. */
  function click(x: number, y: number, moved = 0, button = 0) {
    const board = document.getElementById("board")!;
    board.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button })
    );
    window.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: x + moved, clientY: y, button })
    );
  }

  it("ignores a press on the prop being read, so the hit layer's tap can toggle it", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    // Inside the 200x280 prop centred on the origin, which spans -100..100 by -140..140.
    click(50, 50);
    expect(reader()).not.toBeNull();

    // Just beside it — inside the old reading of the point as a corner, and not the prop.
    click(150, 150);
    expect(reader()).toBeNull();
  });

  it("stays open through a drag that starts beside it — a pan, a token, a ruler", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    // A right-drag pan used to close it on the press, before the view had moved at all.
    click(300, 300, 80, 2);
    expect(reader()).not.toBeNull();
    click(300, 300, 80, 0);
    expect(reader()).not.toBeNull();

    // A click that stays put is a click, whichever button made it.
    click(300, 300, 2, 2);
    expect(reader()).toBeNull();
  });

  it("opens upright over a prop lying at an angle, turning from the angle it lies at", async () => {
    tile.rotation = 30;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(reader()!.style.transform).toBe("rotate(0deg)");
    expect(reader()!.style.getPropertyValue("--dp-reader-turn")).toBe("30deg");
    // The same box, centred on the same point.
    expect(reader()!.style.width).toBe(`${tile.width}px`);
  });

  it("still treats a press on the tilted paper outside the upright reader as on the prop", async () => {
    // A long, thin letter turned on its side: its corners reach well outside the reader.
    tile.width = 400;
    tile.height = 40;
    tile.rotation = 90;
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    // On the paper as it lies (x ≈ 0, y ≈ 150), outside the upright 400x40 reader.
    click(0, 150);
    expect(reader()).not.toBeNull();
  });

  it("closes when the pin is hidden from the player reading it, and stays when it is not", async () => {
    const { openReader, revalidateReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);

    revalidateReader();
    expect(reader()).not.toBeNull();

    // The GM hides it, or takes this player out of its audience.
    tile.object.isVisible = false;
    revalidateReader();
    expect(reader()).toBeNull();
  });

  it("closes on a second click, which is what a click on what you are reading means", async () => {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    await openReader(tile);

    expect(reader()).toBeNull();
  });
});

/**
 * A long document has to scroll wherever the pointer is. Only the body scrolls, and the
 * title, the pad and the close button sit outside it: a wheel over any of those found no
 * scrollable ancestor, and core ignores a wheel that is not over `#board`, so it did
 * nothing — "sometimes it scrolls", depending on where the pointer happened to rest.
 */
describe("scrolling the reader", () => {
  /** jsdom lays nothing out, so the body's scroll geometry is stated. */
  function scrollable(body: HTMLElement) {
    let scrollTop = 0;
    Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(body, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => (scrollTop = v),
      configurable: true,
    });
    body.style.lineHeight = "18px";
    return body;
  }

  async function open() {
    const { openReader } = await import("../src/apps/ReaderOverlay");
    await openReader(tile);
    return scrollable(reader()!.querySelector<HTMLElement>(".dp-card__body")!);
  }

  const wheel = (target: Element, init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  const key = (target: Element, name: string) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it("scrolls the text from a wheel over the title, which has nothing of its own to scroll", async () => {
    const body = await open();
    const event = wheel(reader()!.querySelector(".dp-card__title")!, { deltaY: 120 });

    expect(body.scrollTop).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it("scrolls from the pad around the text and from the close button too", async () => {
    const body = await open();
    wheel(reader()!.querySelector(".dp-card__sheet")!, { deltaY: 50 });
    wheel(reader()!.querySelector(".dp-reader__close")!, { deltaY: 50 });

    expect(body.scrollTop).toBe(100);
  });

  it("leaves a wheel over the text itself to the browser, which scrolls it natively", async () => {
    const body = await open();
    const event = wheel(body.querySelector("p")!, { deltaY: 120 });

    expect(event.defaultPrevented).toBe(false);
    expect(body.scrollTop).toBe(0);
  });

  it("leaves a ctrl-wheel alone, because that is a zoom", async () => {
    const body = await open();
    wheel(reader()!.querySelector(".dp-card__title")!, { deltaY: 120, ctrlKey: true });

    expect(body.scrollTop).toBe(0);
  });

  it("reads a wheel that reports lines as lines", async () => {
    const body = await open();
    wheel(reader()!.querySelector(".dp-card__title")!, { deltaY: 3, deltaMode: 1 });

    expect(body.scrollTop).toBe(54);
  });

  it("pages with the keyboard while the reader has focus, ahead of core's panning", async () => {
    const body = await open();
    expect(reader()!.contains(document.activeElement)).toBe(true);
    const core = vi.fn();
    window.addEventListener("keydown", core);

    const event = key(document.activeElement!, "PageDown");
    expect(body.scrollTop).toBe(382);
    expect(event.defaultPrevented).toBe(true);
    expect(core).not.toHaveBeenCalled();

    key(document.activeElement!, "End");
    expect(body.scrollTop).toBe(600);
    key(document.activeElement!, "Home");
    expect(body.scrollTop).toBe(0);
    key(document.activeElement!, "ArrowDown");
    expect(body.scrollTop).toBe(36);

    window.removeEventListener("keydown", core);
  });

  it("leaves the keys alone once focus is somewhere else", async () => {
    const body = await open();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const event = key(input, "ArrowDown");
    expect(body.scrollTop).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the reader's scroll arithmetic", () => {
  it("turns a line or a page into pixels, and leaves pixels as they are", async () => {
    const { wheelPixels } = await import("../src/apps/ReaderOverlay");
    expect(wheelPixels({ deltaY: 100, deltaMode: 0 }, 20, 400)).toBe(100);
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 20, 400)).toBe(60);
    expect(wheelPixels({ deltaY: -1, deltaMode: 2 }, 20, 400)).toBe(-400);
  });

  it("stays inside the text at both ends, and ignores a key that does not read", async () => {
    const { readerScrollTop } = await import("../src/apps/ReaderOverlay");
    const body = { scrollTop: 590, clientHeight: 400, scrollHeight: 1000 };
    expect(readerScrollTop("PageDown", body, 20)).toBe(600);
    expect(readerScrollTop("ArrowUp", { ...body, scrollTop: 10 }, 20)).toBe(0);
    expect(readerScrollTop("End", { ...body, scrollHeight: 300 }, 20)).toBe(0);
    expect(readerScrollTop("a", body, 20)).toBeNull();
    expect(readerScrollTop("toString", body, 20)).toBeNull();
  });
});
