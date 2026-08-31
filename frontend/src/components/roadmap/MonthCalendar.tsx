import { useMemo } from "react";
import type { RoadmapMarker } from "../../lib/dashboard";
import { toneColor } from "../../lib/chartTheme";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Due dates on a month grid. Deliberately no spanning bars.
 *
 * A month crowded with multi-week bars stops being readable as a calendar,
 * which is the one job this mode has: answering "what lands this month". The
 * question of how far something has slipped is the Timeline's job, and trying
 * to serve both here would serve neither.
 */
export function MonthCalendar({
  month,
  today,
  markers,
  onPick,
}: {
  month: Date;
  today: string;
  markers: RoadmapMarker[];
  onPick?: (marker: RoadmapMarker) => void;
}) {
  const cells = useMemo(() => buildMonth(month), [month]);
  const byDate = useMemo(() => {
    const map = new Map<string, RoadmapMarker[]>();
    for (const m of markers) map.set(m.date, [...(map.get(m.date) ?? []), m]);
    return map;
  }, [markers]);

  return (
    /* Fills the canvas: the weekday header takes its natural height and the six
       week rows share whatever is left, so the month is as tall as the window
       rather than as tall as a fixed cell size. */
    <div className="flex h-full min-h-[520px] flex-col">
      <div className="grid shrink-0 grid-cols-7 gap-px">
        {WEEKDAYS.map((d) => (
          <div key={d} className="section-label px-2 pb-2 text-center">
            {d}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px overflow-hidden rounded-card bg-line">
        {cells.map((cell) => {
          const due = byDate.get(cell.iso) ?? [];
          const isToday = cell.iso === today;
          return (
            <div
              key={cell.iso}
              className={`min-h-0 overflow-auto p-1.5 ${cell.inMonth ? "bg-surface" : "bg-bg"}`}
            >
              <div
                className={`mb-1 inline-flex size-5 items-center justify-center rounded-full font-mono text-micro tabular-nums ${
                  isToday
                    ? "bg-pure text-void"
                    : cell.inMonth
                      ? "text-muted"
                      : "text-faint"
                }`}
              >
                {cell.day}
              </div>
              <div className="space-y-1">
                {due.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => onPick?.(m)}
                    title={`${m.title} — due ${m.date}`}
                    className="block w-full truncate rounded-[3px] px-1.5 py-1 text-left text-footnote transition hover:brightness-125"
                    style={{
                      background:
                        m.status === "done"
                          ? "color-mix(in oklab, var(--color-good) 16%, var(--color-abyss))"
                          : "color-mix(in oklab, var(--color-iris) 18%, var(--color-abyss))",
                      color: m.status === "done" ? toneColor.good : "var(--color-ink)",
                    }}
                  >
                    {m.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildMonth(month: Date): { iso: string; day: number; inMonth: boolean }[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // Weeks start Monday, matching capacity weeks and the commitment grid.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(start.getDate() - offset);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return {
      iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      day: d.getDate(),
      inMonth: d.getMonth() === month.getMonth(),
    };
  });
}
