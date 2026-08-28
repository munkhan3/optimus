"""Value types for the metrics engine.

Everything here is a frozen stdlib dataclass. No Pydantic, no SQLModel, no ORM
rows -- the engine must be unit-testable with no database and no framework (§27).

The recurring shape is a point estimate that may be *absent*. P2 forbids
fabricated numbers, so every estimate carries a `basis` saying where it came
from, and callers must handle `point is None` rather than receiving a silent
zero or an infinity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum

# ---------------------------------------------------------------- enumerations


class Basis(str, Enum):
    """Where a point estimate came from. Rendered in the UI; never decorative."""

    OBSERVED = "observed"          # enough of the user's own sessions to stand alone
    SHRUNK = "shrunk"              # prior blended with observations (§24.3)
    PRIOR_ONLY = "prior_only"      # the user's initial estimate, no sessions yet
    POOLED_PRIOR = "pooled_prior"  # borrowed from other trackables of this task_type
    UNAVAILABLE = "unavailable"    # nothing to stand on. point is None. Say so.


class PaceMode(str, Enum):
    CARRY_FORWARD = "carry_forward"  # shortfall adds to remaining work (§12)
    RESET_PERIOD = "reset_period"    # shortfall is discarded at window close (§12)


class Provenance(str, Enum):
    """D3. Every value the system did not observe is tagged and resurfaced."""

    GROUNDED = "grounded"
    USER_SUPPLIED = "user_supplied"
    MODEL_ESTIMATED = "model_estimated"


# -------------------------------------------------------------------- inputs


@dataclass(frozen=True)
class SessionObs:
    """One logged work session, as the engine sees it.

    `task_type` is denormalized onto the session at write time rather than
    reached through the trackable, so pooling stays a single-table read and
    history stays correct if a trackable is later reclassified.
    """

    task_type: str
    started_at: datetime
    actual_output: float | None = None
    expected_output: float | None = None
    interrupted: bool = False           # excluded from pace, retained (§23.6)
    entered_retroactively: bool = False  # D13: down-weighted in calibration only
    intent_met: bool | None = None       # exploratory sessions, instead of a count

    @property
    def counts_toward_pace(self) -> bool:
        """Interrupted sessions are retained but never shape pace (test 8)."""
        return not self.interrupted and self.actual_output is not None


@dataclass(frozen=True)
class TrackableState:
    """A metered body of work. Exploratory work has no honest counter (D2/D12)."""

    id: int
    task_type: str
    total_units: float
    completed_units: float
    unit: str = "units"
    prior_pace: float | None = None   # the user's own initial units/session guess
    target_date: date | None = None
    exploratory: bool = False
    pace_mode: PaceMode = PaceMode.CARRY_FORWARD
    total_units_source: Provenance = Provenance.USER_SUPPLIED


@dataclass(frozen=True)
class BaselineState:
    """A versioned plan. Version 1 is retained forever and always displayed (§25.3)."""

    version: int
    planned_sessions: int
    target_date: date
    scope_units: float | None = None
    resolution: str | None = None
    rationale: str | None = None


@dataclass(frozen=True)
class ProgressCheck:
    """D12: self-assessed percent. Feeds stall detection and NOTHING else.

    If you find yourself importing this type into pace.py, feasibility.py,
    health.py, or scoring.py, stop -- that is the coupling test 14 forbids.
    """

    self_assessed_pct: float
    recorded_at: datetime
    note: str | None = None


# ------------------------------------------------------------------- outputs


@dataclass(frozen=True)
class Interval:
    """A displayed uncertainty band. D8: displayed, not propagated.

    This gates exactly one decision -- whether to rebaseline (§25.4). It must
    not be threaded into projections, scores, or feasibility arithmetic.
    """

    low: float
    high: float
    provisional: bool  # True while n < min_sessions_for_iqr; label it in the UI

    @property
    def width(self) -> float:
        return self.high - self.low


@dataclass(frozen=True)
class PaceEstimate:
    """§24.3. `point` is None when there is genuinely nothing to stand on."""

    point: float | None
    basis: Basis
    interval: Interval | None = None
    n_sessions: int = 0          # non-interrupted observations behind this
    observed_mean: float | None = None
    prior_pace: float | None = None

    @property
    def is_usable(self) -> bool:
        return self.point is not None and self.point > 0


@dataclass(frozen=True)
class Progress:
    """§24.1. `fraction` is None when total_units is unknown or zero."""

    completed_units: float
    total_units: float
    remaining_units: float
    fraction: float | None


@dataclass(frozen=True)
class RequiredPace:
    """§24.2. The denominator is fixed by commitment (D5) to break circularity."""

    point: float | None
    remaining_units: float
    remaining_sessions: int
    denominator_source: str  # 'weekly_commitment' | 'baseline' -- shown to the user


@dataclass(frozen=True)
class Drift:
    """§24.4. Sessions of slip. Positive = behind. Consumed at rebaseline, not daily."""

    sessions: float | None
    vs_version: int
    projected_sessions_needed: float | None
    planned_sessions_remaining: int


@dataclass(frozen=True)
class CalibrationReport:
    """§24.5. actual/expected. The system's model of the user's optimism.

    Timed and retroactive distributions are exposed separately so
    `retroactive_weight` can later be set from data instead of left at 0.5 (D13).
    """

    median_ratio: float | None
    n_total: int
    timed_ratios: tuple[float, ...] = ()
    retroactive_ratios: tuple[float, ...] = ()

    @property
    def n_timed(self) -> int:
        return len(self.timed_ratios)

    @property
    def n_retroactive(self) -> int:
        return len(self.retroactive_ratios)


@dataclass(frozen=True)
class Feasibility:
    """§24.6. Never reports an infinite required pace; never proposes a later date."""

    feasible: bool | None          # None == undeterminable, which is not the same as True
    sessions_needed: float | None
    sessions_available: int | None
    margin_sessions: float | None  # available - needed. Negative == infeasible.
    reason: str = ""


@dataclass(frozen=True)
class Projection:
    """§24.7. Always a range derived from the pace interval. Never a single date."""

    earliest: date | None
    latest: date | None
    provisional: bool
    target_date: date | None = None

    @property
    def misses_target(self) -> bool | None:
        if self.earliest is None or self.target_date is None:
            return None
        return self.earliest > self.target_date


@dataclass(frozen=True)
class HealthComponent:
    name: str
    value: float | None
    weight: float
    note: str = ""


@dataclass(frozen=True)
class Health:
    """§24.8. Composite, but the components are ALWAYS shown alongside it (P3).

    Feasibility margin dominates. Pace ratio is deliberately not dominant (D6).
    Self-assessed progress is not a term at all (test 14).
    """

    score: float | None
    components: tuple[HealthComponent, ...]


@dataclass(frozen=True)
class StallReport:
    """§24.9. Produces a review prompt, not a score change.

    The raw series is reported because 40 -> 60 -> 75 -> 80 -> 80 -> 80 tells a
    story that a single number does not.
    """

    stalled: bool
    sessions_since_movement: int
    latest_pct: float | None
    series: tuple[float, ...] = ()


@dataclass(frozen=True)
class ScoreComponent:
    name: str
    raw: float | None
    normalized: float
    weight: float

    @property
    def contribution(self) -> float:
        return self.normalized * self.weight


@dataclass(frozen=True)
class ScoredItem:
    """§25.1. `components` is persisted verbatim as plan_item.score_breakdown.

    Not telemetry. It is the only way to answer "why this?" (P3) and it is the
    training set for Part IV. Never allow it to be empty (test 13).
    """

    score: float
    components: tuple[ScoreComponent, ...]
    trackable_id: int | None = None
    milestone_id: int | None = None

    def breakdown(self) -> dict:
        """The JSON written to plan_item.score_breakdown."""
        return {
            "score": self.score,
            "components": [
                {
                    "name": c.name,
                    "raw": c.raw,
                    "normalized": c.normalized,
                    "weight": c.weight,
                    "contribution": c.contribution,
                }
                for c in self.components
            ],
        }


@dataclass(frozen=True)
class RebaselineProposal:
    """§17/§25.2. Exactly four options, and moving the deadline is never the default.

    The engine proposes; it never applies. D11 -- the user decides, always.
    """

    should_prompt: bool
    trigger: str                       # 'drift' | 'stall' | 'catch_up_cap' | ''
    gate_passed: bool                  # §25.4: n >= 5, or drift beyond interval
    gate_reason: str = ""
    options: tuple[str, ...] = field(
        default_factory=lambda: (
            "add_sessions",
            "cut_scope",
            "move_deadline",
            "declare_infeasible",
        )
    )


@dataclass(frozen=True)
class ScoreInputs:
    """Everything §25.1 needs to rank one candidate, metered or not.

    Deliberately flat and provenance-free: scoring reads numbers, not rows, so
    a metered trackable and a counter-less milestone arrive in identical shape
    and are ranked on identical terms (test 6).
    """

    stakes: int
    trackable_id: int | None = None
    milestone_id: int | None = None
    feasibility_margin_sessions: float | None = None
    days_to_deadline: int | None = None
    unblocks_something: bool = False
    days_since_last_session: int | None = None
    est_minutes: int | None = None
    label: str = ""


@dataclass(frozen=True)
class DailyAllocation:
    """§25.5. Arithmetic, not scoring -- the week's ranking is not recomputed."""

    per_day_units: float
    baseline_daily: float
    cap_value: float
    capped: bool          # True == the week does not fit. A rebaseline signal (D9).
    working_days_remaining: int
    remaining_units: float
