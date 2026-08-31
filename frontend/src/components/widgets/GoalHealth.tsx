import { Gate, Rows } from "./shared";
import { activeGoals } from "./selectors";
import { num, pct, titleCase } from "../../lib/format";
import { toneColor } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

// The engine's own component names (optimus/metrics/health.py). These were
// guessed once and did not match, so the widget fell through to printing raw
// keys -- DAYS_SINCE_LAST_SESSION across a 9px label. Unknown names now get
// title-cased rather than shown as database spelling.
const COMPONENT_LABEL: Record<string, string> = {
  feasibility_margin: "Feasibility",
  drift: "Drift",
  days_to_deadline: "Deadline",
  days_since_last_session: "Recency",
};

/**
 * The composite, and always its parts.
 *
 * P3 and §24.8 both insist the components are shown alongside the score — the
 * composite is a summary, never a substitute. A single health number with no
 * breakdown is the kind of thing that gets trusted for months and then turns
 * out to have been dominated by one term nobody could see.
 *
 * Self-assessed progress is not a term here and never will be (D12).
 */
export function GoalHealth({ data }: WidgetProps) {
  return (
    <Gate value={data.portfolio}>
      {(portfolio) => {
        const rows = activeGoals(portfolio).flatMap((goal) =>
          goal.trackables.map((t) => ({ goal, t })),
        );
        if (rows.length === 0) {
          return <div className="text-body-sm text-muted">Nothing active to score.</div>;
        }
        return (
          <Rows>
            {rows.map(({ goal, t }) => (
              <div key={t.trackable_id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-body-sm text-ink">{t.title}</span>
                  <span className="shrink-0 font-mono text-footnote tabular-nums text-muted">
                    {t.health.score === null ? "—" : pct(t.health.score)}
                  </span>
                </div>
                <div className="flex gap-1">
                  {t.health.components.map((c) => (
                    <div key={c.name} className="min-w-0 flex-1" title={c.note || c.name}>
                      <div className="h-1 overflow-hidden rounded-full bg-abyss">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: c.value === null ? 0 : `${Math.max(0, Math.min(c.value, 1)) * 100}%`,
                            background:
                              c.value === null
                                ? toneColor.neutral
                                : c.value < 0.34
                                  ? toneColor.bad
                                  : c.value < 0.67
                                    ? toneColor.warn
                                    : toneColor.good,
                          }}
                        />
                      </div>
                      <div className="mt-1 truncate font-mono text-micro uppercase tracking-label text-faint">
                        {COMPONENT_LABEL[c.name] ?? titleCase(c.name)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-footnote text-faint">
                  {goal.title}
                  {t.days_since_last_session !== null &&
                    ` · Last Worked ${num(t.days_since_last_session, 0)}d Ago`}
                </div>
              </div>
            ))}
          </Rows>
        );
      }}
    </Gate>
  );
}
