/**
 * Deterministic layout for the goal graph, in three arrangements.
 *
 * This decides WHERE nodes live and WHAT regions are drawn behind them.
 * Nothing here runs per frame and nothing here is random: given the same
 * clusters and the same mode it returns the same coordinates, every time.
 * Motion is a separate concern (graphMotion.ts) that animates around these
 * positions -- which is what lets the graph feel physical without the layout
 * drifting between visits.
 *
 * Arrangement is the only thing that varies between views, because arrangement
 * is the one channel strong enough to carry a whole question:
 *
 *   areas      where does this sit in my life?   tiled regions per area
 *   hierarchy  how does this connect?            one band per level
 *   pace       where am I slipping?              four lanes, by ratio
 *
 * The dots carry no colour: a dot is a dot, and only its size says which level
 * it belongs to. The ground under them does -- regions tile the plane, and
 * their fill is what names the territory.
 */

import {
  type Point,
  type Rect,
  type Site,
  clampIntoPolygon,
  clipToRect,
  smoothTiling,
  powerCells,
  rectPolygon,
} from "./voronoi";

export type NodeKind = "goal" | "milestone" | "trackable";

export type ViewMode = "areas" | "hierarchy" | "pace";

export const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: "areas", label: "Areas" },
  { mode: "hierarchy", label: "Levels" },
  { mode: "pace", label: "Pace" },
];

/**
 * The axis each arrangement is read along, and therefore the one that is
 * spoken for.
 *
 * Levels stacks three bands and puts nothing above or below them: the whole
 * story is vertical, so the height is the thing to fit and the width is simply
 * however wide the tree turns out to be. It is NOT squeezed to the frame: a
 * level is a flat row of everything at that level, and compressing forty
 * trackables into one screen-width stacks them into rows that no longer read as
 * a level at all. So the band grows to whatever it needs and the view scrolls.
 * Pace is the transpose -- four lanes across, deep in
 * whatever direction the tree happens to be -- so the width is fitted and the
 * depth is where you scroll. Areas partitions the plane in both directions at
 * once and has no preferred axis, so it fits whole and pans freely.
 *
 * The fitted axis is not merely where the view starts. It stays covered: pans
 * and zooms are clamped so that axis can never be dragged off into empty
 * ground, which is what keeps "up and down" meaningful in Pace and "left and
 * right" meaningful in Levels.
 */
export const FIT_AXIS: Record<ViewMode, "both" | "width" | "height"> = {
  areas: "both",
  hierarchy: "height",
  pace: "width",
};

export interface GraphNode {
  key: string;
  kind: NodeKind;
  title: string;
  subtitle?: string;
  /** null = undeterminable. Reported in the rail, never painted on the dot. */
  health?: number | null;
  /** Sessions committed this week. Shown in the rail. */
  sessions?: number | null;
  fraction?: number | null;
  /**
   * pace.point / required_pace.point, rolled up for parents.
   * null means no signal -- there is nothing to compare against, which is not
   * the same as being on pace and is never folded into it.
   */
  paceRatio?: number | null;
  flags?: { estimated?: boolean; exploratory?: boolean; parked?: boolean };
  children: GraphNode[];
}

export interface Cluster {
  /** null is the Unassigned cluster -- unfiled work stays visible. */
  areaId: number | null;
  name: string;
  /** Tints this area's region. Never reaches the dots. */
  color: string;
  goals: GraphNode[];
}

/** What is expanded. Explicit state, never inferred from a zoom threshold. */
export type Focus =
  | { kind: "area"; areaId: number | null }
  | { kind: "goal"; key: string }
  | null;

export interface PlacedNode {
  node: GraphNode;
  /** 1 goal, 2 milestone, 3 trackable. */
  depth: number;
  x: number;
  y: number;
  radius: number;
  areaId: number | null;
  /** The region this node belongs to, and is clamped inside. */
  regionKey: string;
}

export interface PlacedEdge {
  key: string;
  from: string;
  to: string;
}

/**
 * A patch of ground with a meaning.
 *
 * Regions partition the plane, not a window. Painting them only as far as the
 * nodes reach would put a hard edge in the middle of the view the moment you
 * zoomed out or panned, and territory that stops is territory that reads as
 * having run out -- so `points` runs far past anything the viewport can show,
 * and the boundaries between regions are the only edges you ever see.
 *
 * `core` is the same region trimmed back to the canvas. Nodes live there and
 * are clamped to it; the extension is purely something to look at.
 */
export interface Region {
  key: string;
  label: string;
  /** Polygon to paint. Extends well past any reachable zoom or pan. */
  points: Point[];
  /** The part of it nodes may occupy. */
  core: Point[];
  labelX: number;
  labelY: number;
  /** How the caption sits on labelX. A band hangs its name off the left edge;
      a lane or a cell centres it over the column it describes. */
  align: "start" | "middle";
  /**
   * Which axis the caption is nailed to the viewport on, if any.
   *
   * A band's name is a fact about the whole band, not about the part of it you
   * happen to be looking at -- so it must not scroll away along the axis the
   * band runs in. Levels runs sideways and pins its captions to the left edge;
   * Pace runs downward and pins its lane names to the top. The other axis still
   * tracks the content, so the label stays attached to the thing it names.
   *
   * An area's caption is unpinned: it sits over its own clump, which is a
   * place on the map rather than a strip of it.
   */
  pin?: "left" | "top";
  /**
   * Cell boundaries are arbitrary -- a bisector between two clumps -- so they
   * are drawn as curves that sweep through the junctions. A lane or a band
   * boundary is a threshold, and a threshold that wanders is a lie about where
   * it sits, so those stay straight.
   */
  shape: "cell" | "rect";
  /** The outline as an SVG path. Cells share their curves with their
      neighbours, so the tiling survives the smoothing exactly. */
  path: string;
  /** CSS colour for the fill, and how faint to keep it. */
  fill: string;
  fillOpacity: number;
  /** Set only in the Areas view, where clicking a region focuses that area. */
  areaId?: number | null;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  regions: Region[];
  /** The rectangle the arrangement partitions. The view anchors to it. */
  canvas: Rect;
  /** Half-extents per axis, for fitting. Constant: regions tile the canvas. */
  extentX: number;
  extentY: number;
}

/* ----------------------------------------------------------------- geometry */

/**
 * How much of each cell edge is given over to easing the junction it runs into.
 *
 * The corners bulge past the junction rather than cutting back from it, so this
 * is also how far three cells overlap where they meet -- small enough that the
 * overlap reads as a slight warmth in the wash rather than as a shape.
 */
const CELL_CORNER = 10;

/**
 * Half the width a goal's title takes at rest.
 *
 * GraphMark truncates to 22 characters at 10px, so this is that at its widest.
 */
const GOAL_LABEL_REACH = 64;

/**
 * The largest fan still laid out as a single ring.
 *
 * Past this a ring is worse than a disc: the radius needed to keep the dots
 * apart grows linearly with the count, so a goal with forty trackables would
 * throw them onto a circle wider than its own area.
 */
const RING_MAX = 12;

/**
 * Size is the whole level signal now that the dots carry no colour.
 *
 * The deep two are smaller than they were. A milestone at 6.5 and a trackable
 * at 5 are barely a step apart, and more to the point they leave a goal's fan
 * no room to be a ring rather than a clump -- which is what the Areas view is
 * for. Shrinking them buys both the separation and the space.
 */
const RADIUS: Record<NodeKind, number> = { goal: 9, milestone: 5, trackable: 3 };
const DEPTH: Record<NodeKind, number> = { goal: 1, milestone: 2, trackable: 3 };

/**
 * How far past the canvas the regions are painted.
 *
 * Zoom bottoms out at 0.25 (usePanZoom) and panning is unbounded, so there is
 * no exact number that is always enough. This is simply far enough that no
 * plausible viewport reaches the end of it, and the polygons cost four points
 * each either way.
 */
const FIELD = 40;

function fieldFor(canvas: Rect): Rect {
  const w = (canvas.x1 - canvas.x0) * FIELD;
  const h = (canvas.y1 - canvas.y0) * FIELD;
  return { x0: -w / 2, y0: -h / 2, x1: w / 2, y1: h / 2 };
}

/**
 * How faint a region fill sits.
 *
 * These are washes behind white dots on a near-black ground, covering whole
 * quadrants of the screen rather than a tag on a quiet one -- anything you
 * could comfortably read as a colour on its own is far too loud at this size.
 * But they still have a job: an area you cannot tell from its neighbour is not
 * carrying anything. So they sit just above the floor of visible, and the
 * boundary stroke does the rest of the work.
 */
const WASH_AREA = 0.08;
const WASH_LANE = 0.075;
/** For the two lanes that should not pull the eye: no signal, and ahead. */
const WASH_LANE_QUIET = 0.05;
/** One hue deepening with depth. A ladder, not three categories. */
const WASH_BAND = [0.03, 0.065, 0.1];

/** Clear space between two dots. Below this they read as one blob. */
export const NODE_GAP = 7;

/**
 * How far an area's boundary is kept off the work inside it.
 *
 * A dot sitting on a border reads as belonging to whichever side you looked at
 * first, and the wash behind it stops meaning anything. This is the distance
 * that has to exist between the outermost dot of an area and the line drawn
 * around it -- so it sets both how far apart the clumps are pushed and how far
 * each power site outweighs its own reach.
 */
const AREA_CLEARANCE = 34;
/** Centre-to-centre room one dot needs at its tightest. */
const PITCH = 2 * RADIUS.goal + NODE_GAP;
/** Golden angle: successive points never line up, so clumps look grown. */
const PHI = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;

/** The drawing area at the size a small tree wants. Landscape, as the frame is. */
const BASE_W = 1180;
const BASE_H = 660;
const AREA_RING = 196;

/**
 * The rectangle every mode partitions, sized to what it has to hold.
 *
 * A fixed canvas was fine while the tree was small and wrong as soon as it was
 * not: past a few hundred dots there is simply no arrangement that keeps them
 * all apart, and the separation pass burns its whole iteration budget failing
 * to find one. Growing the ground with the square root of the total footprint
 * holds density constant instead, so the same relaxation converges whatever
 * size the tree reaches. Small trees are unaffected -- the scale floors at 1.
 */
function canvasFor(clusters: Cluster[]): Rect {
  let need = 0;
  clusters.forEach((c) =>
    eachNode(c.goals, (n) => {
      need += (2 * RADIUS[n.kind] + NODE_GAP) ** 2;
    }),
  );
  // Several times the bare footprint: dots need room to breathe, and the lanes
  // and bands spend height on structure rather than on packing.
  const scale = Math.max(1, Math.sqrt((need * 5.5) / (BASE_W * BASE_H)));
  const w = BASE_W * scale;
  const h = BASE_H * scale;
  return { x0: -w / 2, y0: -h / 2, x1: w / 2, y1: h / 2 };
}

/**
 * How wide a clump has to be to hold everything inside it.
 *
 * The old fixed radii per depth suited six goals and buried sixty. Scaling with
 * the square root of the subtree keeps the density of a clump the same however
 * lopsided the tree is -- and matches how the canvas itself grows, so the two
 * never drift apart.
 */
function clumpRadius(count: number): number {
  return PITCH * Math.sqrt(Math.max(count, 1)) * 0.75;
}

/**
 * A stable angle in [0, TAU) derived from a node's key.
 *
 * This is what makes the Areas arrangement look organic without being random:
 * the seed is a hash of an id, so it is identical on every visit, but
 * neighbouring clumps are rotated differently and nothing lines up into rows.
 */
function seedAngle(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * TAU;
}

/** Only the cell itself and these four need testing; the rest are symmetric. */
const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Push dots apart, keeping each one inside its own region.
 *
 * The two corrections have to run together rather than one after the other.
 * Separating first and clamping afterwards puts every dot back in the right
 * region but shoves the crowded ones straight back into each other -- and
 * overlapping dots are the one thing that makes a graph unreadable, because
 * two nodes become one blob and the count is silently wrong. Interleaving lets
 * the separation carry on solving under the constraint instead of having its
 * answer overwritten.
 *
 * Candidates come from a uniform grid rather than every pair. No dot can reach
 * further than one cell, so the eight neighbours hold every possible collision
 * -- which turns a pass from quadratic into linear and is what makes running
 * hundreds of them affordable at all.
 *
 * Fixed iteration count, fixed cell order, fixed order within a cell: as
 * deterministic as the placement it corrects.
 */
function relax(nodes: PlacedNode[], regions: Region[], canvas: Rect): void {
  // The painted polygon runs far off-screen; `core` is the part a node may
  // occupy, so that is what bounds it.
  const byRegion = new Map(regions.map((r) => [r.key, r.core]));

  let maxR = 0;
  for (const p of nodes) maxR = Math.max(maxR, p.radius);
  const cell = 2 * maxR + NODE_GAP;
  // Generous margin: relaxation may push a dot past the canvas edge before the
  // clamp reels it back, and a stray index would silently drop collisions.
  const pad = cell * 4;
  const cols = Math.max(1, Math.ceil((canvas.x1 - canvas.x0 + 2 * pad) / cell));
  const rows = Math.max(1, Math.ceil((canvas.y1 - canvas.y0 + 2 * pad) / cell));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);

  const colOf = (x: number) =>
    Math.min(cols - 1, Math.max(0, Math.floor((x - canvas.x0 + pad) / cell)));
  const rowOf = (y: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor((y - canvas.y0 + pad) / cell)));

  /** Separate `a` from `b` if they touch. Returns true if either moved. */
  function push(a: PlacedNode, b: PlacedNode): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const min = a.radius + b.radius + NODE_GAP;
    const d = Math.hypot(dx, dy);
    if (d >= min) return false;
    if (d < 1e-6) {
      // Exactly coincident: nudge along a fixed axis rather than a random one,
      // or the result would differ between runs.
      a.x -= min / 2;
      b.x += min / 2;
      return true;
    }
    const shove = (min - d) / 2;
    a.x -= (dx / d) * shove;
    a.y -= (dy / d) * shove;
    b.x += (dx / d) * shove;
    b.y += (dy / d) * shove;
    return true;
  }

  for (let pass = 0; pass < 400; pass++) {
    let moved = false;

    for (const b of buckets) b.length = 0;
    for (let i = 0; i < nodes.length; i++) {
      buckets[rowOf(nodes[i].y) * cols + colOf(nodes[i].x)].push(i);
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const here = buckets[r * cols + c];
        if (here.length === 0) continue;
        for (let a = 0; a < here.length; a++) {
          for (let b = a + 1; b < here.length; b++) {
            if (push(nodes[here[a]], nodes[here[b]])) moved = true;
          }
          for (const [dc, dr] of NEIGHBOURS) {
            const nc = c + dc;
            const nr = r + dr;
            if (nc < 0 || nc >= cols || nr >= rows) continue;
            for (const j of buckets[nr * cols + nc]) {
              if (push(nodes[here[a]], nodes[j])) moved = true;
            }
          }
        }
      }
    }

    for (const p of nodes) {
      const poly = byRegion.get(p.regionKey);
      if (!poly || poly.length < 3) continue;
      const [x, y] = clampIntoPolygon(p.x, p.y, poly, p.radius + 3);
      if (Math.abs(x - p.x) > 1e-9 || Math.abs(y - p.y) > 1e-9) moved = true;
      p.x = x;
      p.y = y;
    }
    if (!moved) return;
  }
}

/* -------------------------------------------------------------- tree walking */

/** Parent -> child edges for the whole forest, plus a parent lookup. */
function collectEdges(roots: GraphNode[], parentKey?: string) {
  const edges: PlacedEdge[] = [];
  const walk = (node: GraphNode, from?: string) => {
    if (from) edges.push({ key: `${from}->${node.key}`, from, to: node.key });
    node.children.forEach((c) => walk(c, node.key));
  };
  roots.forEach((r) => walk(r, parentKey));
  return edges;
}

function eachNode(roots: GraphNode[], fn: (n: GraphNode) => void) {
  const walk = (n: GraphNode) => {
    fn(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
}

/**
 * The forest with everything below `maxDepth` cut off.
 *
 * Levels opens showing two of its three rows, and the row it is NOT showing
 * must not be laid out either. Width is shared out by subtree, so leaving the
 * trackables in the measurement would hand a goal with thirty of them six times
 * the room of a goal with five -- while the screen shows the same two dots
 * under each. The gaps would be arguing about work that is not on display.
 *
 * Cutting instead means the visible rows share the width between themselves,
 * and the mass that gets centred is the mass you can actually see.
 */
function pruneToDepth(roots: GraphNode[], maxDepth: number): GraphNode[] {
  return roots
    .filter((n) => DEPTH[n.kind] <= maxDepth)
    .map((n) => ({ ...n, children: pruneToDepth(n.children, maxDepth) }));
}

function countNodes(roots: GraphNode[]): number {
  let n = 0;
  eachNode(roots, () => n++);
  return n;
}

interface Parts {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  regions: Region[];
  /** Set by an arrangement that needs more ground than the shared canvas. */
  canvas?: Rect;
}


/* ------------------------------------------------------------------- areas */

/**
 * Organic clumps inside a weighted Voronoi.
 *
 * Sites sit on the ellipse the clumps have always used, and each site's weight
 * grows with how much work its area holds -- so a crowded area claims more
 * ground, and the regions add up to the whole canvas with nothing spare.
 *
 * The clumps are then planted on the CELL CENTROIDS rather than on the sites.
 * A site only decides where the boundaries fall; its cell can extend a long
 * way to one side, and a clump left sitting on the site ends up hard against
 * its own border with the rest of its territory empty. Centroids put the work
 * in the middle of the ground it owns, which is the whole claim the view makes.
 */
function layoutAreas(clusters: Cluster[], base: Rect): Parts {
  const nodes: PlacedNode[] = [];
  const n = Math.max(clusters.length, 1);
  // The ring rides the canvas, which is itself sized to the tree -- so the
  // clumps and the ground they sit on grow together instead of drifting apart.
  const zoom = (base.x1 - base.x0) / BASE_W;
  const ring = AREA_RING * zoom * (n <= 2 ? 0.55 : n <= 4 ? 0.85 : 1);
  // An ellipse rather than a circle: the frame is landscape, and a circular
  // arrangement leaves the left and right thirds permanently empty.
  const ELLIPSE_X = 1.55;
  const ELLIPSE_Y = 0.82;

  /* A rough seed only. Where each area really sits is not known until its dots
     have been placed and separated, so nothing is decided from this. */
  const centres: Point[] = clusters.map((_, ci) => {
    const a = -Math.PI / 2 + (ci * TAU) / n;
    return [Math.cos(a) * ring * ELLIPSE_X, Math.sin(a) * ring * ELLIPSE_Y];
  });

  /** Places a node, then fans its children around it. */
  function place(node: GraphNode, cx: number, cy: number, cluster: Cluster) {
    nodes.push({
      node,
      depth: DEPTH[node.kind],
      x: cx,
      y: cy,
      radius: RADIUS[node.kind],
      areaId: cluster.areaId,
      regionKey: `area:${cluster.areaId}`,
    });

    const kids = node.children;
    if (kids.length === 0) return;
    // Sized to the whole subtree, not to the number of children: a child that
    // is itself a big branch needs the room its own descendants will take.
    const spread = clumpRadius(countNodes(kids));
    const seed = seedAngle(node.key);

    /* A ring while the fan is small enough to be one, a disc once it is not.
       The sunflower below distributes over an AREA, which is right for sixty
       children and wrong for five: five land at five different radii and read
       as a clump rather than as a level of the tree. Each parent opens its ring
       at its own seed angle, so no two rings line up into rows across the map. */
    if (kids.length <= RING_MAX) {
      const r = Math.max(spread, (kids.length * PITCH) / TAU, PITCH);
      kids.forEach((child, i) => {
        const a = seed + (i * TAU) / kids.length;
        place(child, cx + Math.cos(a) * r, cy + Math.sin(a) * r, cluster);
      });
      return;
    }

    kids.forEach((child, i) => {
      // Sunflower packing: even spacing, no visible rows or shared arcs.
      const a = seed + i * PHI;
      const r = spread * (Math.sqrt((i + 0.6) / kids.length) + 0.45);
      place(child, cx + Math.cos(a) * r, cy + Math.sin(a) * r, cluster);
    });
  }

  clusters.forEach((cluster, ci) => {
    const [ox, oy] = centres[ci];
    const seed = seedAngle(`area:${cluster.areaId}`);
    const spread = clumpRadius(countNodes(cluster.goals));
    cluster.goals.forEach((goal, gi) => {
      const ga = seed + gi * PHI;
      const gr =
        cluster.goals.length === 1
          ? 0
          : spread * (Math.sqrt((gi + 0.6) / cluster.goals.length) + 0.5);
      place(goal, ox + Math.cos(ga) * gr, oy + Math.sin(ga) * gr, cluster);
    });
  });

  /* Settle the dots BEFORE there is any ground to hold them in. Passing no
     regions leaves relax doing separation only -- which is the whole point of
     the order: previously the cells were cut first and every dot was then
     clamped inside whichever one it had been assigned, so the boundaries
     decided the arrangement and the work was pushed around to suit them. */
  relax(nodes, [], base);

  /* Now cut the ground to fit. Each area becomes a weighted site sitting on the
     centre of mass of its own settled dots, weighted by how far its outermost
     dot actually reaches. In a power diagram the boundary between two sites
     moves away from the heavier one, so weighting by reach puts every boundary
     outside the dots on both sides of it -- the border takes the shape the work
     has already taken, rather than the work being pressed into a border. */
  const owned = clusters.map((c) => nodes.filter((p) => p.areaId === c.areaId));

  /* Measure what each area actually became: the centre of mass of its dots,
     and how far the outermost one reaches from it. */
  const hub: Point[] = [];
  const weight: number[] = [];
  clusters.forEach((_, ci) => {
    const own = owned[ci];
    if (own.length === 0) {
      hub.push([centres[ci][0], centres[ci][1]]);
      weight.push(PITCH);
      return;
    }
    let cx = 0;
    let cy = 0;
    for (const p of own) {
      cx += p.x;
      cy += p.y;
    }
    cx /= own.length;
    cy /= own.length;
    let far = 0;
    for (const p of own) far = Math.max(far, Math.hypot(p.x - cx, p.y - cy) + p.radius);
    hub.push([cx, cy]);
    weight.push(far + AREA_CLEARANCE);
  });

  /* Now open up enough room between areas for a boundary to fit between them,
     measured from what they actually became rather than from an estimate made
     before they existed.
     ...
     Twice the LARGER radius, not the sum of the two. The bisector between two
     equally weighted sites lands halfway, so half the gap has to clear the
     bigger of the pair; the sum would seat the line inside it. Weighting then
     tilts the boundary away from the busier area, and it is a short proof that
     the tilt never overshoots the other side -- so both stay clear either way.
     Each area moves as ONE piece: the dots have already been separated among
     themselves, and shifting them together keeps that arrangement intact. */
  for (let pass = 0; pass < 300; pass++) {
    let moved = false;
    for (let i = 0; i < hub.length; i++) {
      for (let j = i + 1; j < hub.length; j++) {
        const dx = hub[j][0] - hub[i][0];
        const dy = hub[j][1] - hub[i][1];
        const min = 2 * Math.max(weight[i], weight[j]);
        const d = Math.hypot(dx, dy);
        if (d >= min) continue;
        // Coincident hubs separate along a fixed axis, never a random one.
        const [ux, uy] = d < 1e-6 ? [1, 0] : [dx / d, dy / d];
        const shove = (min - d) / 2;
        hub[i][0] -= ux * shove;
        hub[i][1] -= uy * shove;
        hub[j][0] += ux * shove;
        hub[j][1] += uy * shove;
        moved = true;
      }
    }
    if (!moved) break;
  }

  clusters.forEach((_, ci) => {
    const own = owned[ci];
    if (own.length === 0) return;
    let cx = 0;
    let cy = 0;
    for (const p of own) {
      cx += p.x;
      cy += p.y;
    }
    const dx = hub[ci][0] - cx / own.length;
    const dy = hub[ci][1] - cy / own.length;
    for (const p of own) {
      p.x += dx;
      p.y += dy;
    }
  });

  const sites: Site[] = clusters.map((cluster, ci) => ({
    key: `area:${cluster.areaId}`,
    x: hub[ci][0],
    y: hub[ci][1],
    weight: weight[ci],
  }));

  /* The ground is sized to where the dots ended up, not guessed in advance. */
  let half = Math.max((base.x1 - base.x0) / 2, (base.y1 - base.y0) / 2);
  for (const p of nodes) {
    half = Math.max(half, Math.abs(p.x) + p.radius, Math.abs(p.y) + p.radius);
  }
  const pad = AREA_CLEARANCE + 40;
  const canvas: Rect = { x0: -half - pad, y0: -half - pad, x1: half + pad, y1: half + pad };

  /* Cells are cut over the field, not the canvas. A bisector does not care
     where you stop drawing it, so the boundaries land in exactly the same
     place either way -- the cells simply carry on outward, which is what keeps
     an area's ground under it however far you zoom out. */
  const field = fieldFor(canvas);
  const cells = powerCells(sites, field);
  const regions: Region[] = clusters.map((cluster) => {
    const points = cells.get(`area:${cluster.areaId}`) ?? rectPolygon(field);
    return {
      key: `area:${cluster.areaId}`,
      label: cluster.name,
      points,
      core: clipToRect(points, canvas),
      labelX: 0,
      labelY: 0,
      align: "middle",
      shape: "cell",
      path: "",
      // An area is a category, so it gets a category's colour -- the same
      // series token the rest of the app already files it under.
      fill: cluster.color,
      fillOpacity: WASH_AREA,
      areaId: cluster.areaId,
    };
  });

  /*
   * One rule for every caption: centred on its own clump, sitting just above
   * it.
   *
   * Uniformity is the whole point. A caption that hunts for somewhere it fits
   * ends up in a different relationship to its ground in every cell -- one
   * hugging an edge, one floating in the middle -- and then none of them reads
   * as belonging to anything in particular. Measured from the dots rather than
   * from the cell, because the dots are what the name is actually naming, and
   * clamped back inside the cell in the rare case that a clump sits so high
   * there is no room above it.
   */
  regions.forEach((region, ci) => {
    const own = owned[ci];
    if (own.length === 0) return;
    let cx = 0;
    let top = Infinity;
    for (const p of own) {
      cx += p.x;
      top = Math.min(top, p.y - p.radius);
    }
    const [lx, ly] = clampIntoPolygon(cx / own.length, top - 30, region.core, 26);
    region.labelX = lx;
    region.labelY = ly;
  });

  return {
    nodes,
    edges: collectEdges(clusters.flatMap((c) => c.goals)),
    regions,
    canvas,
  };
}

/* --------------------------------------------------------------- hierarchy */

/**
 * The bands, top to bottom. Areas are deliberately not among them.
 *
 * An area is not a level of the work -- it is the filing cabinet the work sits
 * in, and the Areas view already answers where something lives. Giving it a
 * band here bought a row of five dots whose only job was to fan out to the
 * goals directly beneath them, which is a question nobody was asking in a view
 * about how the work itself nests.
 */
const BANDS: { kind: NodeKind; label: string }[] = [
  { kind: "goal", label: "Goals" },
  { kind: "milestone", label: "Milestones" },
  { kind: "trackable", label: "Trackables" },
];
/** Keeps the outermost dot and its label clear of the frame. */
const BAND_MARGIN = 30;
/**
 * Pitch for the band that is always named.
 *
 * Goals carry their titles at rest (GraphMark shows a label at depth <= 1),
 * and a title is far wider than the dot under it. Spacing them by the dot
 * alone stacks four names into an unreadable smear, so that band is spaced for
 * the label and wraps to a second row sooner instead.
 */
const LABEL_PITCH = 96;

/**
 * One band per level, with the horizontal room shared out by SUBTREE.
 *
 * This is the whole of the arrangement, and it replaced a barycentre sort with
 * a packing pass because that could not do the one thing the view is for.
 * Barycentres put each node near its relatives and then centred each level on
 * the midpoint of its own extremes -- which is not the middle of its mass, and
 * is a different midpoint for every level, so the bands slid relative to one
 * another and the work piled up on whichever side happened to be busiest.
 *
 * Allocating width instead makes the geometry carry the count: every leaf is
 * given the same slice, a parent is given the sum of its children's, and each
 * node sits at the centre of its own slice. Three properties follow, and all
 * three are things the previous version only approximated:
 *
 *   a parent is exactly above the middle of its children, at every level;
 *   sibling subtrees never interleave, because their slices do not overlap;
 *   equal leaf mass ends up either side of centre, because equal leaf COUNT
 *     is what the width was divided by in the first place.
 */
function layoutHierarchy(clusters: Cluster[], base: Rect): Parts {
  const roots = clusters.flatMap((c) => c.goals);
  const edges = collectEdges(roots);

  /* What one node needs to itself. Goals carry their title at rest and a title
     is far wider than the dot under it, so that band is spaced for the words. */
  const own = (node: GraphNode) =>
    DEPTH[node.kind] === 1 ? LABEL_PITCH : 2 * RADIUS[node.kind] + NODE_GAP + 8;

  /* What a node needs including everything under it. A node is never narrower
     than its own children laid side by side, and never narrower than itself. */
  const width = new Map<string, number>();
  const measure = (node: GraphNode): number => {
    const kids = node.children.reduce((sum, c) => sum + measure(c), 0);
    const w = Math.max(own(node), kids);
    width.set(node.key, w);
    return w;
  };
  const total = roots.reduce((sum, r) => sum + measure(r), 0);

  const x = new Map<string, number>();
  /** Lay `node` into the slice starting at `left`, and its children inside it. */
  const place = (node: GraphNode, left: number) => {
    const w = width.get(node.key)!;
    x.set(node.key, left + w / 2);
    const kids = node.children.reduce((sum, c) => sum + width.get(c.key)!, 0);
    // Children centred in the slice: a parent wider than its own children (a
    // goal with one milestone under it) must not shunt them to one side.
    let cursor = left + (w - kids) / 2;
    for (const child of node.children) {
      place(child, cursor);
      cursor += width.get(child.key)!;
    }
  };
  let cursor = 0;
  for (const root of roots) {
    place(root, cursor);
    cursor += width.get(root.key)!;
  }

  /* Centred on the LEAVES, not on the drawing.
     ...
     Width per leaf is equal, so the middle of the allocation would be the
     middle of the mass -- except that a goal is never narrower than its own
     title, and a goal carrying two trackables is therefore given more room than
     two trackables need. Enough sparse goals on one side and the deepest band,
     which is where the work actually is, drifts off centre while the picture
     still looks evenly filled. Measuring the mass and centring on that is the
     only thing that puts equal work either side of the middle. */
  /* "Deepest" is whatever the arrangement was asked to lay out, not whatever
     the data happens to contain -- so a view showing two rows balances the
     milestones, and the same view once opened balances the trackables. */
  const leaves: number[] = [];
  let deepest = 1;
  eachNode(roots, (n) => (deepest = Math.max(deepest, DEPTH[n.kind])));
  eachNode(roots, (n) => {
    if (DEPTH[n.kind] === deepest) leaves.push(x.get(n.key)!);
  });
  const offset = leaves.length === 0
    ? -total / 2
    : -leaves.reduce((a, b) => a + b, 0) / leaves.length;
  for (const [key, at] of x) x.set(key, at + offset);

  /* The ground is as wide as the tree turns out to be, and symmetric about
     zero because everything downstream -- the fit, the extents, the pan clamp
     -- measures from there. Everything at one level belongs on ONE line, which
     is what makes it a level; wrapping it into rows would turn a flat row of
     work into a block whose shape means nothing. So the canvas grows sideways
     and the view scrolls. */
  const reach = Math.max(Math.abs(offset), Math.abs(total + offset));
  const canvasW = Math.max(2 * reach + 2 * BAND_MARGIN, base.x1 - base.x0);
  const canvas: Rect = { x0: -canvasW / 2, y0: base.y0, x1: canvasW / 2, y1: base.y1 };

  const bandH = (canvas.y1 - canvas.y0) / BANDS.length;
  const field = fieldFor(canvas);
  const regions: Region[] = BANDS.map((band, l) => {
    const y0 = canvas.y0 + l * bandH;
    const core = { x0: canvas.x0, y0, x1: canvas.x1, y1: y0 + bandH };
    return {
      key: `band:${l}`,
      label: band.label,
      // Full field width, and the outermost bands run off the top and bottom:
      // a level does not stop existing where the last dot in it happens to sit.
      points: rectPolygon({
        x0: field.x0,
        y0: l === 0 ? field.y0 : core.y0,
        x1: field.x1,
        y1: l === BANDS.length - 1 ? field.y1 : core.y1,
      }),
      core: rectPolygon(core),
      labelX: canvas.x0 + 22,
      labelY: y0 + 20,
      align: "start",
      pin: "left",
      shape: "rect",
      path: "",
      /* One hue across all three, deepening with the level. Depth is a ladder,
         not a set of categories, and three separate colours would claim these
         bands differ in kind rather than in how far down you have gone. */
      fill: "var(--color-accent)",
      fillOpacity: WASH_BAND[l],
    };
  });

  const areaOf = new Map<string, number | null>();
  clusters.forEach((c) => eachNode(c.goals, (n) => areaOf.set(n.key, c.areaId)));

  const nodes: PlacedNode[] = [];
  eachNode(roots, (node) => {
    const l = DEPTH[node.kind] - 1;
    nodes.push({
      node,
      depth: DEPTH[node.kind],
      x: x.get(node.key) ?? 0,
      // Mid-band, below the caption row that rides at the top of every band.
      y: canvas.y0 + l * bandH + 26 + (bandH - 34) / 2,
      radius: RADIUS[node.kind],
      areaId: areaOf.get(node.key) ?? null,
      regionKey: `band:${l}`,
    });
  });

  return { nodes, edges, regions, canvas };
}

/* -------------------------------------------------------------------- pace */

/** Below this you are off pace; above the upper bound you are ahead. */
const OFF_PACE = 0.9;
const AHEAD = 1.1;
/** The top of the vertical scale in the Ahead lane. */
export const RATIO_CEILING = 2;

/**
 * The lanes, left to right, with the ground each one stands on.
 *
 * The ramp reads red, amber, green from behind to comfortable -- the same
 * order the old node colouring used, so the meaning of a hue has not moved
 * even though what carries it has. On pace is amber rather than green on
 * purpose: hitting the required rate exactly means no slack at all, and one
 * missed session puts you in the lane to its left.
 *
 * No signal is grey, never green. Undetermined is not "fine" (P2), and it
 * stays chromatically outside the ramp so it cannot be read as a position on
 * it.
 */
const LANES: {
  key: string;
  label: string;
  share: number;
  lo: number;
  hi: number;
  fill: string;
  wash: number;
}[] = [
  // Narrow, because it is a list of work with nothing to measure rather than a
  // spectrum -- but present, because folding it into "on pace" would assert
  // something the data does not support.
  {
    key: "lane:none", label: "No signal", share: 0.16, lo: 0, hi: 0,
    fill: "var(--color-faint)", wash: WASH_LANE_QUIET,
  },
  {
    key: "lane:off", label: "Off pace", share: 0.28, lo: 0, hi: OFF_PACE,
    fill: "var(--color-bad)", wash: WASH_LANE,
  },
  {
    key: "lane:on", label: "On pace", share: 0.28, lo: OFF_PACE, hi: AHEAD,
    fill: "var(--color-warn)", wash: WASH_LANE,
  },
  {
    key: "lane:ahead", label: "Ahead", share: 0.28, lo: AHEAD, hi: RATIO_CEILING,
    // Faintest of the three: the lane you want to be in should be the quietest
    // on the screen, not the one that pulls the eye away from the trouble.
    fill: "var(--color-good)", wash: WASH_LANE_QUIET,
  },
];

export function laneIndex(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio)) return 0;
  if (ratio < OFF_PACE) return 1;
  if (ratio <= AHEAD) return 2;
  return 3;
}

/**
 * Four lanes, left to right.
 *
 * Lanes are buckets, and bucketing a continuous value throws away the
 * difference between "slightly behind" and "about to miss". So the raw ratio
 * survives as height within the lane: further up is further ahead.
 */
function layoutPace(clusters: Cluster[], canvas: Rect): Parts {
  const all: { node: GraphNode; areaId: number | null }[] = [];
  clusters.forEach((c) => eachNode(c.goals, (node) => all.push({ node, areaId: c.areaId })));

  const field = fieldFor(canvas);
  let left = canvas.x0;
  const regions: Region[] = [];
  const laneRect: Rect[] = [];
  LANES.forEach((lane, i) => {
    const w = (canvas.x1 - canvas.x0) * lane.share;
    const rect = { x0: left, y0: canvas.y0, x1: left + w, y1: canvas.y1 };
    laneRect.push(rect);
    regions.push({
      key: lane.key,
      label: lane.label,
      // Full field height, and the outer lanes run off the sides: being off
      // pace is a state, not a box, and the ground for it does not end.
      points: rectPolygon({
        x0: i === 0 ? field.x0 : rect.x0,
        y0: field.y0,
        x1: i === LANES.length - 1 ? field.x1 : rect.x1,
        y1: field.y1,
      }),
      core: rectPolygon(rect),
      labelX: left + w / 2,
      /* Above the ground, not on it. Placement leaves the top of the lane
         clear, but separation does not know about captions: a crowded lane
         cannot hold every dot at the height its ratio asks for, and what it
         does with the overflow is push upward. Clamping cannot help either --
         there is genuinely no arrangement that fits -- so the caption gets out
         of the way instead, and the view anchors high enough to show it. */
      labelY: canvas.y0 - 20,
      align: "middle",
      pin: "top",
      shape: "rect",
      path: "",
      fill: lane.fill,
      fillOpacity: lane.wash,
    });
    left += w;
  });

  const nodes: PlacedNode[] = [];
  LANES.forEach((lane, li) => {
    const rect = laneRect[li];
    const members = all.filter((m) => laneIndex(m.node.paceRatio) === li);
    // Sorted by ratio so height reads monotonically down the lane; the key
    // breaks ties so the order is stable across reloads.
    members.sort(
      (a, b) =>
        (b.node.paceRatio ?? 0) - (a.node.paceRatio ?? 0) ||
        a.node.key.localeCompare(b.node.key),
    );

    const width = rect.x1 - rect.x0;
    const step = 2 * RADIUS.goal + NODE_GAP + 8;
    /* The lanes do not have to fit the window -- the view opens at the top of
       the ground and scrolls down -- so the room above the first row costs
       nothing and keeps the leaders clear of the caption above them. */
    const top = rect.y0 + 46;
    const height = rect.y1 - rect.y0 - 56;

    /* Height is the ratio, so a run of identical ratios wants one line -- and
       an exact tie is common, since a whole goal's trackables can share a
       commitment. Stacking them there would leave separation to pry apart a
       pile from a standing start, which it only ever half-manages. Tied nodes
       have no order to preserve, so they spread across the lane at their shared
       height, and over extra tiers around it once one line is not enough.

       Each run is laid out on its own and centred, rather than carrying on a
       column counter from the run before: a run that inherited the count would
       start wherever the previous one happened to stop, and the lane would read
       as a ragged left-hand margin instead of a column of heights. */
    const centre = (rect.x0 + rect.x1) / 2;
    const slot = new Map<number, { dx: number; tier: number; pitch: number }>();
    let tierStep = step;
    for (let i = 0; i < members.length; ) {
      let j = i;
      while (
        j < members.length &&
        (members[j].node.paceRatio ?? null) === (members[i].node.paceRatio ?? null)
      ) {
        j++;
      }
      const run = j - i;
      /* Two named nodes side by side need room for the names, not just for the
         dots. Goals carry their title at rest, so a run holding more than one
         of them is spaced for the text and wraps to another tier sooner --
         otherwise the titles overlap into an unreadable smear at exactly the
         ratio you were trying to read. */
      const named = members.slice(i, j).filter((m) => DEPTH[m.node.kind] <= 1).length;
      const pitch = named > 1 ? Math.max(step, LABEL_PITCH) : step;
      const perRow = Math.max(1, Math.min(run, Math.floor(width / pitch) || 1));
      const tiers = Math.ceil(run / perRow);
      for (let k = i; k < j; k++) {
        const t = Math.floor((k - i) / perRow);
        // The last tier is usually short; centre it on its own width, not on a
        // full row's, or it hangs off to one side.
        const wide = Math.min(perRow, run - t * perRow);
        slot.set(k, {
          dx: ((k - i) % perRow) - (wide - 1) / 2,
          tier: t - (tiers - 1) / 2,
          pitch,
        });
      }
      // A fan taller than the lane is worse than a tight one: the clamp would
      // squash it back into a pile and the separation would start from the
      // same standing pile it was meant to avoid.
      if (tiers > 1) tierStep = Math.min(tierStep, height / (tiers - 1));
      i = j;
    }

    members.forEach((m, i) => {
      const { dx, tier, pitch } = slot.get(i)!;
      let y: number;
      if (li === 0) {
        // No ratio to encode, so spread evenly rather than pretending to.
        y = top + (members.length === 1 ? 0.5 : i / (members.length - 1)) * height;
      } else {
        const r = Math.min(Math.max(m.node.paceRatio ?? lane.lo, lane.lo), lane.hi);
        // Each lane maps its own range over the full height, so a bucket two
        // tenths wide still resolves the difference inside it.
        const t = 1 - (r - lane.lo) / (lane.hi - lane.lo || 1);
        y = top + t * height + tier * tierStep;
      }
      nodes.push({
        node: m.node,
        depth: DEPTH[m.node.kind],
        x: centre + dx * pitch,
        y,
        radius: RADIUS[m.node.kind],
        areaId: m.areaId,
        regionKey: lane.key,
      });
    });
  });

  return { nodes, edges: collectEdges(clusters.flatMap((c) => c.goals)), regions };
}

/* ------------------------------------------------------------------ public */

/**
 * The whole graph, always.
 *
 * Layout deliberately does NOT depend on focus. Everything is drawn at rest and
 * focus only changes emphasis, so clicking never moves a node -- you keep the
 * spatial memory of your own map, and the picture stays as dense as the data
 * actually is.
 */
export function layoutGraph(
  clusters: Cluster[],
  mode: ViewMode,
  /** Deepest level Levels should lay out. Ignored by the other arrangements. */
  maxDepth = 3,
): Layout {
  // Sized from the data rather than the mode, so the views share one ground and
  // the toggle is a rearrangement rather than a rescale. Levels is allowed to
  // widen that ground -- see layoutHierarchy -- because a level laid out on one
  // line is wider than any window, and squeezing it defeats the arrangement.
  const shared = canvasFor(clusters);
  const parts =
    mode === "hierarchy"
      ? layoutHierarchy(
          maxDepth >= 3
            ? clusters
            : clusters.map((c) => ({ ...c, goals: pruneToDepth(c.goals, maxDepth) })),
          shared,
        )
      : mode === "pace"
        ? layoutPace(clusters, shared)
        : layoutAreas(clusters, shared);
  const canvas = parts.canvas ?? shared;

  relax(parts.nodes, parts.regions, canvas);

  /* Cells are smoothed together rather than one at a time: the curve through a
     junction belongs to the boundary, not to either side of it. Bands and lanes
     are thresholds and stay straight. */
  const cells = parts.regions.filter((r) => r.shape === "cell");
  const curved = smoothTiling(cells.map((r) => r.points), CELL_CORNER);
  cells.forEach((r, i) => (r.path = curved[i]));
  parts.regions
    .filter((r) => r.shape === "rect")
    .forEach((r) => {
      r.path = `M ${r.points.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
    });

  /* Regions tile the canvas, so the canvas is the fit -- except when the dots
     do not all fit inside it. Separation runs under a region constraint it
     cannot always satisfy (a lane only holds so many dots at this pitch), and
     what it gives up is the canvas edge. Ignoring that would leave those dots
     unreachable, because the fitted axis is clamped to these extents and
     nothing past them can be scrolled to. */
  let halfX = (canvas.x1 - canvas.x0) / 2;
  let halfY = (canvas.y1 - canvas.y0) / 2;
  for (const p of parts.nodes) {
    /* A goal carries its title at rest, and the title is far wider than the dot
       under it -- so the extent has to cover the words, not the mark, or the
       fitted view slices the names off the outermost goals. Deeper labels
       appear only on hover and are not owed room. */
    const reach = p.depth === 1 ? GOAL_LABEL_REACH : p.radius + 24;
    halfX = Math.max(halfX, Math.abs(p.x) + reach);
    halfY = Math.max(halfY, Math.abs(p.y) + p.radius + 24);
  }

  return { ...parts, canvas, extentX: halfX + 12, extentY: halfY + 12 };
}
