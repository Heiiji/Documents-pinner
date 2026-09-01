/**
 * Scene <-> screen transform maths.
 *
 * The matrix functions at the top are PURE and take a plain `Mat` so they can be
 * unit-tested under Node. Only the thin wrappers at the bottom read Foundry globals.
 *
 * Everything derives from `canvas.stage.worldTransform` rather than from
 * `stage.position` / `stage.scale` separately, because the world transform already
 * composes position, scale AND pivot — and `Canvas#pan` actually sets the pivot. It
 * also survives a stage rotation that another module might introduce.
 *
 * Scene padding needs no correction anywhere here: placeable `x`/`y` are already in
 * canvas coordinates, which include padding (`canvas.dimensions.rect` starts at 0,0).
 */

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export function applyMat(m: Mat, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

export function invertMat(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) return { ...IDENTITY };
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

export function applyInverseMat(m: Mat, p: Point): Point {
  return applyMat(invertMat(m), p);
}

/** Uniform scale factor, correct even when the stage is rotated. */
export function scaleOf(m: Mat): number {
  return Math.hypot(m.a, m.b);
}

/** Stage rotation in degrees. Normally 0. */
export function rotationOf(m: Mat): number {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

/** True when two transforms are identical, so callers can skip a DOM write. */
export function sameMat(a: Mat, b: Mat): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.tx === b.tx && a.ty === b.ty;
}

export function toCssMatrix(m: Mat): string {
  return `matrix(${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty})`;
}

/**
 * The scene-space rectangle currently visible on screen.
 *
 * All four corners are transformed rather than just two, so the result stays correct
 * under a rotated stage.
 */
export function viewportRect(m: Mat, screen: { width: number; height: number }, pad = 0): Rect {
  const inv = invertMat(m);
  const pts = [
    { x: 0, y: 0 },
    { x: screen.width, y: 0 },
    { x: 0, y: screen.height },
    { x: screen.width, y: screen.height },
  ].map((p) => applyMat(inv, p));

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, width: Math.max(...xs) + pad - x0, height: Math.max(...ys) + pad - y0 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * The axis-aligned scene-space bounds of a rotated placeable, used for culling.
 * `rotation` is in degrees, about the placeable's centre, matching TileDocument.
 */
export function rotatedBounds(doc: Rect & { rotation?: number }): Rect {
  const rot = ((doc.rotation ?? 0) * Math.PI) / 180;
  if (rot === 0) return { x: doc.x, y: doc.y, width: doc.width, height: doc.height };

  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  const w = doc.width * cos + doc.height * sin;
  const h = doc.width * sin + doc.height * cos;
  return {
    x: doc.x + doc.width / 2 - w / 2,
    y: doc.y + doc.height / 2 - h / 2,
    width: w,
    height: h,
  };
}

/**
 * Whether a scene-space point lies inside a rotated placeable.
 *
 * Exact, not the axis-aligned bounds: the reader uses this to tell a press on the prop
 * being read from a press beside it, and a tilted letter's bounding box covers a good
 * deal of map that is not letter.
 */
export function containsPoint(doc: Rect & { rotation?: number }, p: Point): boolean {
  const cx = doc.x + doc.width / 2;
  const cy = doc.y + doc.height / 2;
  const rot = (-(doc.rotation ?? 0) * Math.PI) / 180;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
  const ly = dx * Math.sin(rot) + dy * Math.cos(rot);
  return Math.abs(lx) <= doc.width / 2 && Math.abs(ly) <= doc.height / 2;
}

/** Where a prop lands on screen, for positioning the focused DOM reader. */
export function screenPlacement(
  m: Mat,
  doc: Rect & { rotation?: number }
): { cx: number; cy: number; width: number; height: number; angle: number } {
  const centre = applyMat(m, { x: doc.x + doc.width / 2, y: doc.y + doc.height / 2 });
  const k = scaleOf(m);
  return {
    cx: centre.x,
    cy: centre.y,
    width: doc.width * k,
    height: doc.height * k,
    angle: (doc.rotation ?? 0) + rotationOf(m),
  };
}

/** Apparent on-screen width of a prop in CSS pixels — the input to the LOD ladder. */
export function apparentWidth(m: Mat, width: number): number {
  return width * scaleOf(m);
}

// ---------------------------------------------------------------------------
// Foundry-facing wrappers. Everything above stays global-free.
// ---------------------------------------------------------------------------

declare const canvas: any;

export function stageMatrix(): Mat {
  const t = canvas?.stage?.worldTransform;
  if (!t) return { ...IDENTITY };
  return { a: t.a, b: t.b, c: t.c, d: t.d, tx: t.tx, ty: t.ty };
}

export function sceneToScreen(p: Point): Point {
  return applyMat(stageMatrix(), p);
}

export function screenToScene(p: Point): Point {
  return applyInverseMat(stageMatrix(), p);
}

export function visibleSceneRect(pad = 0): Rect {
  const screen = canvas?.app?.renderer?.screen ?? { width: 0, height: 0 };
  return viewportRect(stageMatrix(), screen, pad);
}
