import { BarRow, Gate, Rows } from "./shared";
import { flattenTrackables } from "./selectors";
import { Tag } from "../Primitives";
import { num, pct } from "../../lib/format";
import { seriesColor } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/**
 * How far each metered body of work has actually come.
 *
 * A model-estimated total is flagged wherever it appears (D3): the bar looks
 * identical whether the denominator was counted or guessed, so the tag is the
 * only thing standing between an estimate and a fact.
 */
export function GoalProgress({ data }: WidgetProps) {
  return (
    <Gate
      value={data.portfolio === undefined ? undefined : (data.portfolio?.goals ?? null)}
      empty="No Goals Yet"
      emptyHint="Progress appears once a goal has metered work under it."
    >
      {() => {
        const rows = flattenTrackables(data.portfolio!);
        if (rows.length === 0) {
          return (
            <div className="text-body-sm text-muted">
              No metered work yet. Milestones with no natural counter are budgeted in
              sessions instead — see Feasibility.
            </div>
          );
        }
        return (
          <Rows>
            {rows.map(({ goal, trackable }, i) => (
              <BarRow
                key={trackable.trackable_id}
                label={trackable.title}
                fraction={trackable.progress.fraction}
                color={seriesColor(i)}
                value={pct(trackable.progress.fraction)}
                hint={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      {num(trackable.progress.completed_units, 0)} of{" "}
                      {num(trackable.progress.total_units, 0)} {trackable.unit} · {goal.title}
                    </span>
                    {trackable.total_units_source === "model_estimated" && (
                      <Tag tone="warn">Estimated Total</Tag>
                    )}
                    {trackable.period_start && <Tag tone="neutral">This Period</Tag>}
                  </span>
                }
              />
            ))}
          </Rows>
        );
      }}
    </Gate>
  );
}
