import { Gate, Rows } from "./shared";
import { activeGoals, isOpen } from "./selectors";
import { feasibilityTone, toneColor } from "../../lib/chartTheme";
import { num } from "../../lib/format";
import type { Feasibility } from "../../lib/types";
import type { WidgetProps } from "./types";

interface Row {
  key: string;
  label: string;
  context: string;
  feasibility: Feasibility;
}

/**
 * Sessions of slack before the deadline, per piece of work.
 *
 * §11 argues this is the only quantity comparable across incommensurable
 * goals — "taxes at 0.7 pace due in ten days" and "a prototype at 0.7 pace due
 * in six months" are not the same situation, and pace cannot tell them apart.
 * So this widget ranks by margin, not by how far behind plan anything is.
 *
 * An undeterminable margin is neutral, never green: §24.6 is explicit that
 * "None is not the same as True".
 */
export function FeasibilityMargin({ data }: WidgetProps) {
  return (
    <Gate value={data.portfolio} >
      {(portfolio) => {
        const rows: Row[] = [];
        for (const goal of activeGoals(portfolio)) {
          for (const t of goal.trackables.filter(isOpen)) {
            rows.push({
              key: `t${t.trackable_id}`,
              label: t.title,
              context: goal.title,
              feasibility: t.feasibility,
            });
          }
          for (const m of goal.milestones.filter(isOpen)) {
            rows.push({
              key: `m${m.milestone_id}`,
              label: m.title,
              context: `${goal.title} · Sessions`,
              feasibility: m.feasibility,
            });
          }
        }
        if (rows.length === 0) {
          return (
            <div className="text-body-sm text-muted">
              Nothing active. A goal with no deadline is parked and competes for nothing.
            </div>
          );
        }

        // Worst first: the point of the widget is what is about to break.
        //
        // Work with nothing left to do is not "zero slack", it is done for now
        // -- a recurring commitment that has already hit this week's target
        // reports a margin of 0 purely because a weekly goal has no deadline to
        // measure against. Sorting on the raw number floated exactly the
        // healthiest rows to the top of a risk list.
        const settled = (r: Row) => r.feasibility.sessions_needed === 0;
        rows.sort((a, b) => {
          if (settled(a) !== settled(b)) return settled(a) ? 1 : -1;
          const am = a.feasibility.margin_sessions;
          const bm = b.feasibility.margin_sessions;
          if (am === null) return 1;
          if (bm === null) return -1;
          return am - bm;
        });

        const scale = Math.max(
          ...rows
            .filter((r) => !settled(r))
            .map((r) => Math.abs(r.feasibility.margin_sessions ?? 0)),
          1,
        );

        return (
          <Rows>
            {rows.map((row) => {
              const margin = row.feasibility.margin_sessions;
              const tone = settled(row)
                ? "good"
                : feasibilityTone(margin, row.feasibility.feasible);
              return (
                <div key={row.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body-sm text-ink">{row.label}</span>
                    <span
                      className="shrink-0 font-mono text-[11px] tabular-nums"
                      style={{ color: toneColor[tone] }}
                    >
                      {settled(row)
                        ? "Done"
                        : margin === null
                          ? "—"
                          : `${margin > 0 ? "+" : ""}${num(margin, 1)}`}
                    </span>
                  </div>
                  {/* A diverging bar around a centre line: left of centre is a
                      deficit, right is slack. */}
                  <div className="relative h-1.5 rounded-full bg-abyss">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-line" aria-hidden="true" />
                    {margin !== null && !settled(row) && (
                      <div
                        className="absolute inset-y-0 rounded-full"
                        style={{
                          background: toneColor[tone],
                          width: `${(Math.abs(margin) / scale) * 50}%`,
                          left: margin >= 0 ? "50%" : undefined,
                          right: margin < 0 ? "50%" : undefined,
                        }}
                      />
                    )}
                  </div>
                  <div className="text-[11px] text-faint">
                    {row.feasibility.reason || row.context}
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
