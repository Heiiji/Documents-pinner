/**
 * @vitest-environment jsdom
 *
 * Effects on a PDF, painted rather than styled.
 *
 * A12 gave PDFs the canvas tier and, without noticing, took their effects away: a PDF is
 * painted straight into a texture, so it has no `.dp-card` and none of `fx/effects.css`
 * reaches it. A15 disabled those controls. This is the other half — the static rendition
 * composited with Canvas2D, which is safe for the same reason A10 was not: there is no
 * `foreignObject` anywhere in it, only fills and plain SVG images.
 *
 * jsdom has no 2D context, so what is asserted here is the SEQUENCE of drawing operations,
 * which is the part that has to be right. The pixels were checked in a browser.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bakeEffects, clearBakeCache, copyCanvas } from "../src/render/BakeEffects";

interface Call {
  op: string;
  args: unknown[];
}
let calls: Call[];
let realGetContext: typeof HTMLCanvasElement.prototype.getContext;

function fakeContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    filter: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    clearRect: () => calls.push({ op: "clearRect", args: [] }),
    fillRect: (...a: unknown[]) =>
      calls.push({
        op: "fillRect",
        args: [ctx.globalCompositeOperation, ctx.fillStyle, ctx.globalAlpha, ...a],
      }),
    drawImage: () =>
      calls.push({ op: "drawImage", args: [ctx.globalCompositeOperation, ctx.globalAlpha] }),
    createPattern: () => ({ pattern: true }),
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    rect: () => calls.push({ op: "rect", args: [] }),
    roundRect: () => calls.push({ op: "roundRect", args: [] }),
    stroke: () => calls.push({ op: "stroke", args: [ctx.strokeStyle, ctx.lineWidth] }),
  };
  return ctx;
}

function canvas(w = 200, h = 300): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

beforeEach(() => {
  calls = [];
  realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as never;
  clearBakeCache();
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

const ops = () => calls.map((c) => c.op);

describe("bakeEffects", () => {
  it("does nothing at all when the effect is off", async () => {
    await bakeEffects(canvas(), { "--dp-i": "0", "--dp-tint-amt": "1", "--dp-tint": "#f00" });
    expect(ops()).toEqual([]);
  });

  it("tints with the preset's own blend mode, scaled by intensity", async () => {
    await bakeEffects(canvas(), {
      "--dp-i": "0.5",
      "--dp-tint": "#7a1f1f",
      "--dp-tint-amt": "0.4",
      "--dp-tint-blend": "multiply",
    });
    const fill = calls.find((c) => c.op === "fillRect")!;
    expect(fill.args[0]).toBe("multiply");
    expect(fill.args[1]).toBe("#7a1f1f");
    expect(fill.args[2]).toBeCloseTo(0.2, 5);
  });

  it("skips a transparent tint rather than filling with nothing", async () => {
    await bakeEffects(canvas(), {
      "--dp-i": "1",
      "--dp-tint": "transparent",
      "--dp-tint-amt": "1",
    });
    expect(ops()).not.toContain("fillRect");
  });

  it("strokes a frame only when the preset asks for one", async () => {
    await bakeEffects(canvas(), { "--dp-i": "1", "--dp-frame": "#c9ad6a", "--dp-frame-w": "3" });
    const stroke = calls.find((c) => c.op === "stroke")!;
    expect(stroke.args).toEqual(["#c9ad6a", 3]);

    calls = [];
    await bakeEffects(canvas(), { "--dp-i": "1", "--dp-frame": "#c9ad6a", "--dp-frame-w": "0" });
    expect(ops()).not.toContain("stroke");
  });

  it("draws scanlines as fills, since the CSS value is a gradient and not an image", async () => {
    await bakeEffects(canvas(200, 100), {
      "--dp-i": "1",
      "--dp-scan-op": "0.3",
      "--dp-scan-gap": "4",
    });
    // height 100, gap 4, one band every 8px.
    expect(calls.filter((c) => c.op === "fillRect")).toHaveLength(13);
  });

  it("blurs through a copy, because a canvas cannot filter itself in place", async () => {
    await bakeEffects(canvas(), { "--dp-i": "1", "--dp-blur": "4" });
    expect(ops()).toContain("clearRect");
    expect(ops()).toContain("drawImage");
  });

  it("survives a layer it cannot decode, and still paints the rest", async () => {
    // jsdom neither loads nor errors a generated data URI, which is exactly the state the
    // decode timeout exists for — modelled here as a prompt failure so the test is quick.
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    } as never;

    await bakeEffects(canvas(), {
      "--dp-i": "1",
      "--dp-surface-img": "url('data:image/svg+xml,broken')",
      "--dp-surface-op": "1",
      "--dp-frame": "#fff",
      "--dp-frame-w": "2",
    });
    // The undecodable stain is skipped; the frame is still there.
    expect(ops()).toContain("stroke");
    globalThis.Image = RealImage;
  });

  it("gives up on a texture that never resolves, rather than hanging the queue", async () => {
    // An Image that neither loads nor errors. Awaited inside the concurrency-1 generation
    // queue, this would stop every prop on the scene from ever drawing.
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_v: string) {
        /* never settles */
      }
    } as never;

    const done = await Promise.race([
      bakeEffects(canvas(), {
        "--dp-i": "1",
        "--dp-surface-img": "url('data:image/svg+xml,hangs')",
        "--dp-surface-op": "1",
      }).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("hung"), 4000)),
    ]);

    expect(done).toBe("returned");
    globalThis.Image = RealImage;
  }, 8000);
});

describe("copyCanvas", () => {
  it("returns a new canvas of the same size, so a cached page is never painted over", () => {
    const source = canvas(640, 890);
    const copy = copyCanvas(source);
    expect(copy).not.toBe(source);
    expect([copy.width, copy.height]).toEqual([640, 890]);
  });
});
