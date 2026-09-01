import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  apparentWidth,
  applyInverseMat,
  applyMat,
  containsPoint,
  invertMat,
  rectsIntersect,
  rotatedBounds,
  rotationOf,
  sameMat,
  scaleOf,
  screenPlacement,
  toCssMatrix,
  type Mat,
  viewportRect,
} from "../src/canvas/transform";

/** Build a translate+scale+rotate matrix the way PIXI composes one. */
function make(scale: number, tx: number, ty: number, deg = 0): Mat {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    a: scale * cos,
    b: scale * sin,
    c: -scale * sin,
    d: scale * cos,
    tx,
    ty,
  };
}

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe("point transforms", () => {
  it("round-trips under translation", () => {
    const m = make(1, 120, -35);
    const p = { x: 400, y: 250 };
    const back = applyInverseMat(m, applyMat(m, p));
    close(back.x, p.x);
    close(back.y, p.y);
  });

  it("round-trips under scale", () => {
    const m = make(2.75, 0, 0);
    const p = { x: -13.5, y: 900 };
    const back = applyInverseMat(m, applyMat(m, p));
    close(back.x, p.x);
    close(back.y, p.y);
  });

  it("round-trips under a rotated stage", () => {
    const m = make(0.6, 90, 12, 37);
    const p = { x: 1000, y: -400 };
    const back = applyInverseMat(m, applyMat(m, p));
    close(back.x, p.x);
    close(back.y, p.y);
  });

  it("is the identity for the identity matrix", () => {
    expect(applyMat(IDENTITY, { x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
  });

  it("degrades to identity for a singular matrix rather than producing NaN", () => {
    const singular: Mat = { a: 0, b: 0, c: 0, d: 0, tx: 5, ty: 5 };
    expect(invertMat(singular)).toEqual(IDENTITY);
  });
});

describe("scale and rotation extraction", () => {
  it("recovers a uniform scale regardless of rotation", () => {
    close(scaleOf(make(2, 0, 0)), 2);
    close(scaleOf(make(2, 0, 0, 47)), 2);
  });

  it("recovers the stage rotation", () => {
    close(rotationOf(make(1, 0, 0)), 0);
    close(rotationOf(make(3, 10, 10, 45)), 45);
  });

  it("reports apparent width in screen pixels", () => {
    close(apparentWidth(make(0.5, 0, 0), 800), 400);
  });
});

describe("viewportRect", () => {
  it("maps the screen back to scene space under translate and scale", () => {
    // Stage scaled 2x, panned so scene (100,50) sits at the screen origin.
    const m = make(2, -200, -100);
    const r = viewportRect(m, { width: 800, height: 600 });
    close(r.x, 100);
    close(r.y, 50);
    close(r.width, 400);
    close(r.height, 300);
  });

  it("expands the rect by the padding on every side", () => {
    const bare = viewportRect(make(1, 0, 0), { width: 100, height: 100 });
    const padded = viewportRect(make(1, 0, 0), { width: 100, height: 100 }, 25);
    close(padded.x, bare.x - 25);
    close(padded.width, bare.width + 50);
  });

  it("covers all four corners when the stage is rotated", () => {
    const m = make(1, 0, 0, 45);
    const r = viewportRect(m, { width: 100, height: 100 });
    // A 45-degree rotation of a 100x100 screen needs a sqrt(2)-wider scene rect.
    close(r.width, Math.SQRT2 * 100);
    close(r.height, Math.SQRT2 * 100);
  });
});

describe("bounds and intersection", () => {
  it("returns the plain rect for an unrotated prop", () => {
    expect(rotatedBounds({ x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("grows the bounds of a rotated prop about its centre", () => {
    const b = rotatedBounds({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    close(b.width, Math.SQRT2 * 100);
    close(b.height, Math.SQRT2 * 100);
    close(b.x + b.width / 2, 50);
    close(b.y + b.height / 2, 50);
  });

  it("is unchanged by a 180 degree rotation", () => {
    const b = rotatedBounds({ x: 5, y: 5, width: 80, height: 40, rotation: 180 });
    close(b.x, 5);
    close(b.width, 80);
    close(b.height, 40);
  });

  it("detects overlap and rejects mere edge contact", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 20, y: 20, width: 1, height: 1 })).toBe(false);
  });
});

describe("screenPlacement", () => {
  it("places the prop centre and adds the stage rotation to its own", () => {
    const m = make(2, 0, 0, 10);
    const p = screenPlacement(m, { x: 0, y: 0, width: 100, height: 200, rotation: 30 });
    close(p.width, 200);
    close(p.height, 400);
    close(p.angle, 40);
  });
});

describe("dirty checking", () => {
  it("recognises an identical transform so the DOM write can be skipped", () => {
    expect(sameMat(make(1, 2, 3), make(1, 2, 3))).toBe(true);
    expect(sameMat(make(1, 2, 3), make(1, 2, 3.0001))).toBe(false);
  });

  it("serialises to a CSS matrix in the right component order", () => {
    expect(toCssMatrix({ a: 1, b: 2, c: 3, d: 4, tx: 5, ty: 6 })).toBe("matrix(1,2,3,4,5,6)");
  });
});

describe("containsPoint", () => {
  const doc = { x: 100, y: 100, width: 200, height: 100, rotation: 0 };

  it("accepts a point inside and rejects one outside an unrotated prop", () => {
    expect(containsPoint(doc, { x: 150, y: 150 })).toBe(true);
    expect(containsPoint(doc, { x: 301, y: 150 })).toBe(false);
    expect(containsPoint(doc, { x: 150, y: 99 })).toBe(false);
  });

  it("follows the rotation, so a tilted letter's empty corners are not letter", () => {
    const tilted = { ...doc, rotation: 90 };
    // Rotated about its centre (200, 150) the 200x100 box now spans y 50..250, x 150..250.
    expect(containsPoint(tilted, { x: 200, y: 60 })).toBe(true);
    expect(containsPoint(tilted, { x: 110, y: 150 })).toBe(false);
  });
});
