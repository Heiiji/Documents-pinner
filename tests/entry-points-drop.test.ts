/**
 * @vitest-environment jsdom
 *
 * A modified drop arms the placement ghost and returns `false`, and core's `#onDrop`
 * returns on that before it reaches the Notes layer — so the drop makes no Note. A sweep
 * used to run 250 ms later anyway and delete "whatever Note appeared since": it could only
 * ever find someone else's, and after a scene change inside that window it compared the
 * NEW scene against the old one's ids and deleted every Note on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/apps/PlacementGhost", () => ({ armAt: vi.fn() }));

import { onDropCanvasData } from "../src/ui/entry-points";
import { armAt } from "../src/apps/PlacementGhost";

let world: ReturnType<typeof installWorld>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(armAt).mockClear();
  world = installWorld({ isGM: true, settings: { dropModifier: "alt" } });
  world.canvas.scene.notes.contents = [{ id: "theirs" }];
  (globalThis as any).game.journal.get = () => ({ id: "j1", uuid: "JournalEntry.j1" });
});

afterEach(() => {
  vi.useRealTimers();
  uninstallWorld();
});

const altDrop = () => new MouseEvent("drop", { altKey: true }) as unknown as DragEvent;

describe("onDropCanvasData", () => {
  it("arms the ghost at the drop and suppresses core's own handling", () => {
    const result = onDropCanvasData(
      world.canvas,
      { type: "JournalEntry", uuid: "JournalEntry.j1", x: 120, y: 340 },
      altDrop()
    );

    expect(result).toBe(false);
    expect(armAt).toHaveBeenCalledWith(expect.anything(), { x: 120, y: 340 });
  });

  it("never deletes a Note afterwards, even one that appears in the next moment", async () => {
    const deletes = vi.spyOn(world.canvas.scene, "deleteEmbeddedDocuments");
    onDropCanvasData(
      world.canvas,
      { type: "JournalEntry", uuid: "JournalEntry.j1", x: 0, y: 0 },
      altDrop()
    );
    world.canvas.scene.notes.contents.push({ id: "another-users-note" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(deletes).not.toHaveBeenCalled();
  });

  it("leaves an unmodified drop to core", () => {
    const result = onDropCanvasData(
      world.canvas,
      { type: "JournalEntry", uuid: "JournalEntry.j1" },
      new MouseEvent("drop") as unknown as DragEvent
    );

    expect(result).toBeUndefined();
    expect(armAt).not.toHaveBeenCalled();
  });
});

describe("an image dragged from core's file browser", () => {
  it("is pinned, not left to core as a plain tile", () => {
    const result = onDropCanvasData(
      world.canvas,
      // Exactly what `FilePicker#onDragStart` sets (foundry.mjs 14.367, 33809).
      { type: "Tile", texture: { src: "maps/letter.webp" }, fromFilePicker: true, x: 5, y: 6 },
      altDrop()
    );

    expect(result).toBe(false);
    expect(vi.mocked(armAt).mock.calls[0][0]).toMatchObject({
      kind: "image",
      src: "maps/letter.webp",
    });
  });

  it("still reads a bare path, as an OS file drag arrives", () => {
    onDropCanvasData(world.canvas, { src: "maps/other.webp", x: 0, y: 0 }, altDrop());
    expect(vi.mocked(armAt).mock.calls[0][0]).toMatchObject({ src: "maps/other.webp" });
  });
});
