import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Responsive, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
// The position strategies live in the /core entrypoint, not the root.
import { absoluteStrategy, transformStrategy } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import {
  getCalibration,
  getFlow,
  getLayout,
  getPortfolio,
  getRoadmap,
  getThroughput,
  putLayout,
  type WidgetPlacement,
} from "../lib/dashboard";
import { ApiError } from "../lib/api";
import { BY_KIND, requiredSources } from "../components/widgets/registry";
import type { DashboardData, Source } from "../components/widgets/types";
import { UnknownWidget, WidgetFrame } from "../components/widgets/WidgetFrame";
import { AddWidget } from "../components/widgets/AddWidget";
import { Banner, Button, SkeletonList } from "../components/Primitives";
import { ViewBarLeft, ViewBarRight, ViewButton } from "../components/ViewChrome";
import { prefersReducedMotion } from "../lib/graphMotion";
import { useNarrow } from "../lib/useNarrow";

const COLS = { lg: 12, md: 6, sm: 1 };
// These measure the GRID CONTAINER, not the viewport -- and the content column
// is capped at 1100px with 40px of padding, so the widest this ever gets is
// ~1020. Viewport-shaped values (1024/640) put the twelve-column layout
// permanently out of reach on a full-size desktop window.
const BREAKPOINTS = { lg: 900, md: 560, sm: 0 };
const ROW_H = 40;

/**
 * The progress dashboard (§19, in scope for v0 and previously unbuilt).
 *
 * Two decisions worth stating.
 *
 * Dragging is behind an explicit Edit toggle. A dashboard is read far more
 * often than it is arranged, and a board that reshuffles because a scroll
 * gesture started on a card is a board the user stops trusting. Today.tsx
 * guards activation the same way, with a drag threshold.
 *
 * Unknown widget kinds are rendered as a placeholder and saved back unchanged.
 * Dropping them would let one stale browser tab silently delete a widget added
 * from a newer one.
 */
export function Dashboard({ onNavigate }: { onNavigate?: (tab: "roadmap" | "tree" | "work" | "plan") => void }) {
  // v2 replaced the WidthProvider HOC with a hook; the ref goes on the element
  // that actually bounds the grid.
  const { width, containerRef } = useContainerWidth();
  const narrow = useNarrow();
  const [widgets, setWidgets] = useState<WidgetPlacement[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  // Which column count is on screen. Only the full-width arrangement is ever
  // persisted -- see onLayoutChange.
  const [breakpoint, setBreakpoint] = useState<keyof typeof COLS>("lg");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData>({});

  // ------------------------------------------------------------- the layout
  useEffect(() => {
    let live = true;
    getLayout()
      .then((l) => live && setWidgets(l.widgets))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  // ---------------------------------------------------------------- the data
  // Fetched per source, once, and only for sources something on the board
  // actually asks for. Thirteen widgets each issuing their own request would
  // make a page load an order of magnitude more expensive than the information.
  const kinds = useMemo(() => (widgets ?? []).map((w) => w.kind), [widgets]);
  const sourceKey = useMemo(() => [...requiredSources(kinds)].sort().join(","), [kinds]);

  useEffect(() => {
    if (!sourceKey) return;
    let live = true;
    const fetchers: Record<Source, () => Promise<unknown>> = {
      portfolio: getPortfolio,
      throughput: getThroughput,
      calibration: getCalibration,
      roadmap: getRoadmap,
      flow: getFlow,
    };
    for (const source of sourceKey.split(",") as Source[]) {
      fetchers[source]()
        .then((value) => live && setData((d) => ({ ...d, [source]: value })))
        // null, never undefined: a failed source has to look different from one
        // that is still in flight, or every widget shows a skeleton forever.
        .catch(() => live && setData((d) => ({ ...d, [source]: null })));
    }
    return () => {
      live = false;
    };
  }, [sourceKey]);

  // ------------------------------------------------------------- persistence
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback((next: WidgetPlacement[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Debounced, and only ever on gesture end -- never per animation frame.
    saveTimer.current = setTimeout(() => {
      putLayout(next).catch((e) =>
        setError(e instanceof ApiError ? e.message : String(e)),
      );
    }, 400);
  }, []);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const onLayoutChange = useCallback(
    (items: Layout) => {
      // Two guards, both load-bearing.
      //
      // `editing` keeps the mount-time and window-resize firings from writing
      // anything: this callback runs whenever the layout changes for any
      // reason, not only when the user moved something.
      //
      // The breakpoint guard is the important one. At `sm` every widget is
      // collapsed to a single full-width column, and persisting that would
      // silently flatten the desktop arrangement the moment someone opened the
      // dashboard on a phone.
      if (!editing || breakpoint !== "lg") return;
      setWidgets((current) => {
        if (!current) return current;
        const byId = new Map(items.map((i) => [i.i, i]));
        const next = current.map((w) => {
          const pos = byId.get(w.i);
          return pos ? { ...w, x: pos.x, y: pos.y, w: pos.w, h: pos.h } : w;
        });
        const moved = next.some(
          (w, i) =>
            w.x !== current[i].x || w.y !== current[i].y ||
            w.w !== current[i].w || w.h !== current[i].h,
        );
        if (moved) save(next);
        return moved ? next : current;
      });
    },
    [save, editing, breakpoint],
  );

  const addWidget = useCallback(
    (kind: string) => {
      const spec = BY_KIND.get(kind);
      if (!spec) return;
      setWidgets((current) => {
        const list = current ?? [];
        // The row below everything else. RGL accepts Infinity here to mean
        // "bottom", but this value is also persisted -- and JSON.stringify
        // turns Infinity into null, which the server rejects as a missing
        // integer. So the bottom row is computed rather than signalled.
        const bottom = list.reduce((max, w) => Math.max(max, w.y + w.h), 0);
        const next = [
          ...list,
          {
            i: `${kind}-${Date.now().toString(36)}`,
            kind,
            x: 0,
            y: bottom,
            w: spec.defaultW,
            h: spec.defaultH,
            config: {},
          },
        ];
        save(next);
        return next;
      });
      setPicking(false);
      setEditing(true);
    },
    [save],
  );

  const removeWidget = useCallback(
    (id: string) => {
      setWidgets((current) => {
        const next = (current ?? []).filter((w) => w.i !== id);
        save(next);
        return next;
      });
    },
    [save],
  );

  const setConfig = useCallback(
    (id: string, config: Record<string, unknown>) => {
      setWidgets((current) => {
        const next = (current ?? []).map((w) => (w.i === id ? { ...w, config } : w));
        save(next);
        return next;
      });
    },
    [save],
  );

  // The measured element has to exist from the first render and must never be
  // swapped. Returning a skeleton before it mounts leaves the width hook
  // observing nothing, and the grid then lays out against its 1280px default --
  // which overflows every container narrower than that.
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Bottom padding clears the floating bar, so the last widget is never
          sitting underneath it. */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 space-y-4 overflow-auto px-4 pb-[calc(132px+env(safe-area-inset-bottom))] lg:pb-20 pt-4 sm:px-6"
      >
      {error && <Banner>{error}</Banner>}

      {!widgets ? (
        <SkeletonList rows={3} height="h-40" />
      ) : (
        <>
          {widgets.length === 0 ? (
            <div className="rounded-card bg-surface p-8 text-center">
              <div className="text-body text-muted">This dashboard is empty.</div>
              <div className="mt-3">
                <Button onClick={() => setPicking(true)}>Add a widget</Button>
              </div>
            </div>
          ) : (
            <Responsive
              className="-mx-2"
              width={width}
              layouts={layoutsFor(widgets)}
              breakpoints={BREAKPOINTS}
              cols={COLS}
              rowHeight={ROW_H}
              margin={[12, 12]}
              containerPadding={[8, 0]}
              /* A resize handle inside a 60px-tall touch target is not usable,
                 so a phone gets a read-only single column, not a bad gesture. */
              dragConfig={{ enabled: editing && !narrow, handle: ".widget-grip" }}
              resizeConfig={{ enabled: editing && !narrow }}
              /* Transforms animate; absolute positioning jumps. Someone who has
                 asked the OS for less motion gets the jump. */
              positionStrategy={prefersReducedMotion() ? absoluteStrategy : transformStrategy}
              onBreakpointChange={(bp) => setBreakpoint(bp as keyof typeof COLS)}
              /* All three, deliberately. onLayoutChange is the documented
                 "changed for any reason" hook; the two gesture callbacks are
                 belt and braces in case a release only fires one of them. The
                 handler diffs before writing, so extra calls cost nothing. */
              onLayoutChange={onLayoutChange}
              onDragStop={onLayoutChange}
              onResizeStop={onLayoutChange}
            >
              {widgets.map((w) => {
                const spec = BY_KIND.get(w.kind);
                return (
                  <div key={w.i}>
                    <WidgetFrame
                      title={spec?.title ?? w.kind}
                      editing={editing}
                      onRemove={() => removeWidget(w.i)}
                    >
                      {spec ? (
                        <spec.Component
                          data={data}
                          config={w.config ?? {}}
                          setConfig={(next) => setConfig(w.i, next)}
                          onNavigate={onNavigate}
                        />
                      ) : (
                        <UnknownWidget kind={w.kind} />
                      )}
                    </WidgetFrame>
                  </div>
                );
              })}
            </Responsive>
          )}

          {picking && (
            <AddWidget
              present={new Set(widgets.map((w) => w.kind))}
              onAdd={addWidget}
              onClose={() => setPicking(false)}
            />
          )}
        </>
      )}
      </div>

      {/* Same floating chrome as the tree and the roadmap: a hint on the left
          for what the current mode does, actions on the right. */}
      {widgets && (
        <>
          <ViewBarLeft>
            <span className="px-1 py-1.5 text-caption text-faint">
              {editing
                ? "Drag to move, pull the corner to resize."
                : `${widgets.length} Widget${widgets.length === 1 ? "" : "s"}`}
            </span>
          </ViewBarLeft>

          {/* No edit affordance at phone width: the grid is a single read-only
              column there, so the button would promise a mode that cannot do
              anything. */}
          {!narrow && (
            <ViewBarRight>
              {editing && (
                <ViewButton onClick={() => setPicking(true)}>+ Add Widget</ViewButton>
              )}
              <ViewButton onClick={() => setEditing((e) => !e)}>
                {editing ? "Done" : "Edit Layout"}
              </ViewButton>
            </ViewBarRight>
          )}
        </>
      )}
    </div>
  );
}

function layoutsFor(widgets: WidgetPlacement[]) {
  return {
    lg: widgets.map(toItem),
    md: widgets.map((w) => ({ ...toItem(w), w: Math.min(w.w, COLS.md) })),
    sm: widgets.map((w, i) => ({ ...toItem(w), x: 0, y: i, w: 1 })),
  };
}

function toItem(w: WidgetPlacement): LayoutItem {
  const spec = BY_KIND.get(w.kind);
  return {
    i: w.i,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    minW: spec?.minW ?? 2,
    minH: spec?.minH ?? 2,
  };
}
