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


/**
 * Smooth outlines for a set of cells that tile the plane.
 *
 * The boundaries are a graph, not a pile of independent edges: three cells meet
 * at a junction and the two territories on either side of a boundary see the
 * same line. Curving each edge on its own therefore kinks every junction, and
 * curving each cell on its own tears the tiling apart, because the two owners
 * of an edge would each bend it their own way.
 *
 * So the smoothing happens on the boundary graph itself. Edges are paired at
 * every junction -- the two that continue straightest through it -- into chains,
 * and each chain is interpolated as one curve that passes through its junctions
 * instead of stopping at them. A chain's curve is then handed to both cells that
 * share it, so the ground stays partitioned exactly while the line reads as one
 * continuous stroke sweeping through the meeting points. The third edge at a
 * junction is a chain end: it runs into that curve rather than bending with it,
 * which is what a tributary does anyway.
 *
 * Tangents are unit vectors scaled by the segment they serve, not the raw
 * Catmull-Rom difference: a cell's outer vertices sit tens of thousands of units
 * away at the edge of the painted field, and a tangent that took their distance
 * into account would swing the curve wildly off the short segments on screen.
 *
 * The junctions themselves are then eased. Three curves meeting at a point make
 * a corner in all three outlines -- the angles there sum to 360, so no
 * arrangement of them is smooth -- and the fix is to round each cell's corner
 * *outward*, past the junction, rather than cutting it back. Cut back, the
 * three cells pull away from the point and the background shows through it;
 * bulged, they overlap across it by a few units and the point stays covered.
 * The arcs between corners are trimmed by the same absolute amount from either
 * side, so the long shared stretch of every boundary is still one curve drawn
 * twice, and only the last few units at each end belong to one cell alone.
 */
export function smoothTiling(polys: Point[][], corner = 34, tension = 1): string[] {
  const vkey = (p: Point) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const ekey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const point = new Map<string, Point>();
  const edge = new Map<string, { a: string; b: string }>();
  const incident = new Map<string, string[]>();

  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const pk = vkey(p);
      const qk = vkey(q);
      if (pk === qk) continue;
      point.set(pk, p);
      point.set(qk, q);
      const ek = ekey(pk, qk);
      if (edge.has(ek)) continue;
      edge.set(ek, { a: pk, b: qk });
      incident.set(pk, [...(incident.get(pk) ?? []), ek]);
      incident.set(qk, [...(incident.get(qk) ?? []), ek]);
    }
  }

  /** Unit direction from vertex `vk` along edge `ek`. */
  function away(vk: string, ek: string): Point {
    const e = edge.get(ek)!;
    const here = point.get(vk)!;
    const there = point.get(e.a === vk ? e.b : e.a)!;
    const dx = there[0] - here[0];
    const dy = there[1] - here[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  // Pair up at each junction. Only an obtuse pair is worth joining: two edges
  // that leave at less than a right angle are a spur, not a continuation.
  const partner = new Map<string, string>();
  for (const [vk, eks] of incident) {
    let best: [string, string] | null = null;
    let bestDot = 0;
    for (let i = 0; i < eks.length; i++) {
      for (let j = i + 1; j < eks.length; j++) {
        const [ax, ay] = away(vk, eks[i]);
        const [bx, by] = away(vk, eks[j]);
        const dot = ax * bx + ay * by;
        if (dot < bestDot) {
          bestDot = dot;
          best = [eks[i], eks[j]];
        }
      }
    }
    if (best) {
      partner.set(`${vk}@${best[0]}`, best[1]);
      partner.set(`${vk}@${best[1]}`, best[0]);
    }
  }

  const used = new Set<string>();
  const chains: string[][] = [];

  function walk(startV: string, startE: string): string[] {
    const seq = [startV];
    let v = startV;
    let e: string | undefined = startE;
    while (e && !used.has(e)) {
      used.add(e);
      const { a, b } = edge.get(e)!;
      const next = a === v ? b : a;
      seq.push(next);
      e = partner.get(`${next}@${e}`);
      v = next;
    }
    return seq;
  }

  // Chain ends first, so an open run is walked from its end and comes out in
  // one piece; whatever is left over is a closed loop and can start anywhere.
  for (const [vk, eks] of incident) {
    for (const ek of eks) {
      if (!used.has(ek) && !partner.has(`${vk}@${ek}`)) chains.push(walk(vk, ek));
    }
  }
  for (const [ek, e] of edge) {
    if (!used.has(ek)) chains.push(walk(e.a, ek));
  }

  const curve = new Map<string, { from: string; c1: Point; c2: Point }>();
  for (const seq of chains) {
    const pts = seq.map((k) => point.get(k)!);
    const n = pts.length;
    if (n < 2) continue;

    const unit = (a: Point, b: Point): Point => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    };

    const tangent: Point[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) tangent.push(unit(pts[0], pts[1]));
      else if (i === n - 1) tangent.push(unit(pts[n - 2], pts[n - 1]));
      else {
        // The bisector of the two edge directions: the curve leaves the
        // junction the way it arrived, so the bend is shared between them.
        const [ax, ay] = unit(pts[i - 1], pts[i]);
        const [bx, by] = unit(pts[i], pts[i + 1]);
        const len = Math.hypot(ax + bx, ay + by);
        tangent.push(len < 1e-9 ? [ax, ay] : [(ax + bx) / len, (ay + by) / len]);
      }
    }

    for (let i = 0; i < n - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const reach = (Math.hypot(q[0] - p[0], q[1] - p[1]) * tension) / 3;
      curve.set(ekey(seq[i], seq[i + 1]), {
        from: seq[i],
        c1: [p[0] + tangent[i][0] * reach, p[1] + tangent[i][1] * reach],
        c2: [q[0] - tangent[i + 1][0] * reach, q[1] - tangent[i + 1][1] * reach],
      });
    }
  }

  /** The part of a cubic between two parameters, by de Casteljau. */
  function slice(
    p0: Point, c1: Point, c2: Point, p3: Point, u0: number, u1: number,
  ): [Point, Point, Point, Point] {
    const at = (a: Point, b: Point, t: number): Point => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    const cut = (t: number) => {
      const a = at(p0, c1, t);
      const b = at(c1, c2, t);
      const c = at(c2, p3, t);
      const d = at(a, b, t);
      const e = at(b, c, t);
      return { point: at(d, e, t), left: [p0, a, d] as Point[], right: [e, c, p3] as Point[] };
    };
    const first = cut(u1);
    // Re-parameterise: the head has been shortened, so the second cut moves.
    const t = u0 / u1;
    const p0b = first.left[0] as Point;
    const c1b = first.left[1] as Point;
    const c2b = first.left[2] as Point;
    const p3b = first.point;
    const a = at(p0b, c1b, t);
    const b = at(c1b, c2b, t);
    const c = at(c2b, p3b, t);
    const d = at(a, b, t);
    const e = at(b, c, t);
    return [at(d, e, t), e, c, p3b];
  }

  const unitTo = (a: Point, b: Point): Point => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const gap = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  return polys.map((poly) => {
    const n = poly.length;
    if (n < 3) return "";

    // Each edge as a cubic in this cell's direction of travel, trimmed at both
    // ends to leave room for the corners. The trim is a fixed distance and the
    // arc is shared, so both owners of an edge trim it identically.
    const arc: [Point, Point, Point, Point][] = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % n];
      const c = curve.get(ekey(vkey(p), vkey(q)));
      const forward = c ? c.from === vkey(p) : true;
      const c1 = c ? (forward ? c.c1 : c.c2) : ([p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3] as Point);
      const c2 = c ? (forward ? c.c2 : c.c1) : ([p[0] + ((q[0] - p[0]) * 2) / 3, p[1] + ((q[1] - p[1]) * 2) / 3] as Point);
      const u = Math.min(0.34, corner / (gap(p, q) || 1));
      arc.push(slice(p, c1, c2, q, u, 1 - u));
    }

    const parts = [`M ${arc[0][0][0]} ${arc[0][0][1]}`];
    for (let i = 0; i < n; i++) {
      const [, a1, a2, end] = arc[i];
      parts.push(`C ${a1[0]} ${a1[1]} ${a2[0]} ${a2[1]} ${end[0]} ${end[1]}`);

      /* The corner. Its controls sit *past* the junction -- 1.6 times the
         distance to it -- along the tangents the two arcs arrive and leave on.
         That makes the join smooth in both directions and carries the outline
         a few units outside the point, which is what keeps three cells from
         opening a hole where they meet. */
      const vertex = poly[(i + 1) % n];
      const next = arc[(i + 1) % n];
      const into = unitTo(a2, end);
      const outOf = unitTo(next[0], next[1]);
      const reach = 1.6;
      const k1 = gap(end, vertex) * reach;
      const k2 = gap(next[0], vertex) * reach;
      parts.push(
        `C ${end[0] + into[0] * k1} ${end[1] + into[1] * k1}` +
          ` ${next[0][0] - outOf[0] * k2} ${next[0][1] - outOf[1] * k2}` +
          ` ${next[0][0]} ${next[0][1]}`,
      );
    }
    return `${parts.join(" ")} Z`;
  });
}
