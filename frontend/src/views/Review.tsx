import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { num } from "../lib/format";
import { Card, Empty, ProgressBar, Tag } from "../components/Primitives";

/**
 * The weekly review (§15.4).
 *
 * This is where inferred values get corrected, scope gets renegotiated, and the
 * system reports what it has learned about how the user actually works. It is
 * also the only place that says "this estimate was mine, not yours" out loud.
 */

interface Review {
  week_start: string;
  week_end: string;
  plan_vs_actual: {
    label: string | null;
    committed_sessions: number;
    sessions_used: number;
    target_units: number | null;
    units_done: number | null;
    hit_target: boolean;
  }[];
  calibration: Record<
    string,
    { median_ratio: number | null; n: number; n_timed: number; n_retroactive: number }
  >;
  rebaseline_prompts: {
    label: string;
    trigger: string;
    reason: string;
    drift_sessions?: number | null;
    series?: number[];
    options: string[];
  }[];
  model_estimated_values: { label: string; field: string }[];
  open_gaps: { id: number; question: string; priority: number }[];
  revealed_preference: Record<string, number>;
}

export function Review() {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Review>("/api/reviews/weekly")
      .then(setReview)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  if (error) return <div className="rounded-xl bg-bad/8 px-3 py-2 text-xs text-bad">{error}</div>;
  if (!review) return <Empty title="Loading the week…" />;

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">
        {review.week_start} – {review.week_end}
      </div>

      {/* --- what you said you'd do, and what happened ---------------------- */}
      <Card>
        <div className="text-sm font-bold">Plan vs actual</div>
        {review.plan_vs_actual.length === 0 ? (
          <p className="mt-1 text-xs text-muted">Nothing committed this week.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {review.plan_vs_actual.map((row, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="truncate font-medium">{row.label}</span>
                  <span className={row.hit_target ? "text-good" : "text-muted"}>
                    {row.sessions_used}/{row.committed_sessions} sessions
                  </span>
                </div>
                {row.target_units !== null && (
                  <>
                    <div className="mt-1">
                      <ProgressBar
                        fraction={
                          row.target_units > 0
                            ? (row.units_done ?? 0) / row.target_units
                            : null
                        }
                      />
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {num(row.units_done, 0)} of {num(row.target_units, 0)} committed
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* --- the thing the system knows that you don't (§13) ---------------- */}
      {Object.keys(review.calibration).length > 0 && (
        <Card>
          <div className="text-sm font-bold">What you actually deliver</div>
          <p className="mt-1 text-xs text-muted">
            Your output divided by what you expected. Trending toward 1.0 means your estimates are
            getting honest.
          </p>
          <div className="mt-3 space-y-2">
            {Object.entries(review.calibration).map(([type, c]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span>{type}</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{num(c.median_ratio, 2)}×</span>
                  <span className="text-[11px] text-muted">
                    {c.n} session{c.n === 1 ? "" : "s"}
                    {c.n_retroactive > 0 && `, ${c.n_retroactive} recalled`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* --- gated: nothing here on a wide interval (§25.4) ----------------- */}
      {review.rebaseline_prompts.length > 0 && (
        <Card className="border-warn/40 bg-warn/8">
          <div className="text-sm font-bold text-warn">Worth rebaselining</div>
          <div className="mt-2 space-y-3">
            {review.rebaseline_prompts.map((p, i) => (
              <div key={i}>
                <div className="text-sm font-medium">{p.label}</div>
                <div className="text-xs text-muted">{p.reason}</div>
                {p.series && p.series.length > 0 && (
                  <div className="mt-1 font-mono text-[11px] text-muted">
                    {p.series.join(" → ")}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Four options, and moving the date is not the default one. Handle it in Plan.
          </p>
        </Card>
      )}

      {/* --- D3: nothing the model guessed stays quietly guessed ------------ */}
      {review.model_estimated_values.length > 0 && (
        <Card>
          <div className="text-sm font-bold">Numbers I guessed</div>
          <p className="mt-1 text-xs text-muted">
            These were inferred, not measured. They are worth correcting — everything downstream
            rests on them.
          </p>
          <div className="mt-2 space-y-1.5">
            {review.model_estimated_values.map((v, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{v.label}</span>
                <Tag tone="warn">{v.field.replace(/_/g, " ")}</Tag>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* --- §22.2: asked in priority order, and they persist until answered  */}
      {review.open_gaps.length > 0 && (
        <Card>
          <div className="text-sm font-bold">Still unanswered</div>
          <div className="mt-2 space-y-2">
            {review.open_gaps.map((g) => (
              <div key={g.id} className="text-sm">
                {g.question}
              </div>
            ))}
          </div>
        </Card>
      )}

      {Object.keys(review.revealed_preference).length > 0 && (
        <Card>
          <div className="text-sm font-bold">What you did with the plan</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(review.revealed_preference).map(([action, count]) => (
              <Tag key={action}>
                {action} {count}
              </Tag>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
