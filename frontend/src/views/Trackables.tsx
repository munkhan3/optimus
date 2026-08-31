import { useState } from "react";

import { api } from "../lib/api";
import type { TrackableView } from "../lib/types";
import {
  basisLabel,
  dateShort,
  intervalText,
  num,
  paceText,
  pct,
  projectionText,
  relativeDays,
} from "../lib/format";
import { BigStat, Button, Card, Empty, ProgressBar, Stat, Tag } from "../components/Primitives";
import { Calculated } from "../components/Calculated";
import { SessionDuration, useSessionDefaults } from "../components/SessionDuration";

/**
 * The M1 screen: trackables with progress, pace, interval, drift, projection.
 *
 * §28 calls this the thing that must be used daily before anything downstream
 * is worth building. Every number here is labelled with where it came from --
 * a user cannot calibrate trust in a figure whose provenance is invisible (P3).
 */
export function Trackables({
  trackables,
  onStarted,
  busy,
}: {
  trackables: TrackableView[];
  onStarted: () => void;
  busy: boolean;
}) {
  if (trackables.length === 0) {
    return (
      <Empty
        title="No Trackables Yet"
        hint="A trackable is a measurable body of work — 380 pages, 60 problems. Create one under a milestone to start logging."
      />
    );
  }

  return (
    <div className="space-y-3">
      {trackables.map((t) => (
        <TrackableCard key={t.trackable_id} t={t} onStarted={onStarted} busy={busy} />
      ))}
    </div>
  );
}

function TrackableCard({
  t,
  onStarted,
  busy,
}: {
  t: TrackableView;
  onStarted: () => void;
  busy: boolean;
}) {
  const infeasible = t.feasibility.feasible === false;
  const undetermined = t.feasibility.feasible === null;
  const interval = intervalText(t.pace, t.unit);
  const { minutes: defaultMinutes } = useSessionDefaults();
  const [minutes, setMinutes] = useState(defaultMinutes);

  async function start() {
    await api.post("/api/sessions/start", {
      trackable_id: t.trackable_id,
      planned_minutes: minutes,
    });
    onStarted();
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="display truncate text-subheading">{t.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Tag>{t.task_type}</Tag>
            {/* D3: an inferred total is flagged everywhere it is shown. */}
            {t.total_units_source === "model_estimated" && <Tag tone="warn">Estimated Total</Tag>}
            {t.exploratory && <Tag tone="accent">Exploratory</Tag>}
            {infeasible && <Tag tone="bad">Infeasible</Tag>}
          </div>
        </div>
        {/* `busy` already folds in "a session is open" (App.tsx passes
            busy || !!session), which is what Today and Tree spell as
            `sessionOpen`. Same rule, two names. */}
        <Button onClick={start} disabled={busy} className="shrink-0">
          Start
        </Button>
      </div>

      {/* §36.1 reversed. Prefilled, so ignoring it entirely still leaves
          starting a one-tap action (§23.1). */}
      <div className="mt-3">
        <SessionDuration value={minutes} onChange={setMinutes} disabled={busy} />
      </div>

      <div className="mt-4">
        <BigStat
          value={pct(t.progress.fraction)}
          caption={`${num(t.progress.completed_units, 0)} of ${num(
            t.progress.total_units,
            0,
          )} ${t.unit}`}
        />
        <div className="mt-3">
          <ProgressBar fraction={t.progress.fraction} tone={infeasible ? "bad" : "accent"} />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
        <Stat
          label="Pace"
          value={paceText(t.pace, t.unit)}
          hint={basisLabel(t.pace.basis, t.pace.n_sessions)}
        />
        <Stat
          label="Projected"
          value={projectionText(t.projection)}
          hint={
            t.projection.provisional
              ? "provisional"
              : t.projection.target_date
                ? `target ${dateShort(t.projection.target_date)}`
                : "no target"
          }
        />
        <Stat
          label="Drift"
          value={t.drift?.sessions === null || !t.drift ? "—" : `${num(t.drift.sessions)} sess`}
          hint={t.drift ? `vs baseline v${t.drift.vs_version}` : "no baseline"}
          tone={t.drift?.sessions != null && t.drift.sessions > 0 ? "warn" : undefined}
        />
        <Stat
          label="Feasibility"
          value={infeasible ? "Will not fit" : undetermined ? "Undetermined" : "Fits"}
          hint={
            t.feasibility.margin_sessions !== null
              ? `${num(t.feasibility.margin_sessions)} sessions margin`
              : "needs capacity + deadline"
          }
          tone={infeasible ? "bad" : undetermined ? "warn" : "good"}
        />
      </div>

      {/* Two dimensionless readings, never collapsed. D6: a goal at 0.7 pace may
          simply have had an aggressive plan, so "how fast do I work" and "how far
          off-pace am I" are answered separately or not at all. */}
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
        <div>
          <Stat
            label="Pace Score"
            value={t.pace_scores.pace == null ? "—" : num(t.pace_scores.pace, 2)}
            hint="vs your usual for this work"
            tone={
              t.pace_scores.pace == null
                ? undefined
                : t.pace_scores.pace >= 0.9
                  ? "good"
                  : t.pace_scores.pace >= 0.7
                    ? "warn"
                    : "bad"
            }
          />
          <Calculated calculation={t.pace_scores.pace_calculation} />
        </div>
        <div>
          <Stat
            label="On Track"
            value={t.pace_scores.track == null ? "—" : num(t.pace_scores.track, 2)}
            hint="vs what the plan requires"
            tone={
              t.pace_scores.track == null
                ? undefined
                : t.pace_scores.track >= 1
                  ? "good"
                  : t.pace_scores.track >= 0.8
                    ? "warn"
                    : "bad"
            }
          />
          <Calculated calculation={t.pace_scores.track_calculation} />
        </div>
      </div>

      {/* D8: the interval is displayed and gates exactly one decision --
          whether to rebaseline. It is not propagated into any arithmetic. */}
      {interval && (
        <div className="mt-4 text-caption text-faint">
          Typical range {interval}
          {t.pace.interval?.provisional && " · provisional, too few sessions to trust"}
        </div>
      )}

      {infeasible && (
        <div className="mt-4 rounded-card bg-bad/8 px-4 py-3 text-caption leading-relaxed text-bad">
          {t.feasibility.reason}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote text-faint">
        <span>last worked {relativeDays(t.days_since_last_session)}</span>
        <span>
          {t.sessions_used_this_week} session{t.sessions_used_this_week === 1 ? "" : "s"} this week
        </span>
        {t.calibration.median_ratio !== null && (
          <span>
            you deliver {num(t.calibration.median_ratio, 2)}× what you expect
            {t.calibration.retroactive_ratios.length > 0 &&
              ` (${t.calibration.retroactive_ratios.length} recalled, down-weighted)`}
          </span>
        )}
      </div>
    </Card>
  );
}
