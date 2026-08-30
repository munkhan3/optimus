import { BarRow, Gate, Rows } from "./shared";
import { seriesColor } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/**
 * Where the week's sessions actually went, against where they were budgeted.
 *
 * §11: "every budget increase is visibly taken from somewhere else." The
 * declared portfolio only means something if it is checked against the lived
 * one, and this is the only place the two are put side by side.
 */
export function TimePortfolio({ data }: WidgetProps) {
  return (
    <Gate value={data.portfolio}>
      {(portfolio) => {
        const tp = portfolio.time_portfolio;
        if (tp.goals.length === 0) {
          return (
            <div className="text-body-sm text-muted">
              No sessions or budgets this week yet.
            </div>
          );
        }
        const scale = Math.max(
          ...tp.goals.map((g) => Math.max(g.budgeted_sessions ?? 0, g.used_sessions)),
          1,
        );
        const used = tp.goals.reduce((s, g) => s + g.used_sessions, 0);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="display text-heading">{used}</span>
              <span className="text-body-sm text-muted">
                Sessions This Week
                {/* Null, not zero: capacity that was never declared is unknown. */}
                {tp.declared_sessions !== null && ` of ${tp.declared_sessions} Declared`}
              </span>
            </div>
            <Rows>
              {tp.goals.map((g, i) => (
                <BarRow
                  key={g.goal_id}
                  label={g.title ?? `Goal ${g.goal_id}`}
                  fraction={g.used_sessions / scale}
                  color={seriesColor(i)}
                  value={
                    g.budgeted_sessions === null
                      ? `${g.used_sessions} Used`
                      : `${g.used_sessions} / ${g.budgeted_sessions}`
                  }
                  hint={
                    g.budgeted_sessions === null
                      ? "No Budget Declared for This Goal"
                      : undefined
                  }
                />
              ))}
            </Rows>
          </div>
        );
      }}
    </Gate>
  );
}
