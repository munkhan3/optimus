import { useEffect, useState } from "react";
import {
  getAllocations,
  getRoadmap,
  type Allocations,
  type Roadmap as RoadmapData,
} from "../lib/dashboard";
import { ApiError } from "../lib/api";
import { mondayOf } from "../lib/format";
import { MonthCalendar } from "../components/roadmap/MonthCalendar";
import { WeekBoard } from "../components/roadmap/WeekBoard";
import { Timeline, TimelineLegend } from "../components/roadmap/Timeline";
import { Banner, SkeletonList } from "../components/Primitives";
import {
  ViewBarLeft,
  ViewBarRight,
  ViewButton,
  ViewLabel,
  ViewLegend,
  ViewSwitch,
} from "../components/ViewChrome";

type Mode = "month" | "week" | "timeline";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "month", label: "Month", hint: "What lands this month" },
  { value: "week", label: "Week", hint: "Shape the coming week" },
  { value: "timeline", label: "Timeline", hint: "How far it has moved" },
];

/**
 * One roadmap, three questions.
 *
 * Month answers "what is due"; Week answers "how do I want this week to go";
 * Timeline answers "how far has this slipped since I committed to it". They
 * share a single /api/dashboard/roadmap fetch because they are three readings
 * of the same data, not three features.
 *
 * Full-bleed, with its controls floating over the canvas exactly as the goal
 * graph's do. A calendar squeezed into a 1100px column below a toolbar is a
 * calendar with fewer days visible, and there is no reason for it.
 */
export function Roadmap() {
  const [mode, setMode] = useState<Mode>("month");
  const [roadmap, setRoadmap] = useState<RoadmapData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [weekStart, setWeekStart] = useState(() => mondayOf());
  const [week, setWeek] = useState<{
    key: string;
    allocations: Allocations | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    getRoadmap()
      .then((r) => live && setRoadmap(r))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "week") return;
    let live = true;
    getAllocations(weekStart)
      .then((a) => live && setWeek({ key: weekStart, allocations: a, error: null }))
      .catch(
        (e) =>
          live &&
          setWeek({
            key: weekStart,
            allocations: null,
            error: e instanceof ApiError ? e.message : String(e),
          }),
      );
    return () => {
      live = false;
    };
  }, [mode, weekStart]);

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <Banner>{error}</Banner>
      </div>
    );
  }
  if (!roadmap) {
    return (
      <div className="p-4 sm:p-6">
        <SkeletonList rows={2} height="h-48" />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Bottom padding clears the floating bar, so the last row of a calendar
          or the last goal on the timeline is never sitting under it. */}
      {/* Extra headroom in timeline mode so the fixed legend never sits on top
          of the date axis. */}
      <div
        className={`min-h-0 flex-1 overflow-auto px-4 pb-[calc(132px+env(safe-area-inset-bottom))] lg:pb-20 sm:px-6 ${
          mode === "timeline" ? "pt-16" : "pt-4"
        }`}
      >
        {mode === "month" && (
          <MonthCalendar month={month} today={roadmap.as_of} markers={roadmap.markers} />
        )}
        {mode === "week" && (
          <WeekPane week={week} weekStart={weekStart} roadmap={roadmap} onSaved={setWeek} />
        )}
        {mode === "timeline" && <Timeline roadmap={roadmap} />}
      </div>

      {mode === "timeline" && (
        <ViewLegend>
          <TimelineLegend />
        </ViewLegend>
      )}

      <ViewBarLeft>
        <ViewSwitch label="Roadmap view" value={mode} options={MODES} onChange={setMode} />
      </ViewBarLeft>

      {/* Timeline shows every date at once, so it has nothing to step through. */}
      {mode !== "timeline" && (
        <ViewBarRight>
          <ViewButton
            onClick={() =>
              mode === "month"
                ? setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
                : setWeekStart(shiftWeek(weekStart, -7))
            }
            title="Previous"
          >
            ‹
          </ViewButton>
          <ViewLabel>
            {mode === "month"
              ? month.toLocaleDateString(undefined, { month: "long", year: "numeric" })
              : `Week of ${weekStart}`}
          </ViewLabel>
          <ViewButton
            onClick={() =>
              mode === "month"
                ? setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
                : setWeekStart(shiftWeek(weekStart, 7))
            }
            title="Next"
          >
            ›
          </ViewButton>
          <ViewButton
            onClick={() => {
              const d = new Date();
              setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
              setWeekStart(mondayOf());
            }}
          >
            Today
          </ViewButton>
        </ViewBarRight>
      )}
    </div>
  );
}

/** Only render the board once the fetch for THIS week has landed. */
function WeekPane({
  week,
  weekStart,
  roadmap,
  onSaved,
}: {
  week: { key: string; allocations: Allocations | null; error: string | null } | null;
  weekStart: string;
  roadmap: RoadmapData;
  onSaved: (next: { key: string; allocations: Allocations; error: null }) => void;
}) {
  const fresh = week?.key === weekStart ? week : null;
  if (fresh?.error) return <Banner>{fresh.error}</Banner>;
  if (!fresh?.allocations) return <SkeletonList rows={2} height="h-32" />;
  return (
    <WeekBoard
      key={weekStart}
      allocations={fresh.allocations}
      markers={roadmap.markers}
      onSaved={(next) => onSaved({ key: weekStart, allocations: next, error: null })}
    />
  );
}

function shiftWeek(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
