import { Gate } from "./shared";
import { dateShort } from "../../lib/format";
import { toneColor, feasibilityTone } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

const WEEKS = 6;

/**
 * The next six weeks of due dates, and a way through to the full Roadmap.
 *
 * Deliberately read-only and deliberately small: the Gantt needs width to say
 * anything, and a cramped version of it in a grid cell would be worse than a
 * list. This answers "what is coming up" and hands off for "how far has it
 * moved".
 */
export function RoadmapCompact({ data, onNavigate }: WidgetProps) {
  return (
    <Gate value={data.roadmap}>
      {(roadmap) => {
        const today = new Date(`${roadmap.as_of}T00:00:00`);
        const horizon = new Date(today);
        horizon.setDate(horizon.getDate() + WEEKS * 7);

        const upcoming = roadmap.markers.filter((m) => {
          const when = new Date(`${m.date}T00:00:00`);
          return when >= today && when <= horizon && m.status !== "done";
        });

        return (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-body-sm text-muted">Next {WEEKS} Weeks</span>
              {onNavigate && (
                <button
                  onClick={() => onNavigate("roadmap")}
                  className="rounded-control px-2 py-1 text-[11px] text-faint transition hover:bg-raised hover:text-ink"
                >
                  Open Roadmap →
                </button>
              )}
            </div>

            {upcoming.length === 0 ? (
              <div className="text-body-sm text-muted">
                Nothing due in the next {WEEKS} weeks.
              </div>
            ) : (
              <>
                <Track today={today} horizon={horizon} markers={upcoming} />
                <div className="space-y-1.5">
                  {upcoming.slice(0, 6).map((m) => (
                    <div key={m.key} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-body-sm text-ink">{m.title}</span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                        {dateShort(m.date)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      }}
    </Gate>
  );
}

function Track({
  today,
  horizon,
  markers,
}: {
  today: Date;
  horizon: Date;
  markers: { key: string; title: string; date: string }[];
}) {
  const span = horizon.getTime() - today.getTime();
  return (
    <div className="relative h-6">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
      {markers.map((m) => {
        const at = ((new Date(`${m.date}T00:00:00`).getTime() - today.getTime()) / span) * 100;
        return (
          <span
            key={m.key}
            title={`${m.title} — ${m.date}`}
            className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45"
            style={{ left: `${at}%`, background: toneColor[feasibilityTone(null)] }}
          />
        );
      })}
      <span
        className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-ink"
        title="Today"
        aria-hidden="true"
      />
    </div>
  );
}
