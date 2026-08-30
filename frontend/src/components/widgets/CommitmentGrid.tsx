import { useEffect, useState } from "react";
import { HeatmapRect } from "@visx/heatmap";
import { scaleLinear } from "@visx/scale";
import { getActivity, type Activity } from "../../lib/dashboard";
import { ApiError } from "../../lib/api";
import { intensity } from "../../lib/chartTheme";
import { Banner, Skeleton, Tag } from "../Primitives";
import { num, titleCase } from "../../lib/format";
import type { WidgetProps } from "./types";

const CELL = 11;
const GAP = 3;
const DAYS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

/**
 * Weeks across, weekdays down — the shape everyone already knows how to read.
 *
 * What it is NOT is a streak tracker. vision.md §7 rules those out and §3 says
 * why: "checkboxes and streaks reward motion. A day of checked boxes and a day
 * of real progress look identical." So a cell's intensity is the amount of work
 * produced that day, not the fact that something was logged, and the summary
 * underneath is met-or-missed against the target a recurring commitment
 * actually signed up for (§12) rather than a count of consecutive days.
 *
 * There is deliberately no streak number anywhere in this file.
 */
export function CommitmentGrid({ config }: WidgetProps) {
  const weeks = typeof config.weeks === "number" ? config.weeks : 26;
  const goalId = typeof config.goal_id === "number" ? config.goal_id : undefined;

  // Keyed by the request it answers, so changing the scope shows a skeleton
  // again without clearing state synchronously inside the effect (which would
  // start a second render every time the widget re-mounts).
  const key = `${weeks}|${goalId ?? ""}`;
  const [result, setResult] = useState<{
    key: string;
    activity: Activity | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    getActivity({ weeks, goalId })
      .then((a) => live && setResult({ key, activity: a, error: null }))
      .catch(
        (e) =>
          live &&
          setResult({
            key,
            activity: null,
            error: e instanceof ApiError ? e.message : String(e),
          }),
      );
    return () => {
      live = false;
    };
  }, [weeks, goalId, key]);

  const fresh = result?.key === key ? result : null;
  if (fresh?.error) return <Banner>{fresh.error}</Banner>;
  const activity = fresh?.activity;
  if (!activity) return <Skeleton className="h-[120px]" />;

  // Columns are weeks, rows are weekdays. The range always starts on a Monday,
  // so the grid begins on a clean column boundary.
  const start = new Date(`${activity.from}T00:00:00`);
  const byDate = new Map(activity.days.map((d) => [d.date, d]));
  const weekCount = Math.ceil(activity.days.length / 7);

  const bins = Array.from({ length: weekCount }, (_, w) => ({
    bin: w,
    bins: Array.from({ length: 7 }, (_, d) => {
      const day = new Date(start);
      day.setDate(day.getDate() + w * 7 + d);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
        day.getDate(),
      ).padStart(2, "0")}`;
      const cell = byDate.get(key);
      return {
        bin: d,
        count: cell ? cell[activity.basis] : 0,
        date: key,
        inRange: Boolean(cell),
        sessions: cell?.sessions ?? 0,
      };
    }),
  }));

  const width = weekCount * (CELL + GAP);
  const height = 7 * (CELL + GAP);
  const xScale = scaleLinear<number>({ domain: [0, weekCount], range: [0, width] });
  const yScale = scaleLinear<number>({ domain: [0, 7], range: [0, height] });

  const total = activity.days.reduce((sum, d) => sum + d[activity.basis], 0);
  // The unit string is the user's own word and is left exactly as they wrote
  // it; "minutes" is ours, so it is ours to get right.
  const label =
    activity.basis === "units" ? activity.unit : total === 1 ? "minute" : "minutes";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="display text-heading">{num(total, 0)}</span>
        <span className="text-body-sm text-muted">
          {titleCase(label)} Over {weeks} Weeks
        </span>
        {/* Only when there genuinely ARE several units. An account with no
            trackables at all also falls back to minutes, and telling that user
            their units are "mixed" describes something that does not exist. */}
        {activity.basis === "minutes" && activity.peak > 0 && (
          <Tag tone="neutral">Mixed Units — Showing Time</Tag>
        )}
      </div>

      {/* shrink-0: the frame scrolls, so this row must keep its natural
          height rather than be squeezed by its siblings. */}
      <div className="flex shrink-0 gap-2 overflow-x-auto">
        <div
          className="flex shrink-0 flex-col justify-between pt-px font-mono text-[9px] uppercase tracking-[0.1em] text-faint"
          style={{ height }}
          aria-hidden="true"
        >
          {DAYS.map((d, i) => (
            <span key={i} style={{ height: CELL, lineHeight: `${CELL}px` }}>
              {d}
            </span>
          ))}
        </div>

        <svg
          width={width}
          height={height}
          className="shrink-0"
          role="img"
          aria-label={`Work produced per day over the last ${weeks} weeks`}
        >
          <HeatmapRect
            data={bins}
            xScale={(v) => xScale(v) ?? 0}
            yScale={(v) => yScale(v) ?? 0}
            binWidth={CELL}
            binHeight={CELL}
            gap={GAP}
          >
            {(heatmap) =>
              heatmap.map((columns) =>
                columns.map((bin) => {
                  const datum = bin.bin as unknown as {
                    count: number;
                    date: string;
                    inRange: boolean;
                    sessions: number;
                  };
                  if (!datum.inRange) return null;
                  // The fill comes from our token ramp rather than visx's
                  // colorScale: an unworked day has to read as the empty
                  // surface, not as the faintest ink, or the grid stops being
                  // evidence of anything.
                  const { fill } = intensity(datum.count, activity.peak);
                  return (
                    <rect
                      key={`${bin.row}-${bin.column}`}
                      x={bin.x}
                      y={bin.y}
                      width={bin.width}
                      height={bin.height}
                      rx={2}
                      fill={fill}
                    >
                      <title>
                        {datum.date}:{" "}
                        {datum.count > 0 ? `${num(datum.count, 1)} ${label}` : "Nothing Logged"}
                        {datum.sessions
                          ? ` · ${datum.sessions} session${datum.sessions === 1 ? "" : "s"}`
                          : ""}
                      </title>
                    </rect>
                  );
                }),
              )
            }
          </HeatmapRect>
        </svg>
      </div>

      <Legend peak={activity.peak} label={label} />
      <PeriodRows periods={activity.periods} />
    </div>
  );
}

function Legend({ peak, label }: { peak: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
      <span>Less</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <span
          key={level}
          className="inline-block size-[9px] rounded-[2px]"
          style={{ background: intensity(level === 0 ? 0 : (level / 4) * peak, peak).fill }}
        />
      ))}
      <span>More {titleCase(label)}</span>
    </div>
  );
}

/**
 * Met-or-missed per reset window (§12).
 *
 * Only recurring commitments appear here. A terminating goal has no weekly
 * pass/fail, and inventing one would be the "measures activity, not progress"
 * failure the grid above exists to avoid.
 */
function PeriodRows({ periods }: { periods: Activity["periods"] }) {
  if (periods.length === 0) return null;
  const byTrackable = new Map<number, Activity["periods"]>();
  for (const p of periods) {
    byTrackable.set(p.trackable_id, [...(byTrackable.get(p.trackable_id) ?? []), p]);
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      {[...byTrackable.entries()].map(([id, rows]) => (
        <div key={id}>
          <div className="mb-1 truncate text-body-sm text-muted">{rows[0].title}</div>
          <div className="flex flex-wrap gap-1">
            {rows.map((p) => (
              <span
                key={p.start}
                title={`${p.start} – ${p.end}: ${num(p.done, 0)} of ${num(p.target, 0)} ${p.unit}`}
                className="inline-flex h-5 min-w-[34px] items-center justify-center rounded-[3px] px-1.5 font-mono text-[9px] tabular-nums"
                style={{
                  background:
                    p.met === null
                      ? "var(--color-raised)"
                      : p.met
                        ? "color-mix(in oklab, var(--color-good) 22%, var(--color-abyss))"
                        : "color-mix(in oklab, var(--color-bad) 22%, var(--color-abyss))",
                  color:
                    p.met === null
                      ? "var(--color-muted)"
                      : p.met
                        ? "var(--color-good)"
                        : "var(--color-bad)",
                }}
              >
                {num(p.done, 0)}/{num(p.target, 0)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
