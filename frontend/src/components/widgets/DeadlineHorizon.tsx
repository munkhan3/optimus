import { Gate, Rows } from "./shared";
import { activeGoals, isOpen } from "./selectors";
import { Tag } from "../Primitives";
import { dateShort, goalTiming, num } from "../../lib/format";
import { feasibilityTone, toneColor } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/** What is due, soonest first, with whether it still fits. */
export function DeadlineHorizon({ data }: WidgetProps) {
  return (
    <Gate value={data.portfolio}>
      {(portfolio) => {
        const today = new Date(`${portfolio.as_of}T00:00:00`);
        const rows = activeGoals(portfolio)
          .flatMap((goal) => [
            ...goal.trackables.filter(isOpen).map((t) => ({
              key: `t${t.trackable_id}`,
              title: t.title,
              context: goal.title,
              date: t.projection.target_date ?? goal.deadline,
              feasibility: t.feasibility,
              recurring: goal.pace_mode === "reset_period",
              timing: goalTiming(goal),
            })),
            ...goal.milestones.filter(isOpen).map((m) => ({
              key: `m${m.milestone_id}`,
              title: m.title,
              context: goal.title,
              date: goal.deadline,
              feasibility: m.feasibility,
              recurring: goal.pace_mode === "reset_period",
              timing: goalTiming(goal),
            })),
          ])
          .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

        if (rows.length === 0) {
          return <div className="text-body-sm text-muted">Nothing active with a deadline.</div>;
        }

        return (
          <Rows>
            {rows.map((row) => {
              const tone = feasibilityTone(
                row.feasibility.margin_sessions,
                row.feasibility.feasible,
              );
              const days =
                row.date === null
                  ? null
                  : Math.round(
                      (new Date(`${row.date}T00:00:00`).getTime() - today.getTime()) / 86400000,
                    );
              return (
                <div key={row.key} className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-body-sm text-ink">{row.title}</div>
                    <div className="truncate text-footnote text-faint">{row.context}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className="font-mono text-footnote tabular-nums"
                      style={{ color: toneColor[tone] }}
                    >
                      {/* A recurring commitment has a deadline every period, not
                          a date (§12). Saying "no deadline" would be the exact
                          opposite of the truth about it. */}
                      {row.recurring ? row.timing : dateShort(row.date)}
                    </div>
                    <div className="text-footnote text-faint">
                      {row.feasibility.feasible === false
                        ? "Does Not Fit"
                        : days === null
                          ? ""
                          : `${num(days, 0)}d`}
                    </div>
                  </div>
                </div>
              );
            })}
            {rows.some((r) => r.feasibility.feasible === false) && (
              <div className="pt-1">
                <Tag tone="bad">Something No Longer Fits</Tag>
              </div>
            )}
          </Rows>
        );
      }}
    </Gate>
  );
}
