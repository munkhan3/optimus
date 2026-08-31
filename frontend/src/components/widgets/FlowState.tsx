import { BarRow, Gate, Rows } from "./shared";
import { seriesColor } from "../../lib/chartTheme";
import { pct } from "../../lib/format";
import type { WidgetProps } from "./types";

/** Minutes as something a person reads at a glance. */
function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole}m`;
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Time worked past the planned end of a session, by goal.
 *
 * Everything else on this dashboard measures whether you did what you said you
 * would. This measures the opposite: the work you did not stop doing when you
 * were allowed to. A timer that runs out and gets ignored is the only unplanned
 * signal in the log, which makes it the closest thing the system has to an
 * answer for "which of this do I actually want to be doing".
 *
 * Two numbers per goal, because minutes alone mislead. Forty sessions with one
 * long overrun and four sessions that all ran over produce similar totals and
 * mean entirely different things, so the share of sessions that crossed at all
 * is reported beside the time.
 */
export function FlowState({ data }: WidgetProps) {
  return (
    <Gate value={data.flow}>
      {(flow) => {
        if (flow.goals.length === 0) {
          return (
            <div className="text-body-sm text-muted">
              No sessions have run past their planned end yet.
            </div>
          );
        }
        // Ranked by the server, so the scale is the leader's total.
        const scale = Math.max(...flow.goals.map((g) => g.flow_minutes), 1);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="display text-heading">
                {duration(flow.total_flow_minutes)}
              </span>
              <span className="text-body-sm text-muted">
                In Flow
                {/* Null when nothing recorded it, which is not the same as
                    never reaching flow and must not read as zero. */}
                {flow.flow_rate !== null &&
                  ` · ${pct(flow.flow_rate)} of ${flow.sessions} Sessions`}
              </span>
            </div>
            <Rows>
              {flow.goals.map((g, i) => (
                <BarRow
                  key={g.goal_id}
                  label={g.title ?? `Goal ${g.goal_id}`}
                  fraction={g.flow_minutes / scale}
                  color={seriesColor(i)}
                  value={duration(g.flow_minutes)}
                  hint={
                    g.flow_rate === null
                      ? undefined
                      : `${g.sessions_in_flow} of ${g.sessions} Sessions Ran Over`
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
