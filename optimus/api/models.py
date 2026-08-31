"""The v0 schema (§21), with four corrections to the document.

vision.md is the source of truth, and where this file departs from §21 it is
because §21 is internally inconsistent. Each departure is marked FIX and is
mirrored back into the doc:

  FIX 1  A vision cannot be active under §21's CHECK, because it demands a
         deadline of every active row -- but §9 defines a vision as
         "directional, unbounded, never complete". The check now exempts
         kind='vision'.

  FIX 2  open_gap has no trackable_id, yet acceptance test 18 requires a gap
         row whenever a model_estimated total_units is written, and
         total_units lives on trackable. Added.

  FIX 3  baseline and progress_check may attach to either a trackable or a
         milestone, but only the trackable side was unique-constrained and
         neither forbade attaching to both or neither. Added an exactly-one
         check and the missing uniqueness.

  FIX 4  work_session had no task_type, but §24.3 pools pace by it. Reaching it
         through the trackable breaks for task-only sessions and silently
         rewrites history if a trackable is reclassified. Denormalized onto the
         session at write time.

The enum-ish TEXT columns keep §21's shape rather than becoming Postgres enums:
adding a value to a CHECK constraint is a cheaper migration than altering a
type, and this schema is expected to churn through M2-M4.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

# --------------------------------------------------------------- vocabularies

KIND = ("vision", "goal")
ACTIVATION = ("active", "parked")
PACE_MODE = ("carry_forward", "reset_period")
PROVENANCE = ("grounded", "user_supplied", "model_estimated")
DOD_SOURCE = ("user_supplied", "model_estimated")
NODE_STATUS = ("not_started", "in_progress", "done", "abandoned")
TASK_STATUS = ("open", "done", "deferred", "dropped")
TRACKABLE_STATUS = ("not_started", "in_progress", "done", "abandoned")
GAP_STATUS = ("open", "answered", "dismissed")
TIER = ("A", "B", "C", "D")
USER_ACTION = ("accepted", "modified", "rejected", "deferred")
# §17 fixes exactly four ways to respond to divergence between plan and reality.
# `change_metric` is a fifth entry here but NOT a fifth option there: re-expressing
# scope in a better unit is a different act, not another way to absorb slip. It is
# unreachable from the drift flow -- see FOUR_OPTIONS in optimus/metrics/rebaseline.py,
# which is deliberately left at four.
RESOLUTION = (
    "add_sessions",
    "cut_scope",
    "move_deadline",
    "declare_infeasible",
    "change_metric",
)
TASK_TYPE = ("reading", "problems", "writing", "exploratory", "admin")


def _in(column: str, values: tuple[str, ...]) -> str:
    joined = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({joined})"


def _utcnow() -> datetime:
    from datetime import UTC

    return datetime.now(UTC)


# §21: "Timestamps UTC, ISO 8601". Postgres TIMESTAMP WITHOUT TIME ZONE would
# hand back naive datetimes that silently compare wrong against the aware ones
# the application creates, so every timestamp column is timestamptz.
TZ = DateTime(timezone=True)

# §21 specifies DEFAULT 0 on these columns. A Python-side default alone would
# leave the column NULL for any write that does not go through SQLModel, which
# a NOT NULL column then rejects. Server defaults keep the schema honest on its
# own terms.
FALSE_DEFAULT = {"server_default": text("false")}
ZERO_DEFAULT = {"server_default": text("0")}
USER_ID_DEFAULT = text("NULLIF(current_setting('app.user_id', true), '')::integer")


def owner_field():
    """Owner is assigned by Postgres from the authenticated request context."""
    return Field(
        default=None,
        sa_column=Column(
            "user_id",
            Integer,
            ForeignKey("app_user.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
            server_default=USER_ID_DEFAULT,
        ),
    )


# ------------------------------------------------------------------- accounts


class User(SQLModel, table=True):
    __tablename__ = "app_user"

    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(sa_column=Column(String(320), unique=True, index=True, nullable=False))
    password_hash: str
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


class AuthSession(SQLModel, table=True):
    __tablename__ = "auth_session"

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="app_user.id", index=True)
    token_hash: str = Field(sa_column=Column(String(64), unique=True, index=True, nullable=False))
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)
    expires_at: datetime = Field(sa_type=TZ)


# ---------------------------------------------------------------------- area


class Area(SQLModel, table=True):
    """An area of life: professional, health, hobbies.

    Deliberately NOT a Vision. §9 makes a vision a planning entity -- it sits at
    level 1 of the goal graph, carries a definition of done, and is the thing a
    goal compiles up into. An area carries none of that and never competes for
    time; it exists so the graph can be read at a glance. Conflating the two
    would have given every "Health" label a definition of done to satisfy.
    """

    __tablename__ = "area"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="area_user_name_unique"),
        CheckConstraint("length(trim(name)) > 0", name="area_name_not_blank"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    name: str
    # Null means "derive it" -- see the chromatic set in index.css. Stored only
    # if the user ever overrides it.
    color: str | None = None
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


# ---------------------------------------------------------------------- goal


class Goal(SQLModel, table=True):
    __tablename__ = "goal"
    __table_args__ = (
        CheckConstraint(_in("kind", KIND), name="goal_kind_valid"),
        CheckConstraint(_in("activation", ACTIVATION), name="goal_activation_valid"),
        CheckConstraint(_in("pace_mode", PACE_MODE), name="goal_pace_mode_valid"),
        CheckConstraint(_in("dod_source", DOD_SOURCE), name="goal_dod_source_valid"),
        CheckConstraint(_in("status", NODE_STATUS), name="goal_status_valid"),
        CheckConstraint("stakes BETWEEN 1 AND 5", name="goal_stakes_range"),
        # D1/D4 and AC1: an active goal needs a deadline. Two exemptions, both
        # because "no deadline column" does not mean "no deadline":
        #
        #   A vision is unbounded by definition and never completes (§9).
        #
        #   A reset_period commitment has a deadline every period -- §12 is
        #   explicit that "gym six days a week has a deadline every week" and
        #   that these are recurring deadlines, "not an exception". Requiring an
        #   absolute date made the entire recurring category impossible to
        #   activate. FIX 5 relative to §21.
        CheckConstraint(
            "kind = 'vision' "
            "OR activation <> 'active' "
            "OR deadline IS NOT NULL "
            "OR (pace_mode = 'reset_period' AND reset_period_days IS NOT NULL)",
            name="goal_active_requires_deadline",
        ),
        CheckConstraint(
            "pace_mode <> 'reset_period' OR reset_period_days IS NOT NULL",
            name="goal_reset_period_requires_days",
        ),
        # D1: a goal that cannot be recognized as complete cannot be planned
        # against (§10). Emptiness is as bad as absence.
        CheckConstraint(
            "length(trim(definition_of_done)) > 0", name="goal_dod_not_blank"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    parent_id: int | None = Field(default=None, foreign_key="goal.id", index=True)
    # SET NULL on delete: removing an area un-files its goals, never deletes them.
    area_id: int | None = Field(
        default=None,
        sa_column=Column(
            "area_id",
            Integer,
            ForeignKey("area.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )
    title: str
    description: str | None = None
    kind: str

    definition_of_done: str
    dod_source: str

    activation: str = "parked"
    deadline: date | None = None
    pace_mode: str = "carry_forward"
    reset_period_days: int | None = None

    stakes: int = 3
    status: str = "not_started"
    verified: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)
    # NULL means the completion date is UNKNOWN, not that the work is
    # unfinished -- every row written before this column existed reads that
    # way, and a roadmap that drew them as open bars would be inventing
    # history. Stamped by write_rules.stamp_completion, never by a router.
    completed_at: datetime | None = Field(default=None, sa_type=TZ)


class Milestone(SQLModel, table=True):
    __tablename__ = "milestone"
    __table_args__ = (
        CheckConstraint(_in("dod_source", DOD_SOURCE), name="milestone_dod_source_valid"),
        CheckConstraint(_in("status", NODE_STATUS), name="milestone_status_valid"),
        CheckConstraint(
            "length(trim(definition_of_done)) > 0", name="milestone_dod_not_blank"
        ),
        CheckConstraint("blocked_by IS NULL OR blocked_by <> id", name="milestone_no_self_block"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    goal_id: int = Field(foreign_key="goal.id", index=True)
    title: str
    definition_of_done: str
    dod_source: str
    deadline: date | None = None
    blocked_by: int | None = Field(default=None, foreign_key="milestone.id")
    status: str = "not_started"
    verified: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)
    # §10: work with no natural counter has no trackable and is budgeted in
    # sessions instead. Forcing a number here is the most damaging thing the
    # system can do, so this is how such milestones stay first-class.
    planned_sessions: int | None = None
    exploratory: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)
    # NULL is UNKNOWN, not unfinished -- see Goal.completed_at.
    completed_at: datetime | None = Field(default=None, sa_type=TZ)


class Trackable(SQLModel, table=True):
    __tablename__ = "trackable"
    __table_args__ = (
        CheckConstraint(_in("task_type", TASK_TYPE), name="trackable_task_type_valid"),
        CheckConstraint(
            _in("total_units_source", PROVENANCE), name="trackable_units_source_valid"
        ),
        CheckConstraint(_in("status", TRACKABLE_STATUS), name="trackable_status_valid"),
        CheckConstraint("total_units > 0", name="trackable_total_units_positive"),
        CheckConstraint("completed_units >= 0", name="trackable_completed_non_negative"),
        CheckConstraint(
            "secondary_total_units IS NULL OR secondary_total_units > 0",
            name="trackable_secondary_total_positive",
        ),
        CheckConstraint(
            "secondary_completed_units >= 0",
            name="trackable_secondary_completed_non_negative",
        ),
        CheckConstraint(
            "secondary_total_units_source IS NULL OR "
            + _in("secondary_total_units_source", PROVENANCE),
            name="trackable_secondary_units_source_valid",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    milestone_id: int = Field(foreign_key="milestone.id", index=True)
    title: str
    unit: str
    total_units: float
    total_units_source: str
    # A cache of SUM(actual_output), maintained by a database trigger so it
    # cannot drift from the authoritative value (AC7).
    completed_units: float = Field(default=0.0, sa_column_kwargs=ZERO_DEFAULT)
    target_date: date | None = None
    prior_pace: float | None = None   # the user's own initial units/session estimate
    task_type: str
    # The second axis. `unit` measures PROGRESS and is chosen because its
    # denominator is knowable (a book has 380 pages); it is a poor measure of
    # WORK, because a page holding a problem is not a page of prose. The
    # secondary unit measures work, and needs no total to be useful -- which is
    # the point, since the total is exactly what is hard to discover.
    #
    # NULL secondary_unit means "no second axis", never zero.
    secondary_unit: str | None = None
    # Only needed to promote this axis to primary, and the only field here that
    # can hold a model estimate -- hence the provenance column beside it.
    secondary_total_units: float | None = None
    secondary_total_units_source: str | None = None
    # Cache of SUM(secondary_output), maintained by the same trigger that owns
    # completed_units so the two cannot drift apart.
    secondary_completed_units: float = Field(default=0.0, sa_column_kwargs=ZERO_DEFAULT)
    exploratory: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)
    status: str = "not_started"
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)
    # NULL is UNKNOWN, not unfinished -- see Goal.completed_at.
    completed_at: datetime | None = Field(default=None, sa_type=TZ)


class Task(SQLModel, table=True):
    __tablename__ = "task"
    __table_args__ = (
        CheckConstraint(_in("status", TASK_STATUS), name="task_status_valid"),
        CheckConstraint("blocked_by IS NULL OR blocked_by <> id", name="task_no_self_block"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id", index=True)
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id", index=True)
    description: str
    est_minutes: int | None = None
    expected_output: float | None = None   # prefilled from pace_hat, never a fixed guess
    intent: str | None = None              # exploratory: what "done" means this session
    deadline: date | None = None
    blocked_by: int | None = Field(default=None, foreign_key="task.id")
    status: str = "open"
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


# ------------------------------------------------------------------ capacity


class Capacity(SQLModel, table=True):
    __tablename__ = "capacity"
    __table_args__ = (UniqueConstraint("user_id", "week_start", name="capacity_user_week_unique"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    week_start: date = Field(index=True)
    available_hours: float
    session_minutes: int = 25


class GoalBudget(SQLModel, table=True):
    __tablename__ = "goal_budget"
    __table_args__ = (
        UniqueConstraint("capacity_id", "goal_id", name="goal_budget_unique"),
        CheckConstraint("budgeted_sessions >= 0", name="goal_budget_non_negative"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    capacity_id: int = Field(foreign_key="capacity.id", index=True)
    goal_id: int = Field(foreign_key="goal.id", index=True)
    budgeted_sessions: int


class WeeklyCommitment(SQLModel, table=True):
    """D5: committing a session budget weekly fixes the pace denominator."""

    __tablename__ = "weekly_commitment"
    __table_args__ = (
        CheckConstraint(
            "(trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)",
            name="weekly_commitment_exactly_one_target",
        ),
        CheckConstraint("committed_sessions >= 0", name="weekly_commitment_non_negative"),
        Index(
            "weekly_commitment_trackable_unique",
            "capacity_id",
            "trackable_id",
            unique=True,
            postgresql_where=text("trackable_id IS NOT NULL"),
        ),
        Index(
            "weekly_commitment_milestone_unique",
            "capacity_id",
            "milestone_id",
            unique=True,
            postgresql_where=text("milestone_id IS NOT NULL"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    capacity_id: int = Field(foreign_key="capacity.id", index=True)
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id")
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id")
    committed_sessions: int
    target_units: float | None = None
    # D9 requires the weekly score to be computed ONCE and reused by every day
    # of that week -- re-scoring daily produces the thrash §16 warns about. §21
    # gives it nowhere to live, since plan_item is rewritten each day, so the
    # frozen score and its breakdown are stored here at commit time and copied
    # onto each day's plan_item unchanged.
    score: float | None = None
    score_breakdown: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True),
    )
    committed_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


# ------------------------------------------------------------------ sessions


class WorkSession(SQLModel, table=True):
    """D2/P5. Logging is a checkoff, never an act of measurement."""

    __tablename__ = "work_session"
    __table_args__ = (
        CheckConstraint(_in("task_type", TASK_TYPE), name="work_session_task_type_valid"),
        CheckConstraint("planned_minutes > 0", name="work_session_planned_minutes_positive"),
        CheckConstraint(
            "ended_at IS NULL OR ended_at >= started_at", name="work_session_ends_after_start"
        ),
        CheckConstraint(
            "flow_minutes IS NULL OR flow_minutes >= 0",
            name="work_session_flow_minutes_non_negative",
        ),
        CheckConstraint(
            "secondary_output IS NULL OR secondary_output >= 0",
            name="work_session_secondary_output_non_negative",
        ),
        Index("work_session_task_type_started", "task_type", "started_at"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    task_id: int | None = Field(default=None, foreign_key="task.id")
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id", index=True)
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id", index=True)
    # FIX 4: denormalized so pace pooling is a single-table read and history
    # survives a trackable being reclassified.
    task_type: str
    started_at: datetime = Field(sa_type=TZ)
    ended_at: datetime | None = Field(default=None, sa_type=TZ)
    planned_minutes: int = 25
    actual_minutes: float | None = None
    expected_output: float | None = None
    actual_output: float | None = None
    # The second axis, per session. `secondary_expected_output` is a target the
    # user DECLARES ("8 problems this session"), unlike expected_output which
    # §23.4 requires to come from pace_hat. Declaring a target here corrupts
    # nothing: it feeds no calibration and no projection.
    secondary_output: float | None = None
    secondary_expected_output: float | None = None
    intent_met: bool | None = None      # exploratory sessions, instead of a count
    # Minutes worked PAST planned_minutes, once the countdown had already run
    # out and the user chose to keep going. Stored rather than derived so the
    # client can report what it actually watched happen; see end_session.
    flow_minutes: float | None = None
    focus_rating: int | None = None
    note: str | None = None
    interrupted: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)
    entered_retroactively: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)


class ProgressCheckRow(SQLModel, table=True):
    """D12. Stored in full, read by exactly one thing: stall detection."""

    __tablename__ = "progress_check"
    __table_args__ = (
        CheckConstraint(
            "(trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)",
            name="progress_check_exactly_one_target",  # FIX 3
        ),
        CheckConstraint(
            "self_assessed_pct >= 0 AND self_assessed_pct <= 100",
            name="progress_check_pct_range",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id", index=True)
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id", index=True)
    self_assessed_pct: float
    session_id: int | None = Field(default=None, foreign_key="work_session.id")
    note: str | None = None
    recorded_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


class Baseline(SQLModel, table=True):
    """§17/§25.3. Version 1 is retained forever and displayed alongside current."""

    __tablename__ = "baseline"
    __table_args__ = (
        CheckConstraint(
            "(trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)",
            name="baseline_exactly_one_target",  # FIX 3
        ),
        CheckConstraint("version >= 1", name="baseline_version_positive"),
        CheckConstraint(
            "resolution IS NULL OR " + _in("resolution", RESOLUTION),
            name="baseline_resolution_valid",
        ),
        # v1 is the original and carries no resolution; every later version is
        # the result of an explicit choice and must record which one and why.
        CheckConstraint(
            "version = 1 OR (resolution IS NOT NULL AND rationale IS NOT NULL)",
            name="baseline_rebaseline_requires_reason",
        ),
        Index(
            "baseline_trackable_version_unique",
            "trackable_id",
            "version",
            unique=True,
            postgresql_where=text("trackable_id IS NOT NULL"),
        ),
        Index(  # FIX 3: §21 constrained only the trackable side
            "baseline_milestone_version_unique",
            "milestone_id",
            "version",
            unique=True,
            postgresql_where=text("milestone_id IS NOT NULL"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id", index=True)
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id", index=True)
    version: int
    planned_sessions: int
    scope_units: float | None = None
    # §25.3 keeps baseline history forever, and a metric switch changes what
    # scope_units COUNTS. Without recording the unit, v1's "380" and v2's "210"
    # look like a scope cut rather than the same work in a different currency.
    unit: str | None = None
    target_date: date
    resolution: str | None = None
    rationale: str | None = None
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


class OpenGap(SQLModel, table=True):
    """D3. Anything the model could not responsibly infer becomes a question."""

    __tablename__ = "open_gap"
    __table_args__ = (
        CheckConstraint(_in("status", GAP_STATUS), name="open_gap_status_valid"),
        CheckConstraint(
            "goal_id IS NOT NULL OR milestone_id IS NOT NULL OR trackable_id IS NOT NULL",
            name="open_gap_has_a_subject",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    goal_id: int | None = Field(default=None, foreign_key="goal.id", index=True)
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id", index=True)
    # FIX 2: total_units lives on trackable, and AC18 requires a gap whenever
    # one is model_estimated. Without this column that test cannot be satisfied.
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id", index=True)
    question: str
    priority: float                    # stakes x uncertainty (§15.3)
    status: str = "open"
    answer: str | None = None
    created_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


# --------------------------------------------------------------------- plans


class DailyPlan(SQLModel, table=True):
    __tablename__ = "daily_plan"
    __table_args__ = (UniqueConstraint("user_id", "plan_date", name="daily_plan_user_date_unique"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    plan_date: date = Field(index=True)
    generated_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)
    capacity_minutes: int
    carried_shortfall: float | None = None  # spread, never dumped (D9)
    accepted_at: datetime | None = Field(default=None, sa_type=TZ)


class PlanItem(SQLModel, table=True):
    __tablename__ = "plan_item"
    __table_args__ = (
        CheckConstraint(_in("tier", TIER), name="plan_item_tier_valid"),
        CheckConstraint(
            "user_action IS NULL OR " + _in("user_action", USER_ACTION),
            name="plan_item_user_action_valid",
        ),
        # P3 / AC13. The breakdown is the only way to answer "why this?" and it
        # is Part IV's training set. An empty one is a bug, not a degraded row.
        CheckConstraint("score_breakdown::text <> '{}'", name="plan_item_breakdown_not_empty"),
        CheckConstraint(
            "(trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)",
            name="plan_item_exactly_one_target",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    daily_plan_id: int = Field(foreign_key="daily_plan.id", index=True)
    task_id: int | None = Field(default=None, foreign_key="task.id")
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id")
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id")
    tier: str
    score: float                       # from the weekly ranking; NOT recomputed daily
    score_breakdown: dict[str, Any] = Field(
        sa_column=Column(JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    )
    allocated_units: float | None = None
    rank: int
    user_action: str | None = None     # revealed preference -- §32's training signal
    completed: bool = Field(default=False, sa_column_kwargs=FALSE_DEFAULT)


# ----------------------------------------------------------------- dashboards


class DashboardLayout(SQLModel, table=True):
    """The widget arrangement, as one JSON document per dashboard.

    A row per widget is the obvious shape and the wrong one: a single drag
    rewrites every position at once, so per-widget rows buy N-row churn per
    gesture and nothing else. A document is also written whole or not at all,
    which is what makes a half-saved layout impossible rather than merely
    unlikely.

    The widget list is deliberately untyped here. The set of widget kinds is a
    frontend concern that will churn, and a CHECK constraint enumerating them
    would turn every new widget into a migration.
    """

    __tablename__ = "dashboard_layout"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="dashboard_layout_user_name_unique"),
        CheckConstraint("length(trim(name)) > 0", name="dashboard_layout_name_not_blank"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    # Named so a second dashboard is a UI change later, not a migration.
    name: str = Field(default="Overview", sa_column_kwargs={"server_default": "Overview"})
    widgets: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(
            JSONB().with_variant(JSON(), "sqlite"),
            nullable=False,
            server_default=text("'[]'"),
        ),
    )
    updated_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)


class SessionAllocation(SQLModel, table=True):
    """A week shaped by hand: N sessions of this work, on this day.

    §25.5 redistributes a week across its remaining days arithmetically, with no
    scoring. This table is the user overriding that result (D11 -- the user
    always decides), and the day generator honours it when rows exist and falls
    back to the arithmetic when they do not.

    It is a table rather than a flag on plan_item because plan items are
    disposable: POST /api/planning/day deletes and rewrites every item for the
    date. A pinned flag there would survive exactly until the next regeneration,
    which is to say it would not survive at all.

    Note what is absent: any time of day. Sessions are fixed-length and their
    order within a day carries no meaning (§36.1), so storing a clock time would
    invent precision the model does not have -- and make Optimus a second
    calendar that disagrees with the real one (§7).
    """

    __tablename__ = "session_allocation"
    __table_args__ = (
        # The same exactly-one rule weekly_commitment carries. An allocation
        # pointing at both or neither is not a weaker record, it is a broken one.
        CheckConstraint(
            "(trackable_id IS NOT NULL) <> (milestone_id IS NOT NULL)",
            name="session_allocation_exactly_one_target",
        ),
        CheckConstraint("sessions >= 0", name="session_allocation_non_negative"),
        Index(
            "session_allocation_trackable_unique",
            "capacity_id",
            "trackable_id",
            "plan_date",
            unique=True,
            postgresql_where=text("trackable_id IS NOT NULL"),
        ),
        Index(
            "session_allocation_milestone_unique",
            "capacity_id",
            "milestone_id",
            "plan_date",
            unique=True,
            postgresql_where=text("milestone_id IS NOT NULL"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = owner_field()
    # CASCADE: an allocation is a shape for one week's committed capacity. If
    # that capacity row goes, the shape is meaningless rather than orphaned.
    capacity_id: int = Field(
        sa_column=Column(
            "capacity_id",
            Integer,
            ForeignKey("capacity.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )
    trackable_id: int | None = Field(default=None, foreign_key="trackable.id")
    milestone_id: int | None = Field(default=None, foreign_key="milestone.id")
    plan_date: date = Field(index=True)
    sessions: int
    updated_at: datetime = Field(default_factory=_utcnow, sa_type=TZ)
