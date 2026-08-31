import { Gate, Rows } from "./shared";
import { activeGoals } from "./selectors";
import { Tag } from "../Primitives";
import { chart } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/**
 * The self-assessed progress curve, and only the curve.
 *
 * D12 is emphatic that this number is never read by the metrics or planning
 * engine — not for projection, pace, feasibility, scoring or calibration. Its
 * one downstream use is stall detection (§24.9), and the reason to store the
 * whole series is that the shape tells a story a single number cannot:
 * 40 → 60 → 75 → 80 → 80 → 80 usually means the remaining work was
 * underestimated, which argues for cutting scope rather than pushing harder.
 *
 * The caption saying it feeds nothing is part of the widget, not decoration.
 */
export function SelfAssessedSeries({ data }: WidgetProps) {
  return (
    <Gate value={data.portfolio}>
      {(portfolio) => {
        const rows = activeGoals(portfolio)
          .flatMap((goal) => goal.milestones.map((m) => ({ goal, m })))
          .filter(({ m }) => m.stall.series.length > 0);

        if (rows.length === 0) {
          return (
            <div className="text-body-sm text-muted">
              No self-assessments recorded. The slider is offered when a session ends and
              is always skippable.
            </div>
          );
        }

        return (
          <div className="space-y-3">
            <Rows>
              {rows.map(({ goal, m }) => (
                <div key={m.milestone_id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body-sm text-ink">{m.title}</span>
                    <span className="shrink-0 font-mono text-footnote tabular-nums text-muted">
                      {m.stall.latest_pct === null ? "—" : `${Math.round(m.stall.latest_pct)}%`}
                    </span>
                  </div>
                  <Spark series={m.stall.series} stalled={m.stall.stalled} />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-faint">
                    <span>{goal.title}</span>
                    {m.stall.stalled && (
                      <Tag tone="warn">
                        flat for {m.stall.sessions_since_movement} sessions
                      </Tag>
                    )}
                  </div>
                </div>
              ))}
            </Rows>
            <div className="border-t border-line pt-2 text-footnote text-faint">
              Not an input to any score. Pace, feasibility and health ignore it entirely.
            </div>
          </div>
        );
      }}
    </Gate>
  );
}

function Spark({ series, stalled }: { series: number[]; stalled: boolean }) {
  const W = 200;
  const H = 26;
  if (series.length < 2) {
    return <div className="h-[26px] text-footnote text-faint">One Reading So Far</div>;
  }
  const points = series
    .map((v, i) => `${(i / (series.length - 1)) * W},${H - (Math.max(0, Math.min(v, 100)) / 100) * H}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[26px] w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Self-assessed progress: ${series.join(", ")} percent`}
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        stroke={stalled ? chart.warn() : chart.cyan()}
      />
    </svg>
  );
}
