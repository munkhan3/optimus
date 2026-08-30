import { CommitmentGrid } from "./CommitmentGrid";
import { GoalProgress } from "./GoalProgress";
import { FeasibilityMargin } from "./FeasibilityMargin";
import { GoalHealth } from "./GoalHealth";
import { PaceVsRequired } from "./PaceVsRequired";
import { OutputPerSession } from "./OutputPerSession";
import { CapacityVsActual } from "./CapacityVsActual";
import { TimePortfolio } from "./TimePortfolio";
import { CalibrationWidget } from "./CalibrationWidget";
import { DeadlineHorizon } from "./DeadlineHorizon";
import { SelfAssessedSeries } from "./SelfAssessedSeries";
import { RebaselineHistory } from "./RebaselineHistory";
import { RoadmapCompact } from "./RoadmapCompact";
import type { Source, WidgetSpec } from "./types";

/**
 * Every widget the dashboard can place.
 *
 * `kind` is the persisted identifier and must never be renamed — it is what
 * links a stored layout to a component. Removing one is also not free: a layout
 * that still references it renders the unknown-widget placeholder rather than
 * losing the slot, which is the behaviour that makes version skew survivable.
 *
 * Sizes are in grid units: w out of 12 columns, h in 40px rows.
 */
export const WIDGETS: WidgetSpec[] = [
  {
    kind: "commitment_grid",
    title: "Commitment Grid",
    blurb: "Work produced per day, and whether each recurring window hit its target.",
    defaultW: 8, defaultH: 5, minW: 4, minH: 4,
    sources: [],
    Component: CommitmentGrid,
  },
  {
    kind: "feasibility_margin",
    title: "Feasibility Margin",
    blurb: "Sessions of slack before each deadline. Negative means it no longer fits.",
    defaultW: 4, defaultH: 5, minW: 3, minH: 3,
    sources: ["portfolio"],
    Component: FeasibilityMargin,
  },
  {
    kind: "goal_progress",
    title: "Goal Progress",
    blurb: "How far each metered body of work has come, with estimated totals flagged.",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3,
    sources: ["portfolio"],
    Component: GoalProgress,
  },
  {
    kind: "output_per_session",
    title: "Output Per Session",
    blurb: "What one focus session actually produces, by kind of work.",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3,
    sources: ["throughput"],
    Component: OutputPerSession,
  },
  {
    kind: "pace_vs_required",
    title: "Pace vs Required",
    blurb: "Measured pace and its interval against the rate the commitment demands.",
    defaultW: 6, defaultH: 4, minW: 4, minH: 3,
    sources: ["portfolio"],
    Component: PaceVsRequired,
  },
  {
    kind: "capacity_vs_actual",
    title: "Capacity vs Actual",
    blurb: "Declared, committed and used sessions, week by week.",
    defaultW: 6, defaultH: 4, minW: 4, minH: 3,
    sources: ["throughput"],
    Component: CapacityVsActual,
  },
  {
    kind: "time_portfolio",
    title: "Time Portfolio",
    blurb: "Where this week's sessions went, against where they were budgeted.",
    defaultW: 4, defaultH: 4, minW: 3, minH: 3,
    sources: ["portfolio"],
    Component: TimePortfolio,
  },
  {
    kind: "goal_health",
    title: "Goal Health",
    blurb: "The composite score and, always, the four components behind it.",
    defaultW: 4, defaultH: 4, minW: 3, minH: 3,
    sources: ["portfolio"],
    Component: GoalHealth,
  },
  {
    kind: "calibration",
    title: "Calibration",
    blurb: "How close your estimates land, with timed and retroactive kept apart.",
    defaultW: 4, defaultH: 4, minW: 3, minH: 3,
    sources: ["calibration"],
    Component: CalibrationWidget,
  },
  {
    kind: "deadline_horizon",
    title: "Deadline Horizon",
    blurb: "What is due next, and whether it still fits before then.",
    defaultW: 4, defaultH: 4, minW: 3, minH: 3,
    sources: ["portfolio"],
    Component: DeadlineHorizon,
  },
  {
    kind: "self_assessed",
    title: "Self-Assessed Progress",
    blurb: "The percent-complete curve for exploratory work. Feeds no score.",
    defaultW: 4, defaultH: 4, minW: 3, minH: 3,
    sources: ["portfolio"],
    Component: SelfAssessedSeries,
  },
  {
    kind: "rebaseline_history",
    title: "Rebaseline History",
    blurb: "What the plan was originally, against what it is now.",
    defaultW: 6, defaultH: 4, minW: 4, minH: 3,
    sources: ["roadmap"],
    Component: RebaselineHistory,
  },
  {
    kind: "roadmap_compact",
    title: "Roadmap",
    blurb: "The next six weeks of due dates, with a way through to the full view.",
    defaultW: 12, defaultH: 4, minW: 4, minH: 3,
    sources: ["roadmap"],
    Component: RoadmapCompact,
  },
];

export const BY_KIND = new Map(WIDGETS.map((w) => [w.kind, w]));

/** Only fetch what something on the board actually asks for. */
export function requiredSources(kinds: string[]): Set<Source> {
  const needed = new Set<Source>();
  for (const kind of kinds) {
    for (const source of BY_KIND.get(kind)?.sources ?? []) needed.add(source);
  }
  return needed;
}
