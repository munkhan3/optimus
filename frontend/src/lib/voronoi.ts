/**
 * Power diagrams: a weighted Voronoi that tiles a rectangle with no gaps.
 *
 * The Areas view needs regions that adapt to how much work each area holds and
 * that leave no unclaimed ground between them. A power diagram gives both for
 * free: every point of the plane belongs to exactly one site, and the boundary
 * between two sites is still a straight line -- just offset from the midpoint
 * towards the lighter of the two. So a cell is nothing more than the bounding
 * rectangle clipped by one half-plane per rival, which is Sutherland-Hodgman
 * and about eighty lines rather than a dependency.
 *
 * Everything here is pure and order-stable: the same sites always produce the
 * same polygons, which is what lets the layout stay deterministic.
 */

export type Point = [number, number];

export interface Site {
  key: string;
  x: number;
  y: number;
  /** Larger weight claims more ground. In the same units as distance. */
  weight: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function rectPolygon(r: Rect): Point[] {
  // Counter-clockwise in screen coordinates (y grows downward).
  return [
    [r.x0, r.y1],
    [r.x1, r.y1],
    [r.x1, r.y0],
    [r.x0, r.y0],
  ];
}

/** Trim a convex polygon to a rectangle. */
export function clipToRect(poly: Point[], r: Rect): Point[] {
  let out = clipHalfPlane(poly, -1, 0, -r.x0);
  out = clipHalfPlane(out, 1, 0, r.x1);
  out = clipHalfPlane(out, 0, -1, -r.y0);
  return clipHalfPlane(out, 0, 1, r.y1);
}

/** Clip a convex polygon to the half-plane `a*x + b*y <= c`. */
function clipHalfPlane(poly: Point[], a: number, b: number, c: number): Point[] {
  if (poly.length === 0) return poly;
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] - c;
    const dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    // Only emit a crossing point when the sign genuinely flips; a vertex that
    // sits exactly on the line is already carried by the `dp <= 0` branch and
    // emitting it twice would leave a zero-length edge in the result.
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/**
 * One cell per site, together covering `bounds` exactly.
 *
 * The cell of site i is the set of points closer to i than to any rival once
 * each distance is discounted by that site's weight:
 *
 *     |p - sᵢ|² - wᵢ²  ≤  |p - sⱼ|² - wⱼ²
 *
 * which rearranges to the linear constraint used below. Only the *differences*
 * between the squared weights matter, so they are shifted to start at zero.
 */
export function powerCells(sites: Site[], bounds: Rect): Map<string, Point[]> {
  const cells = new Map<string, Point[]>();
  if (sites.length === 0) return cells;
  const rect = rectPolygon(bounds);
  if (sites.length === 1) {
    cells.set(sites[0].key, rect);
    return cells;
  }

  /* A site loses its own centre -- and its cell can vanish entirely, leaving
     its nodes homeless -- as soon as a rival outweighs it by more than the
     distance between them (the cell contains sᵢ only while wⱼ² - wᵢ² ≤ dᵢⱼ²).
     So the weight spread is scaled to fit inside the closest pair. Weighting
     then still tilts every boundary, it just can never swallow a neighbour. */
  let minD2 = Infinity;
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const d2 = (sites[j].x - sites[i].x) ** 2 + (sites[j].y - sites[i].y) ** 2;
      if (d2 > 1e-9) minD2 = Math.min(minD2, d2);
    }
  }
  const squares = sites.map((s) => s.weight * s.weight);
  const lo = Math.min(...squares);
  const span = Math.max(...squares) - lo;
  const budget = Number.isFinite(minD2) ? minD2 * 0.85 : 0;
  const k = span > budget ? budget / span : 1;
  const w2 = squares.map((v) => (v - lo) * k);

  for (let i = 0; i < sites.length; i++) {
    const si = sites[i];
    let poly = rect;
    const ci = si.x * si.x + si.y * si.y - w2[i];
    for (let j = 0; j < sites.length; j++) {
      if (j === i) continue;
      const sj = sites[j];
      const a = 2 * (sj.x - si.x);
      const b = 2 * (sj.y - si.y);
      // Coincident sites have no boundary to draw. Skipping keeps the clip from
      // degenerating into `0 <= 0`, which would silently keep the whole rect.
      if (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) continue;
      poly = clipHalfPlane(poly, a, b, sj.x * sj.x + sj.y * sj.y - w2[j] - ci);
      if (poly.length === 0) break;
    }
    cells.set(si.key, poly);
  }
  return cells;
}

/** Twice the signed area. Positive when the ring winds counter-clockwise. */
function signedArea2(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s;
}

export function polygonCentroid(poly: Point[]): Point {
  const a2 = signedArea2(poly);
  if (poly.length === 0) return [0, 0];
  if (Math.abs(a2) < 1e-9) {
    // Degenerate sliver: the area formula divides by zero, so average instead.
    const n = poly.length;
    return [
      poly.reduce((t, p) => t + p[0], 0) / n,
      poly.reduce((t, p) => t + p[1], 0) / n,
    ];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

export function polygonBounds(poly: Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The topmost y the polygon reaches at a given x, or null if it never does.
 *
 * A cell's bounding box top can sit a long way from the cell itself -- an
 * angled Voronoi boundary means the highest corner is often above someone
 * else's ground entirely. Captions have to hang off the real edge instead, or
 * they end up labelling a neighbour.
 */
export function topEdgeAt(poly: Point[], x: number): number | null {
  let top: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    if (x0 === x1) continue;
    const t = (x - x0) / (x1 - x0);
    if (t < 0 || t > 1) continue;
    const y = y0 + (y1 - y0) * t;
    if (top === null || y < top) top = y;
  }
  return top;
}

/** Ray cast, so it holds for any simple polygon rather than only convex ones. */
export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Pull a point inside a convex polygon, keeping `inset` clear of every edge.
 *
 * Separation runs after placement and can shove a dot across its own boundary,
 * which would put it in a neighbour's territory and make the region a lie. This
 * is the correction: walk the edges and, wherever the point falls short of the
 * inset, push it back along that edge's inward normal.
 *
 * Passes are capped because a cell narrower than `2 * inset` has no point that
 * satisfies every edge at once; there the loop would trade one violation for
 * another forever, and stopping early leaves the point near the middle, which
 * is the best answer available.
 */
export function clampIntoPolygon(
  x: number,
  y: number,
  poly: Point[],
  inset: number,
): Point {
  if (poly.length < 3) return [x, y];
  const ccw = signedArea2(poly) > 0;
  let px = x;
  let py = y;
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      let nx = -(q[1] - p[1]);
      let ny = q[0] - p[0];
      if (!ccw) {
        nx = -nx;
        ny = -ny;
      }
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      nx /= len;
      ny /= len;
      const gap = nx * (px - p[0]) + ny * (py - p[1]);
      if (gap >= inset) continue;
      px += nx * (inset - gap);
      py += ny * (inset - gap);
      moved = true;
    }
    if (!moved) break;
  }
  return [px, py];
}
