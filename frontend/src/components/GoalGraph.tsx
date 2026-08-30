import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewBarLeft, ViewBarRight, ViewButton, ViewSwitch } from "./ViewChrome";
import {
  type Cluster,
  type Focus,
  type GraphNode,
  type PlacedNode,
  type ViewMode,
  FIT_AXIS,
  NODE_GAP,
  VIEW_MODES,
  layoutGraph,
} from "../lib/graphLayout";
import {
  type Body,
  type PointerState,
  prefersReducedMotion,
  reconcile,
  settled,
  snapHome,
  step,
} from "../lib/graphMotion";
import { type View, usePanZoom } from "../lib/usePanZoom";
import { pointInPolygon } from "../lib/voronoi";

/**
 * The goal graph as a map.
 *
 * One canvas for both callers: the persisted graph in the Tree tab, and the
 * proposal being built during intake. Intake pins the arrangement and passes
 * the keys that arrived this turn; everything else is the same picture.
 *
 * The dots carry no colour. Health is a continuous value and a filled circle is
 * a weak channel for one; worse, a single arrangement can only ever answer a
 * single question. So meaning moved into the arrangement instead, and there are
 * three of them -- see graphLayout.ts. Everything around the arrangement is
 * shared: the same springs, the same pointer field, the same pan and zoom.
 *
 * Positions come from layoutGraph and never change per frame. The rAF loop only
 * springs bodies toward those positions, and it stops entirely once they
 * arrive.
 */

/** How close the cursor must be to capture a node. */
const CAPTURE_RADIUS = 34;

/** Where the top of the ground sits when a view is anchored to it. Enough of a
    margin that the captions, which ride just above it, are clear of the frame. */
const TOP_ANCHOR = 44;

/**
 * Keep one axis covered by the content.
 *
 * `pos` is where graph zero sits on the screen along this axis, and the content
 * is centred on graph zero, so it covers [pos - half, pos + half]. Anything
 * smaller than the viewport is centred; anything larger is held so neither edge
 * can be dragged inside the frame. The effect is a lock at the fitted zoom that
 * loosens into ordinary panning as you zoom in -- which is the behaviour you
 * want from an axis that carries the whole meaning of the arrangement.
 */
function coverAxis(pos: number, size: number, extent: number, k: number): number {
  const half = extent * k;
  if (2 * half <= size) return size / 2;
  return Math.min(half, Math.max(size - half, pos));
}

/** One fill for every dot. Level is carried by size, nothing by hue. */
const NODE_FILL = "var(--color-ink)";

const VIEW_KEY = "optimus.graphView";

function storedMode(): ViewMode {
  if (typeof localStorage === "undefined") return "areas";
  const saved = localStorage.getItem(VIEW_KEY);
  return VIEW_MODES.some((v) => v.mode === saved) ? (saved as ViewMode) : "areas";
}

export function GoalGraph({
  clusters,
  focus,
  onFocus,
  selectedKey,
  onSelect,
  mode: pinnedMode,
  highlight,
  fitTo = "canvas",
  className = "",
}: {
  clusters: Cluster[];
  focus: Focus;
  onFocus: (f: Focus) => void;
  selectedKey: string | null;
  onSelect: (node: GraphNode | null) => void;
  /** Fixes the arrangement and hides the switcher. Intake pins "hierarchy":
      there are no areas yet, and pace would file everything under no-signal. */
  mode?: ViewMode;
  /** Keys that arrived this turn. Haloed once, so growth is legible. */
  highlight?: Set<string>;
  /**
   * What the view is scaled to. "canvas" keeps the ground constant, which is
   * what makes the Tree tab's mode toggle a rearrangement rather than a
   * rescale. "nodes" scales to the dots themselves -- during intake there are
   * a handful of them in a half-height frame, and fitting the whole canvas
   * shrinks the labels past reading.
   */
  fitTo?: "canvas" | "nodes";
  className?: string;
}) {
  const [chosenMode, setMode] = useState<ViewMode>(storedMode);
  const mode = pinnedMode ?? chosenMode;
  const layout = useMemo(() => layoutGraph(clusters, mode), [clusters, mode]);

  const frame = useRef<HTMLDivElement>(null);

  const axis = FIT_AXIS[mode];
  const clamp = useCallback(
    (v: View): View => {
      const box = frame.current?.getBoundingClientRect();
      if (!box || axis === "both") return v;
      return axis === "width"
        ? { ...v, x: coverAxis(v.x, box.width, layout.extentX, v.k) }
        : { ...v, y: coverAxis(v.y, box.height, layout.extentY, v.k) };
    },
    [axis, layout.extentX, layout.extentY],
  );

  const { view, setView, toGraph, handlers, isPanning } = usePanZoom(undefined, clamp);

  const bodies = useRef(new Map<string, Body>());
  const nodeEls = useRef(new Map<string, SVGGElement | null>());
  const edgeEls = useRef(new Map<string, SVGPathElement | null>());
  const pointer = useRef<PointerState>({ x: null, y: null, exemptKey: null });
  const raf = useRef<number | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);

  const chooseMode = useCallback((next: ViewMode) => {
    setMode(next);
    // Persisted, so the question you were asking survives a reload.
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private mode or a full quota: the view still works, it just forgets.
    }
  }, []);

  const byKey = useMemo(() => {
    const m = new Map<string, PlacedNode>();
    layout.nodes.forEach((p) => m.set(p.node.key, p));
    return m;
  }, [layout]);

  /** Keys on the path from a node up to its root, for hover emphasis. */
  const ancestors = useMemo(() => {
    const parent = new Map<string, string>();
    layout.edges.forEach((e) => parent.set(e.to, e.from));
    return (key: string | null) => {
      const chain = new Set<string>();
      let at = key;
      while (at) {
        chain.add(at);
        at = parent.get(at) ?? null;
      }
      return chain;
    };
  }, [layout]);

  /** Descendants of a key, so lighting a goal lights its whole branch. */
  const subtree = useMemo(() => {
    const kids = new Map<string, string[]>();
    layout.edges.forEach((e) => kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]));
    return (key: string) => {
      const out = new Set<string>();
      const walk = (k: string) => {
        out.add(k);
        (kids.get(k) ?? []).forEach(walk);
      };
      walk(key);
      return out;
    };
  }, [layout.edges]);

  /**
   * What is emphasised. Empty means "nothing in particular" and everything
   * renders at its normal weight; otherwise these are lit and the rest fades.
   * Focus never removes a node -- it only changes how loudly it speaks.
   */
  const lit = useMemo(() => {
    const key = hovered ?? selectedKey;
    if (key) return new Set([...ancestors(key), ...subtree(key)]);
    if (focus?.kind === "goal") return subtree(focus.key);
    if (focus?.kind === "area") {
      return new Set(
        layout.nodes.filter((p) => p.areaId === focus.areaId).map((p) => p.node.key),
      );
    }
    return new Set<string>();
  }, [ancestors, subtree, hovered, selectedKey, focus, layout.nodes]);

  const focusedArea = useMemo(
    () => (focus?.kind === "goal" ? (byKey.get(focus.key)?.areaId ?? null) : null),
    [focus, byKey],
  );

  // ------------------------------------------------------------------ motion

  /* The animation loop must not capture React state. A rAF scheduled with a
     callback from render N keeps calling that closure forever, so after a view
     change it would happily keep drawing the previous layout's edges. Everything
     the loop touches therefore lives in a ref, and the loop itself is created
     exactly once. */
  const layoutRef = useRef(layout);

  const draw = useCallback(() => {
    for (const [key, el] of nodeEls.current) {
      const b = bodies.current.get(key);
      if (el && b) el.setAttribute("transform", `translate(${b.x} ${b.y})`);
    }
    for (const e of layoutRef.current.edges) {
      const el = edgeEls.current.get(e.key);
      const a = bodies.current.get(e.from);
      const z = bodies.current.get(e.to);
      if (!el || !a || !z) continue;
      el.setAttribute("d", `M ${a.x} ${a.y} L ${z.x} ${z.y}`);
    }
  }, []);

  /* A NAMED function expression: `loop` inside the body binds to the function
     itself, not to the outer const, so re-scheduling can never pick up a stale
     copy. `draw` has no dependencies, so this identity is stable for the life of
     the component. */
  const loop = useCallback(function loop() {
    /* Strictly smaller than the layout's gap. The layout separates dots to
       exactly NODE_GAP, so a runtime separator using the same value fights
       floating-point error forever: it nudges, the spring pulls back, the graph
       never settles, snapHome never runs and the loop never sleeps. */
    const peak = step(bodies.current, pointer.current, 1, NODE_GAP - 1.5);
    draw();
    if (settled(peak, pointer.current)) {
      // Park exactly on the layout, so the resting frame is the deterministic
      // picture and the loop stops costing anything at all.
      snapHome(bodies.current);
      draw();
      raf.current = null;
      return;
    }
    raf.current = requestAnimationFrame(loop);
  }, [draw]);

  const wake = useCallback(() => {
    if (raf.current === null && !prefersReducedMotion()) {
      raf.current = requestAnimationFrame(loop);
    }
  }, [loop]);

  /* Home positions change whenever the layout does; bodies keep their current
     position so a change settles instead of jumping. This is what makes the
     view toggle worth having as one canvas rather than three: switching
     re-runs the layout and the springs glide every dot to its new
     arrangement. */
  useEffect(() => {
    layoutRef.current = layout;
    const parentOf = new Map<string, string>();
    layout.edges.forEach((e) => parentOf.set(e.to, e.from));
    reconcile(
      bodies.current,
      layout.nodes.map((p) => ({
        key: p.node.key,
        x: p.x,
        y: p.y,
        r: p.radius,
        parentKey: parentOf.get(p.node.key),
      })),
    );
    if (prefersReducedMotion()) {
      snapHome(bodies.current);
      draw();
    } else {
      wake();
    }
  }, [layout, draw, wake]);

  /* Escape steps out one level, so drilling in is reversible without hunting
     for the Back button. Bound on the window rather than the svg: after
     clicking a node the focus may sit on a circle, and users expect Escape to
     work regardless of where focus landed. */
  useEffect(() => {
    if (!focus) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onFocus(focus?.kind === "goal" ? { kind: "area", areaId: focusedArea } : null);
      onSelect(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, focusedArea, onFocus, onSelect]);

  useEffect(
    () => () => {
      /* Clearing the handle is not optional. Cancelling alone leaves a stale
         frame id in the ref, and wake() treats any non-null value as "already
         running" -- so after an unmount/remount (StrictMode, or simply leaving
         the Tree tab and coming back) the loop could never be started again and
         the graph froze at the origin. */
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    },
    [],
  );

  // -------------------------------------------------------------------- fit

  const fit = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;

    if (fitTo === "nodes" && layout.nodes.length > 0) {
      // Room for the label that hangs under a dot, so fitting never clips one.
      const PAD = 46;
      const xs = layout.nodes.map((p) => p.x);
      const ys = layout.nodes.map((p) => p.y);
      const x0 = Math.min(...xs) - PAD;
      const x1 = Math.max(...xs) + PAD;
      const y0 = Math.min(...ys) - PAD;
      const y1 = Math.max(...ys) + PAD;
      const k = Math.min((box.width * 0.94) / (x1 - x0), (box.height * 0.94) / (y1 - y0), 2.2);
      setView({
        k,
        x: box.width / 2 - ((x0 + x1) / 2) * k,
        y: box.height / 2 - ((y0 + y1) / 2) * k,
      });
      return;
    }

    /* The extents are the same in every mode -- the regions always tile the
       same canvas -- so switching views rearranges the picture without
       rescaling it. What changes is which axis is fitted: the one the
       arrangement is read along fills the frame exactly, with no margin,
       because a margin there is ground the view is claiming does not exist. */
    const k =
      axis === "width"
        ? box.width / (layout.extentX * 2)
        : axis === "height"
          ? /* The height is what Levels is fitted to, but not at the cost of
               slicing the outermost titles off the sides: where the tree is
               wider than the frame at that zoom, the width wins and the bands
               simply run further up and down instead. */
            Math.min(
              box.height / (layout.extentY * 2),
              box.width / (layout.extentX * 2),
            )
          : Math.min(
              (box.width * 0.94) / (layout.extentX * 2),
              (box.height * 0.94) / (layout.extentY * 2),
              2.2,
            );

    /* The free axis anchors to the top of the ground rather than centring it.
       Nothing says a view has to fit: what matters in Pace is that the lane
       captions and the leaders under them are the first thing you see, and the
       rest of the column is a scroll away. Centring a column taller than the
       frame would hide both ends of it instead. */
    const y =
      axis === "width" ? TOP_ANCHOR - layout.canvas.y0 * k : box.height / 2;
    setView({ k, x: box.width / 2, y });
  }, [layout, fitTo, axis, setView]);

  useEffect(() => {
    fit();
    // Refit when the shape changes, never on a focus tween -- a focus change
    // should settle in place, not re-centre the whole map. Node count rather
    // than cluster count: during intake there is one cluster throughout and
    // only the nodes multiply, and a view that stayed put would let each new
    // node appear off-screen at the moment it most needs to be seen.
  }, [layout.nodes.length, fit]);

  /* And refit when the frame itself changes size. Without this, rotating a
     phone or crossing the desktop breakpoint leaves the map anchored to the old
     centre, half off-screen. */
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // ----------------------------------------------------------------- pointer

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    handlers.onPointerMove(e);
    if (isPanning()) return;
    const box = e.currentTarget.getBoundingClientRect();
    const g = toGraph(e.clientX - box.left, e.clientY - box.top);

    // Capture the nearest node so the field parts AROUND it. Without this the
    // node you are reaching for is pushed away and can never be clicked.
    const nearest = nearestNode(g.x, g.y)?.node.key ?? null;
    pointer.current = { x: g.x, y: g.y, exemptKey: nearest };
    if (nearest !== hovered) setHovered(nearest);
    wake();
  }

  function onLeave(e: React.PointerEvent<SVGSVGElement>) {
    handlers.onPointerLeave(e);
    pointer.current = { x: null, y: null, exemptKey: null };
    setHovered(null);
    wake();
  }

  function activate(p: PlacedNode) {
    onSelect(p.node);
    if (p.depth === 1) onFocus({ kind: "goal", key: p.node.key });
  }

  /** Nearest node within its own hit radius, or null. */
  function nearestNode(gx: number, gy: number): PlacedNode | null {
    let found: PlacedNode | null = null;
    let best = Infinity;
    for (const [key, b] of bodies.current) {
      const placed = byKey.get(key);
      if (!placed) continue;
      const d = Math.hypot(b.x - gx, b.y - gy);
      const reach = Math.max(placed.radius * 1.7, CAPTURE_RADIUS * 0.7);
      if (d <= reach && d < best) {
        best = d;
        found = placed;
      }
    }
    return found;
  }

  /**
   * The area a point falls in, or null.
   *
   * Only the Areas view answers this: there the regions ARE the areas, so
   * clicking the ground is an unambiguous way to focus one. A band or a lane
   * is not an area, and pretending otherwise would focus something the user
   * never pointed at.
   */
  function areaAt(gx: number, gy: number) {
    return (
      layout.regions.find(
        (r) => r.areaId !== undefined && pointInPolygon(gx, gy, r.points),
      ) ?? null
    );
  }

  /* Activation happens on pointer-up, not via onClick.
     The svg calls setPointerCapture on pointerdown so a pan survives the cursor
     leaving the element -- but capture also redirects the event stream away from
     the child circles, so their onClick never fires at all. Deciding here, from
     how far the pointer travelled, keeps panning and tapping distinct and makes
     touch taps work for free. */
  function onUp(e: React.PointerEvent<SVGSVGElement>) {
    const start = press.current;
    press.current = null;
    handlers.onPointerUp(e);
    if (!start) return;

    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    if (Math.hypot(sx - start.x, sy - start.y) > 5) return; // that was a drag

    const g = toGraph(sx, sy);
    const nearest = nearestNode(g.x, g.y);
    if (nearest) {
      activate(nearest);
      return;
    }
    const area = areaAt(g.x, g.y);
    if (area) {
      onFocus(
        focus?.kind === "area" && focus.areaId === area.areaId
          ? null
          : { kind: "area", areaId: area.areaId ?? null },
      );
      onSelect(null);
    }
  }

  return (
    <div
      ref={frame}
      className={`relative select-none overflow-hidden bg-bg ${className}`}
    >
      {layout.nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-faint">
          Nothing to draw yet.
        </div>
      ) : (
        <>
          <svg
            className="size-full cursor-grab touch-none active:cursor-grabbing"
            onWheel={handlers.onWheel}
            onPointerDown={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              press.current = { x: e.clientX - box.left, y: e.clientY - box.top };
              handlers.onPointerDown(e);
            }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={handlers.onPointerCancel}
            onPointerLeave={onLeave}
            role="tree"
            aria-label="Goal graph"
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* Regions tile the canvas with no gaps, so every patch of ground
                  means something. One colour at two alphas: neighbours separate
                  without a second hue arriving to compete with the dots. */}
              {/* The border is drawn as well as the fill: at these alphas two
                  neighbouring washes can be genuinely hard to tell apart, and
                  the boundary is the thing the view is claiming. Each cell
                  strokes its own eased corner, so three lines cross at every
                  junction -- which is why the easing is kept short enough that
                  what they draw there is a thickening rather than a shape. */}
              {layout.regions.map((r) => (
                <path
                  key={r.key}
                  d={r.path}
                  fill={r.fill}
                  fillOpacity={r.fillOpacity}
                  stroke="var(--color-line)"
                  strokeWidth={0.75}
                  strokeOpacity={0.45}
                  className="pointer-events-none"
                />
              ))}
              {/* One caption treatment for all three arrangements: an area's
                  name is no more important than a band's or a lane's, and three
                  sizes of the same thing would only look like three kinds of
                  thing. */}
              {layout.regions.map((r) => (
                <text
                  key={`label:${r.key}`}
                  x={r.labelX}
                  y={r.labelY}
                  textAnchor={r.align}
                  className="pointer-events-none fill-faint font-mono text-[9px] uppercase"
                  style={{ letterSpacing: "0.2em" }}
                >
                  {r.label}
                </text>
              ))}

              {layout.edges.map((e) => (
                <path
                  key={e.key}
                  ref={(el) => void edgeEls.current.set(e.key, el)}
                  fill="none"
                  stroke={lit.has(e.to) ? "var(--color-pure)" : "var(--color-line)"}
                  strokeWidth={lit.has(e.to) ? 1.1 : 0.7}
                  opacity={lit.size > 0 ? (lit.has(e.to) ? 0.55 : 0.06) : 0.3}
                  className="transition-opacity duration-200"
                />
              ))}

              {layout.nodes.map((p) => (
                <GraphMark
                  key={p.node.key}
                  placed={p}
                  faded={lit.size > 0 && !lit.has(p.node.key)}
                  lit={lit.size > 0 && lit.has(p.node.key)}
                  markRef={(el: SVGGElement | null) => void nodeEls.current.set(p.node.key, el)}
                  hovered={hovered === p.node.key}
                  selected={selectedKey === p.node.key}
                  fresh={highlight?.has(p.node.key) ?? false}
                  onActivate={() => activate(p)}
                />
              ))}
            </g>
          </svg>

          {/* Bottom-left. Opposite corner from Fit and Back, because a control
              that changes what you are looking at should not sit in the same
              cluster as ones that only change where you are looking -- and out
              of the top-left, which belongs to the map: every arrangement
              captions its first region there, and Levels now fits the height
              exactly, so the first band's caption starts at the very top edge
              and was landing underneath this.

              These now come from components/ViewChrome, which the roadmap uses
              too, so the two full-bleed views cannot drift into slightly
              different bars. */}
          {!pinnedMode && (
            <ViewBarLeft>
              <ViewSwitch
                label="Arrangement"
                value={mode}
                onChange={(next) => chooseMode(next)}
                options={VIEW_MODES.map((v) => ({ value: v.mode, label: v.label }))}
              />
            </ViewBarLeft>
          )}

          <ViewBarRight>
            {focus && <ViewButton onClick={() => onFocus(null)}>Back</ViewButton>}
            <ViewButton onClick={fit}>Fit</ViewButton>
          </ViewBarRight>
        </>
      )}
    </div>
  );
}

/**
 * A node.
 *
 * A filled dot and nothing else: no outline, no hue. Size says which level it
 * belongs to and the arrangement says everything else, so the mark itself has
 * only one job -- being findable.
 */
const GraphMark = ({
  markRef,
  placed,
  hovered,
  selected,
  faded,
  lit,
  fresh,
  onActivate,
}: {
  markRef: (el: SVGGElement | null) => void;
  placed: PlacedNode;
  hovered: boolean;
  selected: boolean;
  faded: boolean;
  lit: boolean;
  fresh: boolean;
  onActivate: () => void;
}) => {
  const { node, radius } = placed;
  const scale = hovered || selected ? 1.5 : 1;
  const r = radius * scale;

  /* Goals are always named. Deeper names would collide at rest -- there are
     several per goal and they sit close together -- so they appear only once
     that branch is pointed at or lit. */
  const showLabel = placed.depth === 1 || hovered || selected || lit;

  return (
    <g
      ref={markRef}
      /* Depth is carried by weight as well as size: goals speak first,
         trackables recede, and nothing has to be hidden to keep it readable.
         An inferred value reads as less solid, which is the one flag left on
         the mark itself now that there is no stroke to dash (D3). */
      opacity={
        (faded ? 0.14 : placed.depth === 1 ? 1 : placed.depth === 2 ? 0.78 : 0.58) *
        (node.flags?.parked ? 0.5 : 1) *
        (node.flags?.estimated ? 0.72 : 1)
      }
      className="transition-opacity duration-200"
    >
      {/* A node that just arrived rings once and stops. White, like every other
          emphasis here -- a hue on the dot would say something about the node
          itself, and "new this turn" is a fact about the conversation. */}
      {fresh && (
        <circle
          r={r}
          fill="none"
          stroke="var(--color-pure)"
          strokeWidth={1}
          /* fill-box, or the scale would pivot on the centre of the whole
             viewport instead of the centre of this dot. */
          style={{
            animation: "markIn 900ms ease-out 1 both",
            transformBox: "fill-box",
            transformOrigin: "center",
          }}
          className="pointer-events-none"
        />
      )}

      {/* Selection is a halo set well clear of the dot, not an outline on it. */}
      {selected && (
        <circle r={r + 5} fill="none" stroke="var(--color-pure)" strokeWidth={1} opacity={0.55} />
      )}

      <circle r={r} fill={NODE_FILL} className="transition-[r] duration-200" />

      {/* A real target, so the graph stays keyboard-reachable. */}
      <circle
        r={Math.max(r, 13)}
        fill="transparent"
        tabIndex={0}
        role="treeitem"
        aria-label={`${node.kind}: ${node.title}`}
        aria-selected={selected}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          }
        }}
        className="cursor-pointer outline-none focus-visible:stroke-pure focus-visible:[stroke-width:2]"
      />

      {showLabel && (
        <text
          x={0}
          y={r + 12}
          textAnchor="middle"
          className={`pointer-events-none text-[10px] transition-opacity duration-200 ${
            hovered || selected ? "fill-ink" : "fill-muted"
          }`}
        >
          {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
        </text>
      )}
    </g>
  );
};
