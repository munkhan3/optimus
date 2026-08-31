/**
 * The dashboard's wire types and fetchers.
 *
 * Response shapes for a single view normally live in that view's file, but
 * these are shared by a dozen widgets and by the Roadmap, so they live here
 * with the fetchers that produce them.
 */

import { api } from "./api";
import type {
  DensityFit,
  Feasibility,
  Health,
  PaceEstimate,
  PaceScores,
  Progress,
  Projection,
  SeriesStability,
  SessionProductivity,
} from "./types";

/** The user's IANA zone. Every day bucket on the server is cut against this. */
export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ------------------------------------------------------------------- layout

export interface WidgetPlacement {
  i: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
}

export interface Layout {
  name: string;
  widgets: WidgetPlacement[];
  updated_at?: string;
}

export const getLayout = () => api.get<Layout>("/api/dashboard/layout");
export const putLayout = (widgets: WidgetPlacement[]) =>
  api.put<Layout>("/api/dashboard/layout", { widgets });

// ----------------------------------------------------------------- activity

export interface ActivityDay {
  date: string;
  sessions: number;
  units: number;
  minutes: number;
}

export interface ActivityPeriod {
  trackable_id: number;
  title: string;
  unit: string;
  start: string;
  end: string;
  done: number;
  target: number;
  /** null = the window is still open. Not yet met is not the same as missed. */
  met: boolean | null;
}

export interface Activity {
  from: string;
  to: string;
  tz: string;
  /** Which field intensity should ramp against. Mixed units fall back to time. */
  basis: "units" | "minutes";
  unit: string;
  peak: number;
  days: ActivityDay[];
  periods: ActivityPeriod[];
}

export function getActivity(opts: {
  weeks?: number;
  goalId?: number;
  trackableId?: number;
} = {}) {
  const q = new URLSearchParams({ tz: browserTz(), weeks: String(opts.weeks ?? 26) });
  if (opts.goalId) q.set("goal_id", String(opts.goalId));
  if (opts.trackableId) q.set("trackable_id", String(opts.trackableId));
  return api.get<Activity>(`/api/dashboard/activity?${q}`);
}

// --------------------------------------------------------------- throughput

export interface ThroughputWeek {
  week_start: string;
  sessions: number;
  units: number;
  minutes: number;
}

export interface SessionDistribution {
  task_type: string;
  session_minutes: number;
  n: number;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  low: number | null;
  high: number | null;
}

export interface CapacityWeek {
  week_start: string;
  declared_sessions: number;
  committed_sessions: number;
  used_sessions: number;
}

export interface Throughput {
  from: string;
  to: string;
  weeks: ThroughputWeek[];
  per_session: SessionDistribution[];
  capacity: CapacityWeek[];
}

export function getThroughput(opts: { weeks?: number; taskType?: string } = {}) {
  const q = new URLSearchParams({ tz: browserTz(), weeks: String(opts.weeks ?? 12) });
  if (opts.taskType) q.set("task_type", opts.taskType);
  return api.get<Throughput>(`/api/dashboard/throughput?${q}`);
}

// --------------------------------------------------------------- flow state

export interface FlowWeek {
  week_start: string;
  flow_minutes: number;
  sessions: number;
  sessions_in_flow: number;
}

export interface FlowGoal {
  goal_id: number;
  title: string | null;
  area_id: number | null;
  flow_minutes: number;
  sessions: number;
  sessions_in_flow: number;
  /** Share of this goal's sessions that ran past their planned end, or null. */
  flow_rate: number | null;
}

export interface Flow {
  from: string;
  to: string;
  weeks: FlowWeek[];
  goals: FlowGoal[];
  total_flow_minutes: number;
  sessions: number;
  sessions_in_flow: number;
  flow_rate: number | null;
}

export function getFlow(opts: { weeks?: number } = {}) {
  const q = new URLSearchParams({ tz: browserTz(), weeks: String(opts.weeks ?? 12) });
  return api.get<Flow>(`/api/dashboard/flow?${q}`);
}

// ---------------------------------------------------------------- portfolio

export interface PortfolioTrackable {
  trackable_id: number;
  title: string;
  unit: string;
  task_type: string;
  status: string;
  exploratory: boolean;
  total_units_source: string;
  progress: Progress;
  pace: PaceEstimate;
  /** This trackable's own sessions, unpooled -- the pace score's numerator. */
  trackable_pace: PaceEstimate;
  pace_scores: PaceScores;
  /** The second axis. Null unit means this trackable has no second axis. */
  secondary_unit: string | null;
  secondary_total_units: number | null;
  secondary_total_units_source: string | null;
  secondary_completed_units: number;
  density_fit: DensityFit;
  productivity: SessionProductivity | null;
  series_stability: SeriesStability;
  required_pace: { point: number | null; denominator_source: string } | null;
  feasibility: Feasibility;
  projection: Projection;
  health: Health;
  days_since_last_session: number | null;
  sessions_used_this_week: number;
  period_start: string | null;
}

export interface PortfolioMilestone {
  milestone_id: number;
  title: string;
  status: string;
  exploratory: boolean;
  planned_sessions: number | null;
  sessions_used: number;
  feasibility: Feasibility;
  health: Health;
  stall: { stalled: boolean; sessions_since_movement: number; latest_pct: number | null; series: number[] };
}

export interface PortfolioGoal {
  goal_id: number;
  title: string;
  area_id: number | null;
  kind: string;
  stakes: number;
  activation: string;
  pace_mode: string;
  reset_period_days: number | null;
  deadline: string | null;
  status: string;
  completed_at: string | null;
  definition_of_done: string;
  dod_source: string;
  budgeted_sessions: number | null;
  trackables: PortfolioTrackable[];
  milestones: PortfolioMilestone[];
}

export interface Portfolio {
  as_of: string;
  areas: { id: number; name: string; color: string | null }[];
  goals: PortfolioGoal[];
  time_portfolio: {
    week_start: string;
    declared_sessions: number | null;
    goals: {
      goal_id: number;
      title: string | null;
      area_id: number | null;
      budgeted_sessions: number | null;
      used_sessions: number;
    }[];
  };
}

export const getPortfolio = () => api.get<Portfolio>("/api/dashboard/portfolio");

// -------------------------------------------------------------- calibration

export interface CalibrationEntry {
  median_ratio: number | null;
  n: number;
  n_timed: number;
  n_retroactive: number;
  timed_ratios: number[];
  retroactive_ratios: number[];
}

export interface Calibration {
  by_task_type: Record<string, CalibrationEntry>;
}

export const getCalibration = () => api.get<Calibration>("/api/dashboard/calibration");

// ------------------------------------------------------------------ roadmap

export interface BaselineSnapshot {
  version: number;
  planned_sessions: number;
  scope_units: number | null;
  target_date: string;
  resolution: string | null;
  rationale: string | null;
  created_at: string;
}

export interface RoadmapRow {
  kind: "goal" | "milestone" | "trackable";
  id: number;
  key: string;
  title: string;
  start: string | null;
  end: string | null;
  status: string;
  /** null means UNKNOWN, not unfinished. Never draw it as an open bar. */
  completed_at: string | null;
  children: RoadmapRow[];
  area_id?: number | null;
  stakes?: number;
  activation?: string;
  pace_mode?: string;
  reset_period_days?: number | null;
  blocked_by?: number | null;
  exploratory?: boolean;
  unit?: string;
  feasibility?: Feasibility;
  progress?: Progress;
  projection?: Projection;
  baselines?: { original: BaselineSnapshot | null; current: BaselineSnapshot | null; versions: number };
}

export interface RoadmapMarker {
  kind: string;
  id: number;
  key: string;
  title: string;
  date: string;
  status: string;
}

export interface Roadmap {
  as_of: string;
  rows: RoadmapRow[];
  markers: RoadmapMarker[];
}

export const getRoadmap = () => api.get<Roadmap>("/api/dashboard/roadmap");

// -------------------------------------------------------------- allocations

export interface Allocation {
  trackable_id: number | null;
  milestone_id: number | null;
  plan_date: string;
  sessions: number;
}

export interface AllocationCommitment {
  trackable_id: number | null;
  milestone_id: number | null;
  label: string | null;
  committed_sessions: number;
  target_units: number | null;
  placed_sessions: number;
}

export interface AllocationWarning {
  kind: "placement_mismatch" | "day_over_cap";
  detail: string;
  plan_date?: string;
  label?: string | null;
}

export interface Allocations {
  week_start: string;
  capacity_id: number;
  session_minutes: number;
  allocations: Allocation[];
  commitments: AllocationCommitment[];
  warnings?: AllocationWarning[];
}

export const getAllocations = (weekStart: string) =>
  api.get<Allocations>(`/api/planning/allocations?week_start=${weekStart}`);

export const putAllocations = (weekStart: string, allocations: Allocation[]) =>
  api.put<Allocations>("/api/planning/allocations", {
    week_start: weekStart,
    allocations,
  });

/** A stable key for "which committed thing is this", matching the server's. */
export function targetKey(row: { trackable_id: number | null; milestone_id: number | null }): string {
  return row.trackable_id != null ? `t${row.trackable_id}` : `m${row.milestone_id}`;
}
