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
        title="No trackables yet"
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

  async function start() {
    await api.post("/api/sessions/start", { trackable_id: t.trackable_id });
    onStarted();
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{t.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Tag>{t.task_type}</Tag>
            {/* D3: an inferred total is flagged everywhere it is shown. */}
            {t.total_units_source === "model_estimated" && <Tag tone="warn">estimated total</Tag>}
            {t.exploratory && <Tag tone="accent">exploratory</Tag>}
            {infeasible && <Tag tone="bad">infeasible</Tag>}
          </div>
        </div>
        <Button onClick={start} disabled={busy} className="shrink-0">
          Start
        </Button>
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

      {/* D8: the interval is displayed and gates exactly one decision --
          whether to rebaseline. It is not propagated into any arithmetic. */}
      {interval && (
        <div className="mt-4 text-xs text-faint">
          Typical range {interval}
          {t.pace.interval?.provisional && " · provisional, too few sessions to trust"}
        </div>
      )}

      {infeasible && (
        <div className="mt-4 rounded-xl bg-bad/10 px-3 py-2.5 text-xs leading-relaxed text-bad">
          {t.feasibility.reason}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
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
