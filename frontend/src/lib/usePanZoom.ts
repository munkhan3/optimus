import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pan and zoom for an SVG viewport.
 *
 * Two things the previous hand-rolled version got wrong and this fixes:
 *
 *   Zoom was applied about the origin, so content slid away from the pointer
 *   instead of growing under it. Anchoring keeps whatever you are pointing at
 *   fixed, which is what makes zoom feel like magnification rather than drift.
 *
 *   `touch-none` plus wheel-only zoom left the view unusable on a phone. Two
 *   active pointers are now tracked as a pinch.
 *
 * An optional `clamp` runs on every view the hook produces, whatever produced
 * it -- wheel, pinch, drag, or a caller setting the view outright. Constraining
 * at the single point where the view is written is the only way an axis stays
 * genuinely locked: a rule applied in the drag handler alone would still let a
 * zoom slide the content out from under it.
 */

export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.25;
const MAX_K = 3;

export function usePanZoom(
  initial: View = { x: 0, y: 0, k: 1 },
  clamp?: (v: View) => View,
  floor?: () => number,
) {
  const [view, setViewRaw] = useState<View>(initial);
  /* Held in refs rather than closed over: both depend on the layout and the
     frame size, both of which change, and re-creating every handler each time
     they did would tear down the pointer capture mid-drag. */
  const clampRef = useRef(clamp);
  const floorRef = useRef(floor);
  useEffect(() => {
    clampRef.current = clamp;
    floorRef.current = floor;
  }, [clamp, floor]);

  /**
   * How far out this view is allowed to go.
   *
   * A caller that fits its content can pin the floor to that fit, which stops
   * the view zooming out into ground with nothing on it. Empty space is not a
   * neutral default -- it reads as the map having run out.
   */
  const minK = () => Math.max(MIN_K, floorRef.current?.() ?? MIN_K);

  const setView = useCallback((next: View | ((v: View) => View)) => {
    setViewRaw((v) => {
      const proposed = typeof next === "function" ? next(v) : next;
      const bounded = { ...proposed, k: Math.min(MAX_K, Math.max(minK(), proposed.k)) };
      return clampRef.current ? clampRef.current(bounded) : bounded;
    });
  }, []);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panFrom = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const pinchFrom = useRef<{ dist: number; k: number; cx: number; cy: number } | null>(null);

  /** Screen point -> graph point, given the current transform. */
  const toGraph = useCallback(
    (sx: number, sy: number, v: View = view) => ({
      x: (sx - v.x) / v.k,
      y: (sy - v.y) / v.k,
    }),
    [view],
  );

  const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(minK(), v.k * factor));
      // Hold the graph point under (sx, sy) still across the scale change.
      const gx = (sx - v.x) / v.k;
      const gy = (sy - v.y) / v.k;
      return { k, x: sx - gx * k, y: sy - gy * k };
    });
  }, [setView]);

  /**
   * Wheel gestures, which on a trackpad are two different gestures.
   *
   * A pinch arrives as a wheel event with `ctrlKey` set. That is not a
   * modifier the user is holding -- it is the convention every browser uses to
   * mark a pinch, and it is the only thing distinguishing one from a
   * two-finger slide. Reading deltaY without checking it makes every scroll a
   * zoom, which is what this used to do.
   *
   * So: pinch zooms, slide scrolls, and ctrl/⌘ with a real wheel zooms too,
   * since a mouse has no pinch to offer.
   */
  const onWheel = useCallback(
    (e: WheelEvent) => {
      // Attached non-passively below precisely so this can be honoured; React's
      // own onWheel is passive, so the page would scroll along with the graph.
      e.preventDefault();
      const box = (e.currentTarget as Element).getBoundingClientRect();

      if (e.ctrlKey || e.metaKey) {
        zoomAt(1 - e.deltaY * 0.0015, e.clientX - box.left, e.clientY - box.top);
        return;
      }

      // deltaMode is pixels for a trackpad but lines or pages for some mice.
      const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.height : 1;
      setView((v) => ({
        ...v,
        x: v.x - e.deltaX * step,
        y: v.y - e.deltaY * step,
      }));
    },
    [zoomAt, setView],
  );

  /* Held in state rather than a ref so that mounting the element re-runs the
     effect below. The svg lives inside a conditional -- an empty graph renders
     a message instead -- and a plain ref would leave the listener unattached
     for anyone whose first load had nothing to draw. `setWheelEl` is stable, so
     it doubles as the callback ref itself. */
  const [wheelEl, setWheelEl] = useState<SVGSVGElement | null>(null);
  useEffect(() => {
    if (!wheelEl) return;
    wheelEl.addEventListener("wheel", onWheel, { passive: false });
    return () => wheelEl.removeEventListener("wheel", onWheel);
  }, [wheelEl, onWheel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const box = e.currentTarget.getBoundingClientRect();
      const p = { x: e.clientX - box.left, y: e.clientY - box.top };
      pointers.current.set(e.pointerId, p);
      e.currentTarget.setPointerCapture(e.pointerId);

      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinchFrom.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          k: view.k,
          cx: (a.x + b.x) / 2,
          cy: (a.y + b.y) / 2,
        };
        panFrom.current = null;
      } else {
        panFrom.current = { x: p.x, y: p.y, vx: view.x, vy: view.y };
      }
    },
    [view.k, view.x, view.y],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const p = { x: e.clientX - box.left, y: e.clientY - box.top };
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);

    if (pointers.current.size >= 2 && pinchFrom.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const start = pinchFrom.current;
      if (start.dist > 0) {
        const k = Math.min(MAX_K, Math.max(minK(), start.k * (dist / start.dist)));
        setView((v) => {
          const gx = (start.cx - v.x) / v.k;
          const gy = (start.cy - v.y) / v.k;
          return { k, x: start.cx - gx * k, y: start.cy - gy * k };
        });
      }
      return;
    }

    // Read the ref ONCE, synchronously. Dereferencing it inside the updater is
    // a race: React may run that updater after onPointerUp nulled it.
    const origin = panFrom.current;
    if (!origin) return;
    setView((v) => ({ ...v, x: origin.vx + (p.x - origin.x), y: origin.vy + (p.y - origin.y) }));
  }, [setView]);

  const endPointer = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
    if (pointers.current.size === 0) panFrom.current = null;
  }, []);

  /** Is the user currently dragging? Used to suppress hover effects mid-pan. */
  const isPanning = useCallback(() => panFrom.current !== null, []);

  return {
    view,
    setView,
    toGraph,
    zoomAt,
    isPanning,
    /** Callback ref for the element wheel gestures are read from. */
    wheelRef: setWheelEl,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onPointerLeave: endPointer,
    },
  };
}
