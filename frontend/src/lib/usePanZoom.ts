import { useCallback, useRef, useState } from "react";

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
 */

export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.25;
const MAX_K = 3;

export function usePanZoom(initial: View = { x: 0, y: 0, k: 1 }) {
  const [view, setView] = useState<View>(initial);
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
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      // Hold the graph point under (sx, sy) still across the scale change.
      const gx = (sx - v.x) / v.k;
      const gy = (sy - v.y) / v.k;
      return { k, x: sx - gx * k, y: sy - gy * k };
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const box = e.currentTarget.getBoundingClientRect();
      zoomAt(1 - e.deltaY * 0.0015, e.clientX - box.left, e.clientY - box.top);
    },
    [zoomAt],
  );

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
        const k = Math.min(MAX_K, Math.max(MIN_K, start.k * (dist / start.dist)));
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
  }, []);

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
    handlers: {
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onPointerLeave: endPointer,
    },
  };
}
