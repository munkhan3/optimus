import { Gate, Rows } from "./shared";
import { flattenTrackables } from "./selectors";
import { Tag } from "../Primitives";
import { num } from "../../lib/format";
import { chart, toneColor } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/**
 * What this work actually costs, against what its counter says.
 *
 * A body of work is tracked in a unit whose total is knowable — a book has 380
 * pages — which is a poor measure of how much WORK a session held, because a
 * page carrying an hour-long problem is not a page of prose. Fitting minutes
 * against both counts recovers what each actually costs, and `k` is the answer:
 * how many pages one problem displaces.
 *
 * The index is dimensionless, so two books whose problems cost wildly different
 * amounts are still comparable here. The raw counts never are, which is why
 * nothing on this widget shows them side by side.
 *
 * A fit the data does not support shows its reason, not a number. There is no
 * partial credit: a wrong cost-per-problem does not degrade gracefully, it
 * reaches weekly ranking.
 */
export function WorkDensity({ data }: WidgetProps) {
  return (
    <Gate
      value={
        data.portfolio === undefined
          ? undefined
          : data.portfolio === null
            ? null
            : flattenTrackables(data.portfolio).filter(({ trackable }) => trackable.secondary_unit)
      }
      empty="No Second Measure Yet"
      emptyHint="Record a count alongside a session — problems, exercises, sections — and this fits what each one costs."
    >
      {(rows) => (
        <Rows>
          {rows.map(({ trackable: t }) => {
            const fit = t.density_fit;
            const index = t.productivity?.productivity_index ?? null;
            // 1.0 is a session that went exactly as the history predicts. Both
            // directions are informative, so distance from 1.0 sets the tone.
            const off = index === null ? null : Math.abs(index - 1);
            const tone =
              off === null ? "neutral" : off < 0.15 ? "good" : off < 0.4 ? "warn" : "bad";

            return (
              <div key={t.trackable_id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-body-sm text-ink">{t.title}</span>
                  <span
                    className="shrink-0 font-mono text-footnote tabular-nums"
                    style={{ color: toneColor[tone] }}
                  >
                    {index === null ? "—" : `${num(index, 2)}×`}
                  </span>
                </div>

                {fit.k !== null ? (
                  <>
                    <div className="text-footnote text-muted">
                      One {singular(t.secondary_unit ?? "unit")} costs{" "}
                      <span className="font-mono tabular-nums text-ink">{num(fit.k, 1)}</span>{" "}
                      {t.unit}
                      {fit.beta !== null && (
                        <>
                          {" · "}
                          <span className="font-mono tabular-nums">{num(fit.beta, 1)}</span> min
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-faint">
                      <span>
                        {fit.n_sessions} session{fit.n_sessions === 1 ? "" : "s"}
                        {fit.r_squared !== null && ` · R² ${num(fit.r_squared, 2)}`}
                      </span>
                      {t.series_stability.secondary_is_tighter && (
                        <Tag tone="warn">{t.secondary_unit} May Be The Better Unit</Tag>
                      )}
                    </div>
                  </>
                ) : (
                  /* P2: say which guard fired rather than printing a zero. */
                  <div className="text-footnote text-faint">{fit.reason}</div>
                )}

                {t.productivity?.density_factor != null && (
                  <div className="h-1 overflow-hidden rounded-full bg-white/8">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(t.productivity.density_factor / 5, 1) * 100}%`,
                        background: chart.iris(),
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </Rows>
      )}
    </Gate>
  );
}

function singular(unit: string): string {
  return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}
