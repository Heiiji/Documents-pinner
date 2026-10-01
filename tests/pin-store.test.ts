import { describe, expect, it, vi } from "vitest";
import { DELETE_PREFIX, FLAGS, INTERNAL_OPTION, MODULE_ID } from "../src/const";
import { hidden, setUserVisible } from "../src/data/audience";
import { defaultPin, validatePin } from "../src/data/pin-schema";
import {
  all,
  batchUpdate,
  convertMode,
  enqueue,
  removeMany,
  resize,
  setTexture,
  settled,
  unpin,
  update,
  updateWith,
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
      pdfPage: null,
      followName: true,
    },
    ...(overrides.pin ?? {}),
  }).pin;

  const doc: any = {
    id: overrides.id ?? "t1",
    uuid: `Scene.s1.Tile.${overrides.id ?? "t1"}`,
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 400,
    height: overrides.height ?? 560,
    rotation: overrides.rotation ?? 0,
    sort: overrides.sort ?? 0,
    hidden: true,
    flags: { [MODULE_ID]: { [FLAGS.PIN]: pin } },
    writes: [] as { data: any; options: any }[],
    deleted: false,
    async update(data: any, options: any) {
      this.writes.push({ data, options });
      if (data[FLAG_PATH]) this.flags[MODULE_ID][FLAGS.PIN] = data[FLAG_PATH];
      if (typeof data.x === "number") this.x = data.x;
      if (typeof data.y === "number") this.y = data.y;
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

  // A duplicated scene keeps every tile's id: a pin's writes waited behind its twin's on
  // the other scene. They queue by uuid now — each pin behind its own writes only.
  it("does not hold a pin's write behind its twin's on a duplicated scene", async () => {
    const day = fakeDoc();
    const night = fakeDoc();
    night.uuid = "Scene.night.Tile.t1";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const write = day.update;
    day.update = async (...args: [any, any]) => {
      await gate;
      return write.apply(day, args);
    };

    const first = update(day, { display: { label: "Day" } });
    try {
      const second = update(night, { display: { label: "Night" } }).then(() => "night");
      // Every step of an unblocked write is a microtask, so it lands before this timeout.
      const waited = new Promise((resolve) => setTimeout(() => resolve("waited"), 0));
      expect(await Promise.race([second, waited])).toBe("night");
    } finally {
      // Released whatever happened, or every later write to this id would wait forever.
      release();
      await first;
    }
    expect(currentPin(day).display.label).toBe("Day");
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

  it("deep-merges a nested group instead of replacing it", async () => {
    // The regression this guards: editing only the ownership LEVEL used to replace the
    // whole ownershipSync group, silently switching sync back on for a GM who had
    // turned it off.
    const doc = fakeDoc();
    await update(doc, { audience: { ownershipSync: { enabled: false, level: 2 } } });
    await update(doc, { audience: { ownershipSync: { level: 1 } } as any });

    expect(currentPin(doc).audience.ownershipSync).toEqual({ enabled: false, level: 1 });
  });

  it("keeps sibling audience fields when patching one of them", async () => {
    const doc = fakeDoc();
    await update(doc, { audience: { kind: "selected", users: ["a", "b"] } });
    await update(doc, { audience: { sticky: false } });

    expect(currentPin(doc).audience.users).toEqual(["a", "b"]);
    expect(currentPin(doc).audience.kind).toBe("selected");
    expect(currentPin(doc).audience.sticky).toBe(false);
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

/**
 * The one writer that bypassed the queue.
 *
 * `batchUpdate` read N payloads and wrote them in a single scene update, but read them
 * OUTSIDE the per-anchor queue every other writer uses. A Pinboard "reveal all" landing
 * while a HUD chip toggle was still in flight therefore read the pre-toggle payload and
 * wrote it back over the toggle — the exact lost-update the queue exists to prevent,
 * reached by the only path that did not use it.
 */
describe("batchUpdate and the per-anchor queue", () => {
  it("waits for an in-flight single-anchor write before reading the payload", async () => {
    const doc = fakeDoc();
    const scene = fakeScene([doc]);

    // A slow single-anchor write, as a HUD chip toggle in flight would be.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = doc.update.bind(doc);
    doc.update = async (data: any, options: any) => {
      await gate;
      return original(data, options);
    };

    const single = update(doc, { display: { label: "toggled" } });
    const batch = batchUpdate(scene as any, [{ doc, patch: { mode: "pin" } }]);

    release();
    await single;
    await batch;

    // The batch read the payload the single write had already produced, instead of the
    // stale one it had captured before that write landed.
    const written = scene.calls[0].updates[0][FLAG_PATH];
    expect(written.display.label).toBe("toggled");
    expect(written.mode).toBe("pin");
  });
});

describe("the type size and the mode switch", () => {
  it("freezes the type size when an anchor first becomes a prop", async () => {
    const doc = fakeDoc({ pin: { mode: "pin" }, width: 100, height: 100 });
    await convertMode(doc, "prop", { width: 400, height: 566 });
    const pin = doc.flags[MODULE_ID][FLAGS.PIN];
    expect(pin.display.typeSize).toBeCloseTo(400 / 26, 6);
    expect(pin.display.margin).not.toBeNull();
    expect(doc.width).toBe(400);
  });

  it("leaves a stored type size alone", async () => {
    const doc = fakeDoc({
      pin: { mode: "pin", display: { ...defaultPin().display, typeSize: 20, margin: 2 } },
    });
    await convertMode(doc, "prop", { width: 400, height: 566 });
    expect(doc.flags[MODULE_ID][FLAGS.PIN].display.typeSize).toBe(20);
  });

  it("does not freeze anything on the way to pin mode", async () => {
    const doc = fakeDoc({ pin: { mode: "prop" } });
    await convertMode(doc, "pin");
    expect(doc.flags[MODULE_ID][FLAGS.PIN].display.typeSize).toBeNull();
  });
});

describe("resize", () => {
  it("writes the box and the point that keeps its corner, through the queue with the internal option", async () => {
    const doc = fakeDoc();
    await resize(doc, { width: 640.4, height: 900.6 });
    expect(doc.writes.length).toBe(1);
    expect(Object.keys(doc.writes[0].data).sort()).toEqual(["height", "width", "x", "y"]);
    // The point is the centre: 400x560 → 640x901 moves it by half the growth.
    expect(doc.writes[0].data).toEqual({ x: 120, y: 171, width: 640, height: 901 });
    expect(doc.writes[0].options[INTERNAL_OPTION]).toBe(true);
  });

  it("keeps the top-left corner: a taller sheet's point moves down by half the growth", async () => {
    const doc = fakeDoc();
    await resize(doc, { width: 400, height: 812 });
    expect(doc.writes[0].data).toEqual({ x: 0, y: 126, width: 400, height: 812 });
  });

  it("grows a rotated sheet along its own edges, not the screen's", async () => {
    const doc = fakeDoc({ rotation: 90 });
    await resize(doc, { width: 400, height: 812 });
    expect(doc.writes[0].data).toEqual({ x: -126, y: 0, width: 400, height: 812 });
  });

  it("refuses a tile that is not a pin", async () => {
    const doc = fakeDoc({ noPin: true });
    await expect(resize(doc, { width: 640, height: 900 })).resolves.toBeNull();
    expect(doc.writes).toEqual([]);
  });

  it("never writes a size below one pixel", async () => {
    const doc = fakeDoc();
    await resize(doc, { width: 0, height: -5 });
    expect(doc.writes[0].data).toMatchObject({ width: 1, height: 1 });
  });
});

/** Hold the doc's next write until the returned function is called; later ones pass. */
function gateNextWrite(doc: any): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = doc.update.bind(doc);
  let gated = false;
  doc.update = async (data: any, options: any) => {
    if (!gated) {
      gated = true;
      await gate;
    }
    return original(data, options);
  };
  return () => release();
}

/**
 * A change decided inside the queue (DESIGN A29).
 *
 * The queue ordered every write, and still lost one: the HUD's chips built the whole next
 * audience from the payload as it was BEFORE their turn, and `mergePin` replaces a list
 * whole. Two clicks in one tick — hide it from Ali, hide it from Ben — each read
 * `everyone`, each wrote "everybody but me", and the second put Ali back.
 */
describe("updateWith", () => {
  const players = ["ali", "ben", "cy"];
  const everyone = { audience: { ...defaultPin().audience, kind: "everyone" as const } };
  const without = (userId: string) => (pin: any) => ({
    audience: setUserVisible(pin.audience, userId, false, players),
  });

  it("decides the patch from the payload the write in flight leaves, not the one before it", async () => {
    const doc = fakeDoc({ pin: everyone });
    const release = gateNextWrite(doc);
    const seen: string[] = [];

    const first = update(doc, { display: { label: "in flight" } });
    const second = updateWith(doc, (pin) => {
      seen.push(pin.display.label);
      return { display: { padding: 0.2 } };
    });
    release();
    await Promise.all([first, second]);

    expect(seen).toEqual(["in flight"]);
    expect(currentPin(doc).display).toMatchObject({ label: "in flight", padding: 0.2 });
  });

  it("lands both of two chip clicks made in the same tick", async () => {
    const doc = fakeDoc({ pin: everyone });
    const release = gateNextWrite(doc);

    const ali = updateWith(doc, without("ali"));
    const ben = updateWith(doc, without("ben"));
    release();
    await Promise.all([ali, ben]);

    expect(currentPin(doc).audience).toMatchObject({ kind: "selected", users: ["cy"] });
  });

  it("writes nothing when the decision is null, and says what it found", async () => {
    const doc = fakeDoc({ pin: everyone });
    const outcome = await updateWith(doc, () => null);
    expect(doc.writes).toEqual([]);
    expect(outcome.patch).toBeNull();
    expect(outcome.result).toBeNull();
    expect(outcome.before?.audience.kind).toBe("everyone");
  });

  it("does nothing to a tile that is not a pin, and never asks", async () => {
    const doc = fakeDoc({ noPin: true });
    const fn = vi.fn(() => ({ display: { padding: 0.2 } }));
    await expect(updateWith(doc, fn)).resolves.toEqual({ before: null, patch: null, result: null });
    expect(fn).not.toHaveBeenCalled();
    expect(doc.writes).toEqual([]);
  });

  it("derives `hidden` from the patch it decided, and only when that patch moves the audience", async () => {
    const doc = fakeDoc();
    const shown = await updateWith(doc, () => ({ audience: { kind: "everyone" as const } }));
    expect(doc.writes[0].data.hidden).toBe(false);
    expect(shown.patch).toEqual({ audience: { kind: "everyone" } });
    expect(shown.result).toBe(doc);

    await updateWith(doc, () => ({ display: { label: "renamed" } }));
    expect("hidden" in doc.writes[1].data).toBe(false);
    expect(doc.writes[1].options[INTERNAL_OPTION]).toBe(true);
  });

  it("decides the implied tile fields from the same payload", async () => {
    const doc = fakeDoc();
    await updateWith(
      doc,
      () => ({ mode: "pin" as const }),
      (pin) => ({ "texture.src": `was-${pin.mode}` })
    );
    expect(doc.writes[0].data["texture.src"]).toBe("was-prop");
  });
});

describe("batchUpdate's function form", () => {
  it("does not overwrite a chip click still in flight", async () => {
    const doc = fakeDoc({ pin: { audience: { ...defaultPin().audience, kind: "everyone" } } });
    const scene: any = fakeScene([doc]);
    // Core's scene write lands each change on its document.
    scene.updateEmbeddedDocuments = async (_type: string, updates: any[], options: any) => {
      scene.calls.push({ updates, options });
      for (const change of updates) {
        const data = { ...change };
        delete data._id;
        await doc.update(data, options);
      }
      return updates;
    };
    const release = gateNextWrite(doc);

    // The chip: hide it from Ali. The batch: hide the pin, remembering who it was for.
    const chip = updateWith(doc, (pin) => ({
      audience: setUserVisible(pin.audience, "ali", false, ["ali", "ben", "cy"]),
    }));
    const batch = batchUpdate(scene, [
      { doc, patch: (pin) => ({ audience: hidden(pin.audience) }) },
    ]);
    release();
    await Promise.all([chip, batch]);

    expect(currentPin(doc).audience).toMatchObject({
      kind: "hidden",
      restore: { kind: "selected", users: ["ben", "cy"] },
    });
  });

  it("leaves out a pin whose decision is null, and writes nothing when every one is", async () => {
    const docs = [fakeDoc({ id: "a" }), fakeDoc({ id: "b" })];
    const scene = fakeScene(docs);
    await batchUpdate(scene, [
      { doc: docs[0], patch: () => null },
      { doc: docs[1], patch: () => ({ display: { label: "b" } }) },
    ]);
    expect(scene.calls[0].updates.map((u: any) => u._id)).toEqual(["b"]);

    await batchUpdate(scene, [{ doc: docs[0], patch: () => null }]);
    expect(scene.calls).toHaveLength(1);
  });
});

describe("setTexture", () => {
  it("waits its turn and compares with the texture the write before it left", async () => {
    const doc = fakeDoc();
    doc.texture = { src: "icons/svg/book.svg" };
    const original = doc.update.bind(doc);
    doc.update = async (data: any, options: any) => {
      if (data["texture.src"]) doc.texture = { src: data["texture.src"] };
      return original(data, options);
    };

    const [first, second] = await Promise.all([
      setTexture(doc, "icons/svg/skull.svg"),
      setTexture(doc, "icons/svg/skull.svg"),
    ]);

    expect([first, second]).toEqual([true, false]);
    expect(doc.writes).toHaveLength(1);
    expect(doc.writes[0].data).toEqual({ "texture.src": "icons/svg/skull.svg" });
    expect(doc.writes[0].options[INTERNAL_OPTION]).toBe(true);
  });

  it("refuses an image pin, whose texture is its source", async () => {
    const doc = fakeDoc({
      pin: { source: { ...defaultPin().source, kind: "image", src: "maps/a.webp" } },
    });
    await expect(setTexture(doc, "icons/svg/skull.svg")).resolves.toBe(false);
    expect(doc.writes).toEqual([]);
  });
});

describe("removeMany", () => {
  it("lets the writes already queued land, runs its first step, then deletes in one write", async () => {
    const docs = [fakeDoc({ id: "a" }), fakeDoc({ id: "b" })];
    const order: string[] = [];
    const scene: any = {
      async deleteEmbeddedDocuments(_type: string, ids: string[], options: any) {
        order.push(`delete ${ids.join(",")} ${options[INTERNAL_OPTION]}`);
        return ids;
      },
    };
    const original = docs[0].update.bind(docs[0]);
    docs[0].update = async (data: any, options: any) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("write a");
      return original(data, options);
    };

    const write = update(docs[0], { display: { label: "queued" } });
    await removeMany(scene, docs, async () => void order.push("release"));
    await write;

    expect(order).toEqual(["write a", "release", "delete a,b true"]);
  });
});
