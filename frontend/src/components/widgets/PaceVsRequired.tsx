import { Gate, Rows } from "./shared";
import { flattenTrackables } from "./selectors";
import { Tag } from "../Primitives";
import { basisLabel, num, titleCase } from "../../lib/format";
import { chart } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/**
 * Measured pace against the rate the commitment demands.
 *
 * D8: the interval is displayed, never propagated. One point estimate drives
 * every downstream number; the band exists so the user can tell a bad week from
 * a real slip, and it gates exactly one decision — whether to rebaseline. While
 * it is wide it is labelled provisional, because a narrow-looking band at n=2
 * is noise dressed as precision.
 */
export function PaceVsRequired({ data }: WidgetProps) {
  return (
    <Gate value={data.portfolio}>
      {(portfolio) => {
        const rows = flattenTrackables(portfolio);
        if (rows.length === 0) {
          return <div className="text-body-sm text-muted">No metered work yet.</div>;
        }
        return (
          <Rows>
            {rows.map(({ trackable: t }) => {
              const required = t.required_pace?.point ?? null;
              const span = Math.max(
                t.pace.interval?.high ?? t.pace.point ?? 0,
                required ?? 0,
                1,
              );
              const at = (v: number | null) => ((v ?? 0) / span) * 100;
              return (
                <div key={t.trackable_id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body-sm text-ink">{t.title}</span>
                    <span className="shrink-0 font-mono text-footnote tabular-nums text-muted">
                      {num(t.pace.point)} <span className="text-faint">of</span>{" "}
                      {required === null ? "—" : num(required)} {t.unit}
                    </span>
                  </div>

                  <div className="relative h-4">
                    {t.pace.interval && (
                      <div
                        className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[2px]"
                        style={{
                          left: `${at(t.pace.interval.low)}%`,
                          width: `${Math.max(at(t.pace.interval.high) - at(t.pace.interval.low), 1)}%`,
                          background: chart.iris(),
                          opacity: t.pace.interval.provisional ? 0.3 : 0.6,
                        }}
                      />
                    )}
                    <div
                      className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink"
                      style={{ left: `${at(t.pace.point)}%` }}
                    />
                    {required !== null && (
                      <div
                        className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded-full"
                        style={{ left: `${at(required)}%`, background: chart.cyan() }}
                        title={`required: ${num(required)} ${t.unit}/session`}
                      />
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-faint">
                    <span>{basisLabel(t.pace.basis, t.pace.n_sessions)}</span>
                    {t.pace.interval?.provisional && <Tag tone="warn">Provisional</Tag>}
                    {t.required_pace && (
                      <span>From {titleCase(t.required_pace.denominator_source)}</span>
                    )}
                    {/* The dimensionless readings, kept apart on purpose (D6):
                        one is about the user, the other about the plan. Absent
                        means absent -- neither is rendered as 1.0 (P2). */}
                    {t.pace_scores.pace !== null && (
                      <span>pace {num(t.pace_scores.pace, 2)}×</span>
                    )}
                    {t.pace_scores.track !== null && (
                      <span>on-track {num(t.pace_scores.track, 2)}×</span>
                    )}
                  </div>
                </div>
              );
            })}
          </Rows>
        );
      }}
    </Gate>
  );
}
