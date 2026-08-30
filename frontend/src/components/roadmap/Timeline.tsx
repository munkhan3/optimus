import { useMemo, useState } from "react";
import { AxisTop } from "@visx/axis";
import { Group } from "@visx/group";
import { scaleTime } from "@visx/scale";
import type { Roadmap, RoadmapRow } from "../../lib/dashboard";
import { axisProps, chart, feasibilityTone, toneColor } from "../../lib/chartTheme";
import { dateShort } from "../../lib/format";

const LABEL_W = 260;
/** Rows inside one goal sit close together... */
const ROW_H = 28;
/** ...and this much further apart between goals, so the grouping is visible
    before you have read a single label. */
const GROUP_GAP = 20;
const TOP = 30;
const BAR_H = 6;
const PAD = 12;
// A bar narrower than this is invisible. Work whose deadline sits at or before
// its start date produces one, and a row that renders nothing at all reads as
// missing data rather than as a very short piece of work.
const MIN_BAR = 6;

interface Placed {
  row: RoadmapRow;
  depth: number;
  y: number;
  /** True for the first row of a goal that is not the first goal. */
  startsGroup: boolean;
}

/**
 * Rows of work against a calendar ruler, with the original plan drawn behind
 * the current one.
 *
 * This is the mode that earns its place. §17: "three rebaselines in, the user
 * must be able to see that this began as ten sessions targeting October."
 * Silent deadline extension is how a goal drifts for months without ever
 * formally failing, and a version-1 ghost bar sitting behind the current bar is
 * what makes that drift impossible to miss.
 *
 * Work with no target date gets an open-ended bar. Substituting today, or the
 * parent's deadline, would put a date on screen that nobody chose (P2).
 */
export function Timeline({ roadmap }: { roadmap: Roadmap }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const placed = useMemo(() => layout(roadmap.rows, collapsed), [roadmap.rows, collapsed]);
  const domain = useMemo(() => extent(roadmap), [roadmap]);

  const [width, setWidth] = useState(900);
  const innerW = Math.max(width - LABEL_W - PAD * 2, 220);
  const height = (placed.at(-1)?.y ?? 0) + ROW_H + TOP;

  const x = scaleTime<number>({ domain, range: [0, innerW] });
  const today = new Date(`${roadmap.as_of}T00:00:00`);

  if (placed.length === 0) {
    return <div className="text-body-sm text-muted">Nothing on the roadmap yet.</div>;
  }

  return (
    <div
      className="overflow-x-auto"
      ref={(el) => {
        if (el && Math.abs(el.clientWidth - width) > 8) setWidth(el.clientWidth);
      }}
    >
      <svg
        width={Math.max(width, 640)}
        height={height}
        role="img"
        aria-label="Goal roadmap timeline"
      >
        <Group left={LABEL_W} top={TOP}>
          <AxisTop scale={x} {...axisProps} numTicks={6} top={-6} />
          <line
            x1={x(today)}
            x2={x(today)}
            y1={-2}
            y2={height - TOP}
            stroke={chart.ink()}
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        </Group>

        {placed.map(({ row, depth, y, startsGroup }) => {
          const tone = feasibilityTone(
            row.feasibility?.margin_sessions,
            row.feasibility?.feasible,
          );
          const parked = row.activation === "parked";
          const base = row.baselines?.original;
          const current = row.baselines?.current;
          const rowStart = row.start ? new Date(`${row.start}T00:00:00`) : today;

          return (
            <Group key={row.key} left={LABEL_W} top={TOP + y}>
              {/* A hairline between goals. The gap alone reads as an accident
                  once the list is long; a rule reads as structure. */}
              {startsGroup && (
                <line
                  x1={-LABEL_W}
                  x2={innerW}
                  y1={-GROUP_GAP / 2}
                  y2={-GROUP_GAP / 2}
                  stroke={chart.line()}
                  strokeWidth={1}
                />
              )}

              <foreignObject x={-LABEL_W} y={-6} width={LABEL_W - 10} height={ROW_H}>
                <button
                  onClick={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(row.key)) next.delete(row.key);
                      else next.add(row.key);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-1 truncate text-left text-body-sm transition hover:text-ink"
                  style={{
                    paddingLeft: depth * 14,
                    color: parked ? "var(--color-faint)" : "var(--color-ink)",
                    opacity: parked ? 0.7 : 1,
                    // A goal names itself a little louder than its parts.
                    fontWeight: depth === 0 ? 500 : 400,
                  }}
                  title={parked ? `${row.title} (parked)` : row.title}
                >
                  {row.children.length > 0 && (
                    <span className="text-faint">{collapsed.has(row.key) ? "▸" : "▾"}</span>
                  )}
                  <span className="truncate">{row.title}</span>
                </button>
              </foreignObject>

              {base && base.target_date !== current?.target_date && (
                <rect
                  x={x(rowStart)}
                  y={-4}
                  width={Math.max(
                    x(new Date(`${base.target_date}T00:00:00`)) - x(rowStart),
                    MIN_BAR,
                  )}
                  height={BAR_H - 2}
                  rx={2}
                  fill={chart.line()}
                  opacity={0.85}
                >
                  <title>{`originally targeting ${dateShort(base.target_date)}`}</title>
                </rect>
              )}

              <PlanBar
                row={row}
                x={x}
                start={rowStart}
                tone={tone}
                parked={parked}
                innerW={innerW}
              />

              {row.completed_at && (
                <rect
                  x={x(rowStart)}
                  y={BAR_H + 3}
                  width={Math.max(
                    x(new Date(`${row.completed_at}T00:00:00`)) - x(rowStart),
                    MIN_BAR,
                  )}
                  height={4}
                  rx={2}
                  /* White, not green. The current bar is toned by feasibility,
                     so a feasible plan is already green -- colouring "what
                     actually happened" the same way made the two impossible to
                     tell apart, and the legend was then simply wrong. */
                  fill={chart.ink()}
                >
                  <title>{`finished ${dateShort(row.completed_at)}`}</title>
                </rect>
              )}
            </Group>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The key, rendered by the Roadmap into the fixed top-right slot.
 *
 * It lives up there rather than under the chart because anchored below it moves
 * every time a goal is expanded or added, and a legend that relocates whenever
 * the data grows is one you have to find again each time.
 */
export function TimelineLegend() {
  return (
    <>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-1 w-5 rounded-full bg-line" /> Original Plan
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex overflow-hidden rounded-full">
          {(["good", "warn", "bad"] as const).map((tone) => (
            <span
              key={tone}
              className="inline-block h-1.5 w-2"
              style={{ background: toneColor[tone] }}
            />
          ))}
        </span>
        Current — Toned by Feasibility
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-1 w-5 rounded-full bg-ink" /> Actual
      </span>
      <span>Parked Work Is Dimmed, Never Hidden</span>
    </>
  );
}

function PlanBar({
  row,
  x,
  start,
  tone,
  parked,
  innerW,
}: {
  row: RoadmapRow;
  x: (d: Date) => number;
  start: Date;
  tone: ReturnType<typeof feasibilityTone>;
  parked: boolean;
  innerW: number;
}) {
  const x0 = x(start);
  if (!row.end) {
    // Open-ended: a fading bar, never a guessed end date.
    return (
      <>
        <defs>
          <linearGradient id={`fade-${row.key}`} x1="0" x2="1">
            <stop offset="0%" stopColor={toneColor[tone]} stopOpacity={parked ? 0.25 : 0.55} />
            <stop offset="100%" stopColor={toneColor[tone]} stopOpacity={0} />
          </linearGradient>
        </defs>
        <rect
          x={x0}
          y={2}
          width={Math.max(innerW - x0, MIN_BAR)}
          height={BAR_H}
          rx={2}
          fill={`url(#fade-${row.key})`}
        >
          <title>No Target Date — Open Ended</title>
        </rect>
      </>
    );
  }
  const x1 = x(new Date(`${row.end}T00:00:00`));
  return (
    <rect
      x={x0}
      y={2}
      width={Math.max(x1 - x0, MIN_BAR)}
      height={BAR_H}
      rx={2}
      fill={toneColor[tone]}
      opacity={parked ? 0.3 : 0.9}
    >
      <title>{`${row.title}: ${dateShort(row.start)} → ${dateShort(row.end)}`}</title>
    </rect>
  );
}

/** Flatten the tree and assign each visible row a y, grouping by goal. */
function layout(rows: RoadmapRow[], collapsed: Set<string>): Placed[] {
  const out: Placed[] = [];
  let y = 0;

  const walk = (nodes: RoadmapRow[], depth: number) => {
    for (const row of nodes) {
      // Only a top-level goal opens a group, and never the very first one --
      // there is nothing above it to be separated from.
      const startsGroup = depth === 0 && out.length > 0;
      if (startsGroup) y += GROUP_GAP;
      out.push({ row, depth, y, startsGroup });
      y += ROW_H;
      if (!collapsed.has(row.key)) walk(row.children, depth + 1);
    }
  };
  walk(rows, 0);
  return out;
}

/** The window the chart covers: every date it has, padded a fortnight either side. */
function extent(roadmap: Roadmap): [Date, Date] {
  const dates: number[] = [new Date(`${roadmap.as_of}T00:00:00`).getTime()];
  const walk = (rows: RoadmapRow[]) => {
    for (const r of rows) {
      for (const iso of [r.start, r.end, r.completed_at, r.baselines?.original?.target_date]) {
        if (iso) dates.push(new Date(`${iso}T00:00:00`).getTime());
      }
      walk(r.children);
    }
  };
  walk(roadmap.rows);
  const pad = 14 * 86400000;
  return [new Date(Math.min(...dates) - pad), new Date(Math.max(...dates) + pad)];
}
