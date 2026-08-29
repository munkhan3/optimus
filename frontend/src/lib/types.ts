/** Mirrors the engine's output types. See goalos/metrics/types.py. */

export type Basis = "observed" | "shrunk" | "prior_only" | "pooled_prior" | "unavailable";

export interface Interval {
  low: number;
  high: number;
  provisional: boolean;
}

export interface PaceEstimate {
  point: number | null;
  basis: Basis;
  interval: Interval | null;
  n_sessions: number;
  observed_mean: number | null;
  prior_pace: number | null;
}

export interface Progress {
  completed_units: number;
  total_units: number;
  remaining_units: number;
  fraction: number | null;
}

export interface Feasibility {
  feasible: boolean | null;
  sessions_needed: number | null;
  sessions_available: number | null;
  margin_sessions: number | null;
  reason: string;
}

export interface Projection {
  earliest: string | null;
  latest: string | null;
  provisional: boolean;
  target_date: string | null;
}

export interface Drift {
  sessions: number | null;
  vs_version: number;
  projected_sessions_needed: number | null;
  planned_sessions_remaining: number;
}

export interface HealthComponent {
  name: string;
  value: number | null;
  weight: number;
  note: string;
}

export interface Health {
  score: number | null;
  components: HealthComponent[];
}

export interface Calibration {
  median_ratio: number | null;
  n_total: number;
  timed_ratios: number[];
  retroactive_ratios: number[];
}

export interface TrackableView {
  trackable_id: number;
  title: string;
  unit: string;
  task_type: string;
  exploratory: boolean;
  total_units_source: string;
  progress: Progress;
  pace: PaceEstimate;
  required_pace: { point: number | null; denominator_source: string } | null;
  drift: Drift | null;
  drift_vs_original: Drift | null;
  calibration: Calibration;
  feasibility: Feasibility;
  projection: Projection;
  health: Health;
  days_since_last_session: number | null;
  sessions_used_this_week: number;
}

export interface WorkSession {
  id: number;
  trackable_id: number | null;
  milestone_id: number | null;
  task_type: string;
  started_at: string;
  ended_at: string | null;
  planned_minutes: number;
  expected_output: number | null;
  actual_output: number | null;
  interrupted: boolean;
  entered_retroactively: boolean;
}

export interface ScoreComponent {
  name: string;
  raw: number | boolean | null;
  normalized: number;
  weight: number;
  contribution: number;
}

export interface PlanItem {
  id: number;
  rank: number;
  tier: "A" | "B" | "C" | "D";
  score: number;
  trackable_id: number | null;
  milestone_id: number | null;
  allocated_units: number | null;
  user_action: string | null;
  completed: boolean;
  label?: string | null;
  score_breakdown: {
    score: number;
    components: ScoreComponent[];
    daily_allocation?: {
      unit: string;
      per_day: number;
      capped: boolean;
      cap_value: number;
      baseline_daily: number;
      remaining: number;
    };
  };
}

export interface Goal {
  id: number;
  title: string;
  /** Null means unfiled — shown in a neutral cluster, never hidden. */
  area_id: number | null;
  kind: string;
  activation: string;
  deadline: string | null;
  stakes: number;
  definition_of_done: string;
  dod_source: string;
  status: string;
}
