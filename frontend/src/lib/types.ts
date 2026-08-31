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
  /** The same estimate per minute. Honest to compare across session lengths. */
  point_per_minute: number | null;
}

/** How a displayed number was arrived at, as data rather than prose (P3). */
export interface Calculation {
  formula: string;
  /** [label, value] pairs. Null values render as an em dash, never as zero. */
  terms: [string, number | null][];
  result: number | null;
  note: string;
}

/**
 * Two dimensionless readings of pace, never collapsed into one.
 *
 * `pace` is how fast you work on this relative to your usual for this kind of
 * work; `track` is how far off-pace you are relative to the commitment. D6
 * keeps them apart: a goal at 0.7 pace may simply have had an aggressive plan.
 * Either may be null, which means absent -- never render it as 1.0.
 */
export interface PaceScores {
  pace: number | null;
  track: number | null;
  pace_calculation: Calculation;
  track_calculation: Calculation;
}

/** What a unit of each axis costs in minutes, fit from one trackable's history. */
export interface DensityFit {
  /** Minutes per primary unit. */
  alpha: number | null;
  /** Minutes per secondary unit. */
  beta: number | null;
  /** Primary units displaced by one secondary unit. */
  k: number | null;
  r_squared: number | null;
  n_sessions: number;
  basis: Basis;
  /** Which guard fired when the fit is unavailable. Show it; never show a zero. */
  reason: string;
}

/**
 * How much work one session held, as opposed to how much progress it made.
 *
 * `progress_outlier` with `explained_by_density` is the pair that matters: an
 * alarming page count whose index is normal means the session was DENSE, not
 * slow. Never render a null index as 1.0 — absent is absent (P2).
 */
export interface SessionProductivity {
  effective_output: number | null;
  productivity_index: number | null;
  density_factor: number | null;
  progress_outlier: boolean;
  explained_by_density: boolean;
  fit: DensityFit;
  calculation: Calculation;
}

/** Which unit measures this work more faithfully, over the same sessions. */
export interface SeriesStability {
  primary_relative_iqr: number | null;
  secondary_relative_iqr: number | null;
  n_sessions: number;
  secondary_is_tighter: boolean;
  reason: string;
}

/** What the model read out of a session note. Nothing here is stored until the
    user confirms the count via PATCH /api/sessions/{id}/secondary. */
export interface SessionInsight {
  observation: string;
  likely_cause: string;
  extracted_secondary_unit: string | null;
  extracted_secondary_output: number | null;
  extraction_confidence: "explicit" | "inferred" | "none";
  metric_switch_worth_reviewing: boolean;
  reasoning: string;
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
  /** 'not_started' | 'in_progress' | 'done' | 'abandoned'. Returned all along;
      simply never declared here until something needed to filter on it. */
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
  actual_minutes: number | null;
  expected_output: number | null;
  actual_output: number | null;
  secondary_output: number | null;
  secondary_expected_output: number | null;
  /** Minutes worked past planned_minutes. Null on sessions that predate it. */
  flow_minutes: number | null;
  focus_rating: number | null;
  note: string | null;
  interrupted: boolean;
  entered_retroactively: boolean;
}

/** GET /api/sessions/defaults. `presets` are one-tap choices, not a whitelist. */
export interface SessionDefaults {
  minutes: number;
  presets: number[];
  min_session_minutes: number;
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
