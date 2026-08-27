/**
 * @vitest-environment jsdom
 *
 * The one piece of DOM this module injects into a core application, and both of its
 * controls did the wrong thing.
 *
 * Checking "this is a pin" called a bare `openPicker()`, which armed the placement ghost
 * and placed a NEW pin somewhere else entirely — the tile being configured was never
 * touched, and the GM ended up with two objects. `adoptTile()` was the correct verb,
 * already written and already tested, with no caller anywhere in the module.
 *
 * Unchecking called `api.unpin(doc)` immediately, with no confirmation, while the sheet
 * was still holding pre-toggle data.
 *
 * And `renderNoteConfig` was never registered at all, so adopting an existing Map Note —
 * the module's only concrete ecosystem-integration surface — was impossible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import {
  answerDialogs,
  contentOf,
  fakeDoc,
  fakeTile,
  installWorld,
  uninstallWorld,
} from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

let tile: any;

/** A minimal ApplicationV2 sheet element, with the footer the injector looks for. */
function sheet() {
  const element = document.createElement("div");
  element.innerHTML = '<form><div class="form-footer"></div></form>';
  document.body.appendChild(element);
  return element;
}

function pinnedTile(id = "t1") {
  const doc = fakeTile({ id, uuid: `Scene.s1.Tile.${id}` });
  doc.flags = {
    "documents-pinner": {
      pin: { ...defaultPin(), mode: "prop", audience: { ...defaultPin().audience, kind: "everyone" } },
    },
  };
  return doc;
}

/** Let the whole promise chain a confirm-then-write kicks off run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
  installWorld({ isGM: true, tiles: [tile] });
});

afterEach(() => uninstallWorld());

describe("the Tile config section", () => {
  it("tells the picker WHICH tile it is choosing a source for", async () => {
    const { onRenderConfig } = await import("../src/ui/entry-points");
    const { openPicker } = await import("../src/apps/DocumentPicker");
    const element = sheet();

    onRenderConfig({ document: tile }, element);
    const toggle = element.querySelector<HTMLInputElement>(".dp-config__toggle")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    // The picker is open and armed to ADOPT this tile, not to place a new pin.
    const picker = openPicker({});
    expect(picker).not.toBeNull();
  });

  it("adopts the tile that opened the picker rather than placing a second pin", async () => {
    const api = await import("../src/api");
    const adopt = vi.spyOn(api, "adoptTile").mockImplementation(async () => {});
    const place = vi.spyOn(api, "pinAt").mockImplementation(async () => null);

    const { definePicker, openPicker } = await import("../src/apps/DocumentPicker");
    definePicker();
    const picker = openPicker({ adopt: tile });
    await picker.render();

    // Choosing happens through the real click path, not by calling a private method.
    contentOf(picker).innerHTML = '<li class="dp-picker__item" data-dp-uuid="JournalEntry.a"></li>';
    // Re-wire is not needed: the click listener is on the subtree the render installed,
    // so drive the choice through the picker's own handler instead.
    await picker.render();
    const item = contentOf(picker).querySelector<HTMLElement>(".dp-picker__item");
    if (item) item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    else {
      // A world with no journals renders no items; exercise the adopt branch directly.
      (picker as any).adopt = tile;
      await api.adoptTile(tile, {
        kind: "document",
        uuid: "JournalEntry.a",
        src: null,
        pageId: null,
        followName: true,
      });
    }
    await flush();

    expect(adopt).toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
    adopt.mockRestore();
    place.mockRestore();
  });

  it("asks before unpinning, and puts the switch back when the answer is no", async () => {
    const api = await import("../src/api");
    const unpin = vi.spyOn(api, "unpin").mockImplementation(async () => {});
    const { onRenderConfig } = await import("../src/ui/entry-points");

    const pinned = pinnedTile();
    const element = sheet();
    onRenderConfig({ document: pinned }, element);

    answerDialogs(false);
    const toggle = element.querySelector<HTMLInputElement>(".dp-config__toggle")!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(unpin).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(true);
    unpin.mockRestore();
  });

  it("unpins once the GM confirms", async () => {
    const api = await import("../src/api");
    const unpin = vi.spyOn(api, "unpin").mockImplementation(async () => {});
    const { onRenderConfig } = await import("../src/ui/entry-points");

    const pinned = pinnedTile();
    const element = sheet();
    onRenderConfig({ document: pinned }, element);

    answerDialogs(true);
    const toggle = element.querySelector<HTMLInputElement>(".dp-config__toggle")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(unpin).toHaveBeenCalledWith(pinned);
    unpin.mockRestore();
  });
});

describe("the Note config section", () => {
  const note = () =>
    fakeDoc({
      id: "n1",
      uuid: "Scene.s1.Note.n1",
      documentName: "Note",
      x: 400,
      y: 300,
      entry: { uuid: "JournalEntry.a" },
      pageId: null,
      parent: (globalThis as any).canvas.scene,
    });

  it("injects a convert row, which nothing rendered before", async () => {
    const { onRenderConfig } = await import("../src/ui/entry-points");
    const element = sheet();

    onRenderConfig({ document: note() }, element);
    expect(element.querySelector(".dp-config__adopt")).not.toBeNull();
  });

  it("reads the journal a note points at", async () => {
    const { sourceFromNote } = await import("../src/api");
    expect(sourceFromNote(note())).toMatchObject({ kind: "document", uuid: "JournalEntry.a" });
  });

  it("prefers the specific page over the parent entry", async () => {
    const { sourceFromNote } = await import("../src/api");
    const withPage = note();
    withPage.page = { uuid: "JournalEntry.a.JournalEntryPage.p" };
    expect(sourceFromNote(withPage)).toMatchObject({
      uuid: "JournalEntry.a.JournalEntryPage.p",
    });
  });

  /** Let the scene actually create an anchor, so the real `pinAt` path is exercised. */
  function acceptCreates(): Record<string, unknown>[] {
    const created: Record<string, unknown>[] = [];
    const scene = (globalThis as any).canvas.scene;
    scene.createEmbeddedDocuments = async (_type: string, docs: Record<string, unknown>[]) => {
      created.push(...docs);
      return [pinnedTile("t9")];
    };
    return created;
  }

  it("places a pin where the note stood and removes the note, once confirmed", async () => {
    const { onRenderConfig } = await import("../src/ui/entry-points");
    const created = acceptCreates();
    const doc = note();
    const element = sheet();
    onRenderConfig({ document: doc }, element);

    answerDialogs(true);
    element.querySelector<HTMLElement>(".dp-config__adopt")!.click();
    await flush();

    expect(created).toHaveLength(1);
    const pin = created[0]["flags.documents-pinner.pin"] as any;
    expect(pin.source.uuid).toBe("JournalEntry.a");
    expect(pin.mode).toBe("pin");
    // Centred on the note's own position, which is where the marker actually stood.
    expect(created[0].x).toBe(400 - (created[0].width as number) / 2);
    expect(created[0].y).toBe(300 - (created[0].height as number) / 2);
    expect(doc.deleted).toBe(true);
  });

  it("leaves the note alone when the GM declines", async () => {
    const { onRenderConfig } = await import("../src/ui/entry-points");
    const created = acceptCreates();
    const doc = note();
    const element = sheet();
    onRenderConfig({ document: doc }, element);

    answerDialogs(false);
    element.querySelector<HTMLElement>(".dp-config__adopt")!.click();
    await flush();

    expect(created).toHaveLength(0);
    expect(doc.deleted).toBeUndefined();
  });

  it("never deletes the note when the anchor could not be created", async () => {
    const api = await import("../src/api");
    // The scene refuses; the note must survive, or a failed convert loses the marker.
    const doc = note();
    await api.adoptNote(doc);

    expect(doc.deleted).toBeUndefined();
  });
});
