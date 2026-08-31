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
/** The same, for a view that runs off the side rather than the bottom. */
const LEFT_ANCHOR = 24;

/**
 * How far past the zoom you arrived at the deeper pair of layers takes over.
 *
 * Expressed as a MULTIPLE of that zoom rather than an absolute k. The canvas
 * grows with the tree (canvasFor) and the frame is whatever size the window is,
 * so the k a view settles at differs for every tree on every screen -- a fixed
 * threshold would fire immediately for one user and never for another.
 */
const ZOOM_STEP = 1.6;

/** Room left around a subtree when the view moves to it. */
const FOCUS_PAD = 60;

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

  /**
   * Whether Levels is showing its deepest row.
   *
   * It opens closed. Goals and milestones are the shape of the plan and fit in
   * a glance; trackables are the shape of the WORK and there are several per
   * milestone, so leading with all three is how the view became a wall of dots.
   * The row is still drawn, empty and captioned, because a level you cannot see
   * into is a different claim from a level that is not there.
   *
   * Opening it re-lays the tree rather than revealing something already
   * positioned: the width is shared out by subtree, so which row is deepest
   * changes what every gap above it is worth. The springs carry everything to
   * its new place and the trackables grow out of their own milestones, which is
   * the same motion intake already uses for work arriving.
   */
  const [expanded, setExpanded] = useState(false);
  /** The node to hold still while the tree re-lays itself around it. */
  const anchor = useRef<{ key: string; screenX: number } | null>(null);
  /* Levels lays out only the rows it is showing -- see `expanded` below. The
     other arrangements always get the whole tree; they hide by zoom, and a node
     that is one gesture away has to already have somewhere to be. */
  const layout = useMemo(
    () => layoutGraph(clusters, mode, mode === "hierarchy" && !expanded ? 2 : 3),
    [clusters, mode, expanded],
  );

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

  /* The zoom the view last settled at of its own accord -- a fit, or a move to
     a focused branch. The depth window is measured from here, so "zoomed in"
     means further in than wherever you were put, not further than some number
     that happens to suit one tree on one screen.

     State rather than a ref because the depth window is derived from it during
     render, and a ref read there is a value React has not agreed to re-render
     for. It changes only when the view is fitted, so it costs nothing. */
  const [fitK, setFitK] = useState(1);
  /* The whole-map fit, and only that. It is the floor on zooming out, so no
     view can be pulled back into ground with nothing on it -- Levels scrolls
     sideways from here and Pace scrolls down from here, neither shrinks past
     it. Kept apart from fitK because focusing a branch zooms IN, and letting
     that raise the floor would strand you inside the branch. */
  const baseK = useRef(0);
  const floor = useCallback(() => baseK.current, []);

  /* wheelRef, not a plain ref: the wheel listener is attached natively rather
     than through React, which registers wheel passively -- so preventDefault
     there does nothing and the page scrolls along with the graph. */
  const { view, setView, toGraph, handlers, isPanning, wheelRef } = usePanZoom(
    undefined,
    clamp,
    floor,
  );

  const bodies = useRef(new Map<string, Body>());
  const nodeEls = useRef(new Map<string, SVGGElement | null>());
  const edgeEls = useRef(new Map<string, SVGPathElement | null>());
  const pointer = useRef<PointerState>({ x: null, y: null, exemptKey: null });
  const raf = useRef<number | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The frame's own size, so the viewfinder can draw where the window sits. */
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const press = useRef<{ x: number; y: number } | null>(null);

  const chooseMode = useCallback((next: ViewMode) => {
    setMode(next);
    setExpanded(false);
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

  /** Close the deepest row, holding the selected dot still on the way back. */
  const collapse = useCallback(() => {
    const held = selectedKey ? byKey.get(selectedKey) : null;
    if (held) anchor.current = { key: held.node.key, screenX: view.x + held.x * view.k };
    setExpanded(false);
  }, [selectedKey, byKey, view.x, view.k]);

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

  /**
   * Which nodes are drawn at all, as opposed to merely dimmed.
   *
   * `lit` above changes how loudly a node speaks; this decides whether it is in
   * the room. The two are separate because they answer separate questions, and
   * folding hiding into the opacity ladder would mean a hidden node still took
   * hover and clicks.
   *
   * The rule, for Areas and Pace:
   *
   *   nothing drilled into   the map is its goals, and only its goals
   *   a goal drilled into    that goal's branch, and nothing else at all
   *
   * A whole tree of dots at once is not a map of anything -- it is a field. So
   * the resting state answers "what am I working on", and the milestones and
   * trackables are what you get for asking about one of them.
   *
   * Levels is exempt. Its three bands ARE the answer it gives; hiding two of
   * them would leave the view with nothing to say.
   *
   * Null means "everything", which is not the same as a set holding every key:
   * callers can skip the lookup entirely.
   */
  /**
   * Which two levels of the tree the zoom is currently in.
   *
   * Descending through a tree is what zooming already means, so in Areas it is
   * the whole control: pull back and you are in the canopy, reading goals with
   * their milestones hanging under them; push in and the goals drop away and
   * the trackables come up off the ground. Nothing is clicked to get there.
   *
   * Two levels rather than one, because a level on its own has nothing to hang
   * on -- a field of trackables with no milestones above them is a list, not a
   * tree. And two rather than three, because three is the picture this view had
   * before, which is the field of dots that made it unreadable.
   *
   * Levels is exempt, and not by oversight: there the depth is the PAGE. Three
   * bands, everything in them, and the tree runs off the side of the frame for
   * you to scroll along. Hiding a band there would be hiding the answer.
   */
  const deepLayer = view.k > fitK * ZOOM_STEP;

  /**
   * Which nodes are in the room, as opposed to merely dimmed.
   *
   * `lit` above changes how loudly a node speaks; this decides whether it is
   * present at all. They stay separate because a hidden node must also stop
   * taking hover and clicks, which an opacity alone will not do.
   *
   * Pace is the one arrangement that does not follow the zoom. It answers
   * "where am I slipping", and it answers with the lane each TRACKABLE lands
   * in -- so tying the deepest level to a zoom threshold would hide the signal
   * the whole arrangement exists to show. There it stays goals until you ask
   * about one, and asking opens the whole branch at once.
   */
  const visibleKeys = useMemo(() => {
    /* Focus is a narrowing on top of the zoom, never a precondition for it. */
    const branch =
      focus?.kind === "goal"
        ? subtree(focus.key)
        : focus?.kind === "area"
          ? new Set(
              layout.nodes
                .filter((p) => p.areaId === focus.areaId)
                .map((p) => p.node.key),
            )
          : null;

    const keys = new Set<string>();
    for (const p of layout.nodes) {
      if (branch && !branch.has(p.node.key)) continue;
      if (mode === "pace") {
        if (focus?.kind !== "goal" && p.depth !== 1) continue;
      } else if (mode === "areas" && (deepLayer ? p.depth < 2 : p.depth > 2)) {
        continue;
      }
      keys.add(p.node.key);
    }
    return keys;
  }, [mode, focus, layout.nodes, subtree, deepLayer]);

  /* Positions never move for any of this -- a node fades where it stands, and
     is in exactly that place when it comes back. That is the whole reason the
     layout stays independent of focus and of zoom. */
  const shows = useCallback((key: string) => visibleKeys.has(key), [visibleKeys]);



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

    /* Slide the view so the anchored dot stays put. A pan only -- the zoom is
       untouched, because Levels is fitted to its height and opening a row does
       not change how tall the tree is. */
    const held = anchor.current;
    anchor.current = null;
    if (!held) return;
    const moved = layout.nodes.find((p) => p.node.key === held.key);
    if (moved) {
      setView((v) => ({ ...v, x: v.x + held.screenX - (v.x + moved.x * v.k) }));
    }
  }, [layout, draw, wake, setView]);

  /* Escape steps out one level, so drilling in is reversible without hunting
     for the Back button. Bound on the window rather than the svg: after
     clicking a node the focus may sit on a circle, and users expect Escape to
     work regardless of where focus landed. */
  useEffect(() => {
    if (!focus && !expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Innermost thing first: closing the deepest row is a smaller step back
      // than letting go of the branch you are looking at.
      if (expanded) {
        collapse();
        return;
      }
      onFocus(focus?.kind === "goal" ? { kind: "area", areaId: focusedArea } : null);
      onSelect(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, focusedArea, onFocus, onSelect, expanded, collapse]);

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
      setFitK(k);
      baseK.current = k;
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
          ? /* The height, and only the height. Levels is a flat row per level
               and those rows are wider than any window worth having -- letting
               the width pull the zoom down would shrink the whole tree to fit
               something it was never meant to fit. It runs off the side and you
               scroll, which is what the horizontal axis is free for. */
            box.height / (layout.extentY * 2)
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
    /* A tree wider than the frame opens at its beginning rather than its
       middle: the far end is a scroll away either way, and starting in the
       middle hides both ends at once. */
    const halfW = layout.extentX * k;
    const x =
      axis === "height" && 2 * halfW > box.width ? LEFT_ANCHOR + halfW : box.width / 2;
    setFitK(k);
    /* Set BEFORE the view: setView clamps against this floor, so a stale value
       here would clamp the very fit that is meant to define it. */
    baseK.current = k;
    setView({ k, x, y });
  }, [layout, fitTo, axis, setView]);

  useEffect(() => {
    // An anchored change already decided where the view should be; refitting
    // on top of it would throw that away and jump to the edge of the tree.
    if (anchor.current) return;
    fit();
    // Refit when the shape changes, never on a focus tween -- a focus change
    // should settle in place, not re-centre the whole map. Node count rather
    // than cluster count: during intake there is one cluster throughout and
    // only the nodes multiply, and a view that stayed put would let each new
    // node appear off-screen at the moment it most needs to be seen.
  }, [layout.nodes.length, fit]);

  /**
   * Drilling into a goal brings that goal's branch into view.
   *
   * A pan and a zoom, never a re-layout, so nothing has moved when you come
   * back out. In Pace this is load-bearing rather than a convenience: a goal's
   * trackables scatter into whichever lanes their ratios put them in, and those
   * can be most of the width away from the goal you clicked.
   *
   * The zoom it lands on becomes the new reference for the depth window, so
   * "zoom in for the next layer" is measured from here rather than from the
   * whole-map fit you left behind.
   */
  const focusKey = focus?.kind === "goal" ? focus.key : null;
  useEffect(() => {
    if (mode === "hierarchy") return;
    if (focusKey === null) {
      fit();
      return;
    }
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const branch = subtree(focusKey);
    const members = layout.nodes.filter((p) => branch.has(p.node.key));
    if (members.length === 0) return;

    const x0 = Math.min(...members.map((p) => p.x)) - FOCUS_PAD;
    const x1 = Math.max(...members.map((p) => p.x)) + FOCUS_PAD;
    const y0 = Math.min(...members.map((p) => p.y)) - FOCUS_PAD;
    const y1 = Math.max(...members.map((p) => p.y)) + FOCUS_PAD;
    const k = Math.min(box.width / (x1 - x0), box.height / (y1 - y0), 2.2);
    setFitK(k);
    setView({
      k,
      x: box.width / 2 - ((x0 + x1) / 2) * k,
      y: box.height / 2 - ((y0 + y1) / 2) * k,
    });
  }, [focusKey, mode, layout, subtree, setView, fit]);

  /* And refit when the frame itself changes size. Without this, rotating a
     phone or crossing the desktop breakpoint leaves the map anchored to the old
     centre, half off-screen. */
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setFrameSize((prev) =>
        prev.w === box.width && prev.h === box.height
          ? prev
          : { w: box.width, h: box.height },
      );
    };
    measure();
    const ro = new ResizeObserver(() => {
      measure();
      fit();
    });
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
    // In Levels, anything above the deepest row is a handle on the rest of it.
    if (mode === "hierarchy" && p.depth <= 2 && !expanded) {
      // Hold the dot that was clicked where it is: the tree is about to be
      // rebuilt around it, and landing somewhere else afterwards would lose the
      // one thing the user had just pointed at.
      anchor.current = { key: p.node.key, screenX: view.x + p.x * view.k };
      setExpanded(true);
    }
    if (p.depth === 1) onFocus({ kind: "goal", key: p.node.key });
  }

  /** Nearest node within its own hit radius, or null. */
  function nearestNode(gx: number, gy: number): PlacedNode | null {
    let found: PlacedNode | null = null;
    let best = Infinity;
    for (const [key, b] of bodies.current) {
      const placed = byKey.get(key);
      if (!placed) continue;
      // A node you cannot see is not a node you can point at.
      if (!shows(key)) continue;
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
        <div className="flex h-full items-center justify-center px-6 text-center text-caption text-faint">
          Nothing to draw yet.
        </div>
      ) : (
        <>
          <svg
            ref={wheelRef}
            className="size-full cursor-grab touch-none active:cursor-grabbing"
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
              {/* Only the unpinned ones ride the transform. The rest are drawn
                  after this group, in screen space -- see below. */}
              {layout.regions
                .filter((r) => !r.pin)
                .map((r) => (
                  <text
                    key={`label:${r.key}`}
                    x={r.labelX}
                    y={r.labelY}
                    textAnchor={r.align}
                    className="pointer-events-none fill-faint font-mono text-micro uppercase"
                    style={{ letterSpacing: "0.2em" }}
                  >
                    {r.label}
                  </text>
                ))}

              {layout.edges.map((e) => {
                /* Both ends, or neither. An edge running to a node that is not
                   in the room is not a relationship you can read -- it is a
                   line heading off to nowhere. */
                const on = shows(e.from) && shows(e.to);
                return (
                  <path
                    key={e.key}
                    ref={(el) => void edgeEls.current.set(e.key, el)}
                    fill="none"
                    stroke={lit.has(e.to) ? "var(--color-pure)" : "var(--color-line)"}
                    strokeWidth={lit.has(e.to) ? 1.1 : 0.7}
                    opacity={
                      !on ? 0 : lit.size > 0 ? (lit.has(e.to) ? 0.55 : 0.06) : 0.3
                    }
                    className="transition-opacity duration-200"
                  />
                );
              })}

              {layout.nodes.map((p) => (
                <GraphMark
                  key={p.node.key}
                  placed={p}
                  faded={lit.size > 0 && !lit.has(p.node.key)}
                  lit={lit.size > 0 && lit.has(p.node.key)}
                  markRef={(el: SVGGElement | null) => void nodeEls.current.set(p.node.key, el)}
                  shown={shows(p.node.key)}
                  hovered={hovered === p.node.key}
                  selected={selectedKey === p.node.key}
                  fresh={highlight?.has(p.node.key) ?? false}
                  onActivate={() => activate(p)}
                />
              ))}
            </g>

            {/* Outside the transform on purpose: these float above the ground
                rather than travelling with it. A band is named for its whole
                length, so scrolling along it must not scroll its name away --
                but the other axis still tracks the content, so the caption
                stays attached to the strip it belongs to. */}
            {layout.regions
              .filter((r) => r.pin)
              .map((r) => (
                <text
                  key={`pinned:${r.key}`}
                  x={r.pin === "left" ? 22 : view.x + r.labelX * view.k}
                  y={r.pin === "top" ? 26 : view.y + r.labelY * view.k}
                  textAnchor={r.pin === "left" ? "start" : "middle"}
                  className="pointer-events-none fill-faint font-mono text-micro uppercase"
                  style={{ letterSpacing: "0.2em" }}
                >
                  {r.label}
                </text>
              ))}
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

          <Viewfinder
            nodes={layout.nodes}
            shows={shows}
            extentX={layout.extentX}
            extentY={layout.extentY}
            view={view}
            frame={frameSize}
            onGoTo={(gx, gy) =>
              setView((v) => ({
                ...v,
                x: frameSize.w / 2 - gx * v.k,
                y: frameSize.h / 2 - gy * v.k,
              }))
            }
            onFit={fit}
          />

          <ViewBarRight>
            {mode === "hierarchy" && expanded && (
              <ViewButton onClick={collapse}>Collapse</ViewButton>
            )}
            {focus && <ViewButton onClick={() => onFocus(null)}>Back</ViewButton>}
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
/**
 * Where you are, on a map of where you could be.
 *
 * Once a view stops fitting its content -- and Levels never fits, by design --
 * panning becomes navigation without a reference, and it is genuinely easy to
 * end up in an unfamiliar corner with no idea which way is back. This is the
 * reference: the whole arrangement at a glance, with a box around the part of
 * it currently on screen.
 *
 * It draws the SAME dots the canvas is showing, not every dot in the tree. A
 * minimap that advertises a level the view is hiding is not a map of the view.
 */
const Viewfinder = ({
  nodes,
  shows,
  extentX,
  extentY,
  view,
  frame,
  onGoTo,
  onFit,
}: {
  nodes: PlacedNode[];
  shows: (key: string) => boolean;
  extentX: number;
  extentY: number;
  view: View;
  frame: { w: number; h: number };
  onGoTo: (gx: number, gy: number) => void;
  onFit: () => void;
}) => {
  const WIDE = 148;
  const PAD = 4;
  if (frame.w === 0 || extentX <= 0 || extentY <= 0) return null;

  /* Sized to the content's own proportions, so the map is not a squashed
     version of the thing it is mapping. Capped, because a Levels tree can be
     twenty times wider than it is tall and a 148x7 strip tells you nothing. */
  const ratio = Math.min(Math.max(extentY / extentX, 0.34), 1);
  const tall = WIDE * ratio;
  const scale = Math.min((WIDE - 2 * PAD) / (2 * extentX), (tall - 2 * PAD) / (2 * extentY));
  const toMap = (gx: number, gy: number): [number, number] => [
    WIDE / 2 + gx * scale,
    tall / 2 + gy * scale,
  ];

  // The graph rectangle currently on screen, which is the whole point.
  const [vx0, vy0] = toMap(-view.x / view.k, -view.y / view.k);
  const [vx1, vy1] = toMap((frame.w - view.x) / view.k, (frame.h - view.y) / view.k);

  return (
    <div className="absolute right-4 top-4 z-20 overflow-hidden rounded-card border border-line bg-surface/90 backdrop-blur">
      <svg
        width={WIDE}
        height={tall}
        className="block cursor-pointer"
        role="img"
        aria-label="Overview of the whole graph, with the visible area marked"
        onPointerDown={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          onGoTo(
            (e.clientX - box.left - WIDE / 2) / scale,
            (e.clientY - box.top - tall / 2) / scale,
          );
        }}
      >
        {nodes.map((p) => {
          if (!shows(p.node.key)) return null;
          const [x, y] = toMap(p.x, p.y);
          return (
            <circle
              key={p.node.key}
              cx={x}
              cy={y}
              // Never smaller than a pixel: at this scale a faithful radius
              // would render most of the tree as nothing at all.
              r={Math.max(0.7, p.radius * scale)}
              className="fill-muted"
            />
          );
        })}
        {/* The window, as a lit patch rather than an outline. A hairline box
            over a field of hairline dots is one more thin line to pick out;
            a filled shape reads as "here" at a glance, which is the only job
            this has. */}
        <rect
          x={Math.min(vx0, vx1)}
          y={Math.min(vy0, vy1)}
          width={Math.abs(vx1 - vx0)}
          height={Math.abs(vy1 - vy0)}
          rx={4}
          fill="var(--color-accent)"
          fillOpacity={0.22}
          stroke="var(--color-accent)"
          strokeWidth={1}
          strokeOpacity={0.7}
          className="pointer-events-none"
        />
      </svg>

      {/* How far in you are, and one way back out. The percentage is the thing
          the map cannot show: two views of the same region look identical here
          whether the tree is legible or a smear. */}
      <div className="flex items-stretch border-t border-line">
        <div className="flex flex-1 items-center justify-center py-1.5 font-mono text-footnote tabular-nums text-muted">
          {Math.round(view.k * 100)}%
        </div>
        <button
          onClick={onFit}
          title="Fit the whole graph"
          aria-label="Fit the whole graph"
          className="border-l border-line px-3 text-muted transition hover:bg-raised hover:text-ink"
        >
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 5.5V3a1 1 0 0 1 1-1h2.5M14 5.5V3a1 1 0 0 0-1-1h-2.5M2 10.5V13a1 1 0 0 0 1 1h2.5M14 10.5V13a1 1 0 0 1-1 1h-2.5"
              stroke="currentColor"
              strokeWidth={1.3}
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

const GraphMark = ({
  markRef,
  placed,
  shown,
  hovered,
  selected,
  faded,
  lit,
  fresh,
  onActivate,
}: {
  markRef: (el: SVGGElement | null) => void;
  placed: PlacedNode;
  /** In the room at all. False fades it out entirely and takes it out of reach. */
  shown: boolean;
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
  const showLabel = shown && (placed.depth === 1 || hovered || selected || lit);

  return (
    <g
      ref={markRef}
      /* Depth is carried by weight as well as size: goals speak first,
         trackables recede, and nothing has to be hidden to keep it readable.
         An inferred value reads as less solid, which is the one flag left on
         the mark itself now that there is no stroke to dash (D3). */
      opacity={
        (!shown
          ? 0
          : faded
            ? 0.14
            : placed.depth === 1
              ? 1
              : placed.depth === 2
                ? 0.78
                : 0.58) *
        (node.flags?.parked ? 0.5 : 1) *
        (node.flags?.estimated ? 0.72 : 1)
      }
      /* Faded out is still clickable; out of the room is not. Without this the
         invisible layers keep taking hover and taps, and the graph responds to
         things that are not on the screen. */
      className={`transition-opacity duration-200 ${shown ? "" : "pointer-events-none"}`}
      aria-hidden={!shown || undefined}
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
        tabIndex={shown ? 0 : -1}
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
          className={`pointer-events-none text-micro transition-opacity duration-200 ${
            hovered || selected ? "fill-ink" : "fill-muted"
          }`}
        >
          {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
        </text>
      )}
    </g>
  );
};
