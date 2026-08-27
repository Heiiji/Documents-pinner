import { describe, expect, it } from "vitest";
import { DELETE_PREFIX, FLAGS, INTERNAL_OPTION, MODULE_ID } from "../src/const";
import { defaultPin, validatePin } from "../src/data/pin-schema";
import {
  all,
  batchUpdate,
  convertMode,
  enqueue,
  settled,
  unpin,
  update,
} from "../src/data/PinStore";

const FLAG_PATH = `flags.${MODULE_ID}.${FLAGS.PIN}`;

/** A stand-in TileDocument that records its writes and reflects them back. */
function fakeDoc(overrides: Record<string, any> = {}) {
  const pin = validatePin({
    ...defaultPin(),
    source: {
      kind: "document",
      uuid: "JournalEntry.abc",
      src: null,
      pageId: null,
      followName: true,
    },
    ...(overrides.pin ?? {}),
  }).pin;

  const doc: any = {
    id: overrides.id ?? "t1",
    uuid: `Scene.s1.Tile.${overrides.id ?? "t1"}`,
    width: overrides.width ?? 400,
    height: overrides.height ?? 560,
    sort: overrides.sort ?? 0,
    hidden: true,
    flags: { [MODULE_ID]: { [FLAGS.PIN]: pin } },
    writes: [] as { data: any; options: any }[],
    deleted: false,
    async update(data: any, options: any) {
      this.writes.push({ data, options });
      if (data[FLAG_PATH]) this.flags[MODULE_ID][FLAGS.PIN] = data[FLAG_PATH];
      if (typeof data.width === "number") this.width = data.width;
      if (typeof data.height === "number") this.height = data.height;
      if (typeof data.hidden === "boolean") this.hidden = data.hidden;
      return this;
    },
  };
  if (overrides.noPin) doc.flags = {};
  return doc;
}

function fakeScene(tiles: any[]) {
  return {
    tiles: { contents: tiles },
    calls: [] as any[],
    async updateEmbeddedDocuments(type: string, updates: any[], options: any) {
      this.calls.push({ type, updates, options });
      return updates;
    },
  };
}

const currentPin = (doc: any) => doc.flags[MODULE_ID][FLAGS.PIN];

describe("enqueue", () => {
  it("serialises tasks sharing a key", async () => {
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
    };
    await Promise.all([enqueue("a", task("first", 20)), enqueue("a", task("second", 0))]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("runs different keys concurrently", async () => {
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
    };
    await Promise.all([enqueue("a", task("slow", 20)), enqueue("b", task("fast", 0))]);
    expect(order).toEqual(["fast", "slow"]);
  });

  it("keeps draining after a task rejects", async () => {
    const failure = enqueue("c", async () => {
      throw new Error("boom");
    });
    await expect(failure).rejects.toThrow("boom");
    await expect(enqueue("c", async () => "survived")).resolves.toBe("survived");
  });

  it("surfaces the task's own result to its caller", async () => {
    await expect(enqueue("d", async () => 42)).resolves.toBe(42);
  });
});

describe("update", () => {
  it("marks every write as ours so our own hooks stand down", async () => {
    const doc = fakeDoc();
    await update(doc, { display: { padding: 0.2 } });
    expect(doc.writes[0].options[INTERNAL_OPTION]).toBe(true);
  });

  it("derives the core hidden field from the audience, in the same write", async () => {
    const doc = fakeDoc();
    await update(doc, { audience: { kind: "everyone" } });
    expect(doc.writes[0].data.hidden).toBe(false);
    expect(doc.hidden).toBe(false);

    await update(doc, { audience: { kind: "hidden" } });
    expect(doc.writes[1].data.hidden).toBe(true);
  });

  it("loses neither of two overlapping edits", async () => {
    const doc = fakeDoc();
    await Promise.all([
      update(doc, { display: { padding: 0.3 } }),
      update(doc, { audience: { kind: "everyone" } }),
    ]);
    expect(currentPin(doc).display.padding).toBe(0.3);
    expect(currentPin(doc).audience.kind).toBe("everyone");
  });

  it("does nothing to a tile that is not a pin", async () => {
    const doc = fakeDoc({ noPin: true });
    await expect(update(doc, { display: { padding: 0.2 } })).resolves.toBeNull();
    expect(doc.writes).toEqual([]);
  });

  it("re-validates, so a patch cannot persist an out-of-range value", async () => {
    const doc = fakeDoc();
    await update(doc, { display: { padding: 99 } });
    expect(currentPin(doc).display.padding).toBe(0.5);
  });
});

describe("convertMode", () => {
  it("remembers the size it leaves and restores the size it returns to", async () => {
    const doc = fakeDoc({ width: 400, height: 560 });
    await convertMode(doc, "pin");
    expect(currentPin(doc).geometry.prop).toEqual({ width: 400, height: 560 });
    expect(currentPin(doc).mode).toBe("pin");

    // A GM resizes the pin, then switches back and forth.
    doc.width = 120;
    doc.height = 120;
    await convertMode(doc, "prop");
    expect(doc.width).toBe(400);
    expect(doc.height).toBe(560);
    expect(currentPin(doc).geometry.pin).toEqual({ width: 120, height: 120 });

    await convertMode(doc, "pin");
    expect(doc.width).toBe(120);
    expect(doc.height).toBe(120);
  });

  it("never writes an _id or touches the flags beyond the payload", async () => {
    const doc = fakeDoc();
    await convertMode(doc, "pin");
    expect(doc.writes[0].data._id).toBeUndefined();
    expect(Object.keys(doc.writes[0].data).sort()).toEqual([FLAG_PATH, "height", "width"]);
  });

  it("is a no-op when the pin is already in that mode", async () => {
    const doc = fakeDoc();
    await expect(convertMode(doc, "prop")).resolves.toBeNull();
    expect(doc.writes).toEqual([]);
  });

  it("uses the caller's fallback size for a mode never visited before", async () => {
    const doc = fakeDoc();
    await convertMode(doc, "pin", { width: 64, height: 64 });
    expect(doc.width).toBe(64);
  });

  it("falls back to a derived size when the caller offers none", async () => {
    const doc = fakeDoc();
    await convertMode(doc, "pin");
    // No canvas under Node, so the grid falls back to 100 and a pin is one square.
    expect(doc.width).toBe(100);
    expect(doc.height).toBe(100);
  });
});

describe("batchUpdate", () => {
  it("applies one patch to many anchors in a single scene write", async () => {
    const docs = [fakeDoc({ id: "a" }), fakeDoc({ id: "b" }), fakeDoc({ id: "c" })];
    const scene = fakeScene(docs);
    await batchUpdate(
      scene,
      docs.map((doc) => ({ doc, patch: { audience: { kind: "everyone" as const } } }))
    );

    expect(scene.calls.length).toBe(1);
    expect(scene.calls[0].updates.length).toBe(3);
    expect(scene.calls[0].updates.every((u: any) => u.hidden === false)).toBe(true);
    expect(scene.calls[0].updates.map((u: any) => u._id)).toEqual(["a", "b", "c"]);
    expect(scene.calls[0].options[INTERNAL_OPTION]).toBe(true);
  });

  it("skips tiles that are not pins rather than writing junk", async () => {
    const scene = fakeScene([]);
    const docs = [fakeDoc({ id: "a" }), fakeDoc({ id: "b", noPin: true })];
    await batchUpdate(
      scene,
      docs.map((doc) => ({ doc, patch: { audience: { kind: "everyone" as const } } }))
    );
    expect(scene.calls[0].updates.map((u: any) => u._id)).toEqual(["a"]);
  });

  it("makes no call at all when nothing would change", async () => {
    const scene = fakeScene([]);
    await expect(batchUpdate(scene, [])).resolves.toEqual([]);
    expect(scene.calls).toEqual([]);
  });
});

describe("all", () => {
  it("returns only pinned tiles, in sort order — the Pinboard's reveal order", () => {
    const tiles = [
      fakeDoc({ id: "late", sort: 30 }),
      fakeDoc({ id: "plain", sort: 5, noPin: true }),
      fakeDoc({ id: "early", sort: 10 }),
    ];
    expect(all(fakeScene(tiles)).map((t: any) => t.id)).toEqual(["early", "late"]);
  });

  it("tolerates a scene with no tiles collection at all", () => {
    expect(all(undefined)).toEqual([]);
    expect(all({})).toEqual([]);
  });
});

describe("unpin", () => {
  it("deletes the payload with the documented deletion operator", async () => {
    const doc = fakeDoc();
    await unpin(doc);
    expect(doc.writes[0].data).toHaveProperty(
      `flags.${MODULE_ID}.${DELETE_PREFIX}${FLAGS.PIN}`,
      null
    );
  });
});

describe("settled", () => {
  it("waits for every queued write across every anchor", async () => {
    let done = false;
    void enqueue("x", async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await settled();
    expect(done).toBe(true);
  });
});
