import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The goal graph as a node-link diagram.
 *
 * Hand-rolled SVG rather than a charting dependency, matching the metrics
 * engine's zero-dependency posture and keeping the bundle honest.
 *
 * One component serves two callers with different data: the live proposal
 * during intake, and the persisted tree in the app. Both adapt into TreeNode,
 * so layout, pan/zoom, and the meaning of each visual state are defined once.
 */

export interface TreeNode {
  key: string;
  kind: "goal" | "milestone" | "trackable";
  title: string;
  subtitle?: string;
  /** Null means unknowable, and renders empty rather than as 0% or 100% (P2). */
  fraction?: number | null;
  flags?: {
    /** D3: the value was inferred, not measured. Visible wherever it appears. */
    estimated?: boolean;
    /** §10: no natural counter, budgeted in sessions instead of fake units. */
    exploratory?: boolean;
    /** §12: stored and visible, but competing for nothing. */
    parked?: boolean;
  };
  children?: TreeNode[];
}

const NODE_W = 216;
const NODE_H = 78;
const COL_GAP = 76;
const ROW_GAP = 14;

interface Placed {
  node: TreeNode;
  depth: number;
  x: number;
  y: number;
}

interface Edge {
  from: Placed;
  to: Placed;
}

/**
 * Tiered layout. The graph is a strict three-level hierarchy, so the bottom-up
 * "stack children, centre the parent over them" rule is sufficient and there is
 * no need for a general tidy-tree algorithm.
 */
function layout(roots: TreeNode[]): { placed: Placed[]; edges: Edge[]; w: number; h: number } {
  const placed: Placed[] = [];
  const edges: Edge[] = [];
  let cursor = 0;
  let maxDepth = 0;

  function walk(node: TreeNode, depth: number): Placed {
    maxDepth = Math.max(maxDepth, depth);
    const children = node.children ?? [];

    let y: number;
    if (children.length === 0) {
      y = cursor;
      cursor += NODE_H + ROW_GAP;
    } else {
      const kids = children.map((c) => walk(c, depth + 1));
      // Centre the parent on the span of its children, so an edge never
      // crosses another node.
      y = (kids[0].y + kids[kids.length - 1].y) / 2;
      const self: Placed = { node, depth, x: depth * (NODE_W + COL_GAP), y };
      placed.push(self);
      kids.forEach((k) => edges.push({ from: self, to: k }));
      return self;
    }

    const self: Placed = { node, depth, x: depth * (NODE_W + COL_GAP), y };
    placed.push(self);
    return self;
  }

  roots.forEach((r) => {
    walk(r, 0);
    cursor += ROW_GAP * 2; // breathing room between separate goals
  });

  return {
    placed,
    edges,
    w: (maxDepth + 1) * (NODE_W + COL_GAP),
    h: Math.max(cursor, NODE_H),
  };
}

export function GoalTree({
  roots,
  highlight,
  onSelect,
  selectedKey,
  className = "",
}: {
  roots: TreeNode[];
  /** Keys that appeared this turn — animated in, so growth is visible. */
  highlight?: Set<string>;
  onSelect?: (node: TreeNode) => void;
  selectedKey?: string | null;
  className?: string;
}) {
  const { placed, edges, w, h } = useMemo(() => layout(roots), [roots]);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  const fit = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || w === 0 || h === 0) return;
    const k = Math.min((box.width - 48) / w, (box.height - 48) / h, 1);
    setView({ x: 24, y: Math.max(24, (box.height - h * k) / 2), k: Math.max(k, 0.35) });
  }, [w, h]);

  // Re-fit when the shape changes materially — during intake the tree grows
  // under the user, and a view that stays put would let new nodes appear
  // offscreen, which is precisely the moment they most need to be seen.
  useEffect(() => {
    fit();
  }, [placed.length, fit]);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    setView((v) => ({ ...v, k: Math.min(2, Math.max(0.3, v.k * (1 - e.deltaY * 0.0015))) }));
  }

  return (
    <div
      ref={frame}
      // select-none: dragging to pan must not sweep-select every label.
      className={`relative select-none overflow-hidden rounded-2xl bg-bg ${className}`}
    >
      {roots.length === 0 ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-faint">
          Your goals will appear here as you talk.
        </div>
      ) : (
        <>
          <svg
            className="size-full cursor-grab touch-none active:cursor-grabbing"
            onWheel={onWheel}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              // Read the ref ONCE, synchronously. Dereferencing it inside the
              // setView updater is a race: React may run that updater after
              // onPointerUp has already nulled the ref, which throws and takes
              // the whole tree down mid-drag.
              const origin = drag.current;
              if (!origin) return;
              const x = e.clientX - origin.x;
              const y = e.clientY - origin.y;
              setView((v) => ({ ...v, x, y }));
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {edges.map((e, i) => {
                const x1 = e.from.x + NODE_W;
                const y1 = e.from.y + NODE_H / 2;
                const x2 = e.to.x;
                const y2 = e.to.y + NODE_H / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--color-line)"
                    strokeWidth={1.5}
                  />
                );
              })}

              {placed.map((p) => (
                <foreignObject
                  key={p.node.key}
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={NODE_H}
                  style={{ overflow: "visible" }}
                >
                  <NodeCard
                    node={p.node}
                    isNew={highlight?.has(p.node.key) ?? false}
                    selected={selectedKey === p.node.key}
                    onSelect={onSelect}
                  />
                </foreignObject>
              ))}
            </g>
          </svg>

          <button
            onClick={fit}
            className="absolute bottom-3 right-3 rounded-lg bg-surface px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-ink"
          >
            Fit
          </button>
        </>
      )}
    </div>
  );
}

const KIND_LABEL = { goal: "Goal", milestone: "Milestone", trackable: "Trackable" } as const;

function NodeCard({
  node,
  isNew,
  selected,
  onSelect,
}: {
  node: TreeNode;
  isNew: boolean;
  selected: boolean;
  onSelect?: (n: TreeNode) => void;
}) {
  const f = node.flags ?? {};
  const ring = selected
    ? "ring-2 ring-accent"
    : isNew
      ? "ring-2 ring-accent/60"
      : f.estimated
        ? "ring-1 ring-warn/50"
        : "ring-1 ring-line";

  return (
    <div
      onClick={() => onSelect?.(node)}
      style={{
        width: NODE_W,
        height: NODE_H,
        animation: isNew ? "nodeIn 420ms cubic-bezier(0.2,0.8,0.2,1)" : undefined,
      }}
      className={`flex cursor-pointer flex-col justify-center rounded-xl bg-surface px-3 py-2 transition ${ring} ${
        f.parked ? "opacity-45" : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="section-label">{KIND_LABEL[node.kind]}</span>
        {f.exploratory && <span className="text-[10px] text-accent">exploratory</span>}
        {f.parked && <span className="text-[10px] text-faint">parked</span>}
      </div>

      <div className="truncate text-[13px] font-semibold leading-tight text-ink">
        {node.title}
      </div>

      {node.subtitle && (
        <div className="truncate text-[11px] leading-tight text-faint">{node.subtitle}</div>
      )}

      {node.fraction !== undefined && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-raised">
          {node.fraction !== null && (
            <div
              className="h-1 rounded-full bg-accent"
              style={{ width: `${Math.min(100, Math.max(0, node.fraction * 100))}%` }}
            />
          )}
        </div>
      )}
    </div>
  );
}
