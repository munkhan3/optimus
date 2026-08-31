"""Request and response bodies.

Kept separate from models.py so the wire format can differ from the schema --
notably, session logging accepts far less than the table stores, because every
field the user must supply is a field that makes logging cost more (P5).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field

# -------------------------------------------------------------------- accounts


class AccountCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)


class AccountLogin(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=256)


class AccountDelete(BaseModel):
    password: str = Field(min_length=1, max_length=256)

# ------------------------------------------------------------------ goal tree


class AreaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str | None = None


class AreaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = None


class GoalCreate(BaseModel):
    title: str
    kind: str = "goal"
    definition_of_done: str = Field(min_length=1)
    dod_source: str = "user_supplied"
    description: str | None = None
    parent_id: int | None = None
    activation: str = "parked"
    deadline: date | None = None
    pace_mode: str = "carry_forward"
    reset_period_days: int | None = None
    stakes: int = Field(default=3, ge=1, le=5)
    area_id: int | None = None


class GoalUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    definition_of_done: str | None = None
    activation: str | None = None
    deadline: date | None = None
    pace_mode: str | None = None
    reset_period_days: int | None = None
    stakes: int | None = Field(default=None, ge=1, le=5)
    # Sent explicitly as null to un-file a goal; update_goal uses
    # exclude_unset, so an omitted key still means "leave it alone".
    area_id: int | None = None
    status: str | None = None
    verified: bool | None = None


class MilestoneCreate(BaseModel):
    goal_id: int
    title: str
    definition_of_done: str = Field(min_length=1)
    dod_source: str = "user_supplied"
    deadline: date | None = None
    blocked_by: int | None = None
    # §10: work with no natural counter is budgeted in sessions, not fake units.
    planned_sessions: int | None = None
    exploratory: bool = False


class MilestoneUpdate(BaseModel):
    """Narrow on purpose.

    goal_id is absent: re-parenting a milestone moves work between goals and
    silently rewrites the history of both, so it is not a PATCH.
    """

    title: str | None = None
    definition_of_done: str | None = Field(default=None, min_length=1)
    deadline: date | None = None
    blocked_by: int | None = None
    planned_sessions: int | None = None
    status: str | None = None
    verified: bool | None = None


class TrackableUpdate(BaseModel):
    """Narrow on purpose.

    total_units is absent: changing scope is a rebaseline (§17), which records
    what was dropped and why. Letting it through here would be exactly the
    silent drift the rebaseline flow exists to prevent.

    completed_units is absent too -- it is a trigger-maintained cache of
    SUM(actual_output) and the only honest way to move it is to log a session.
    """

    title: str | None = None
    target_date: date | None = None
    prior_pace: float | None = None
    status: str | None = None


class TrackableCreate(BaseModel):
    milestone_id: int
    title: str
    unit: str
    total_units: float = Field(gt=0)
    total_units_source: str = "user_supplied"
    task_type: str
    target_date: date | None = None
    prior_pace: float | None = None
    exploratory: bool = False


# -------------------------------------------------------------------- sessions


class SessionStart(BaseModel):
    """Starting from the daily plan is one tap; everything else is prefilled (§23.1)."""

    trackable_id: int | None = None
    milestone_id: int | None = None
    task_id: int | None = None
    # §36.1 reversed: any positive length. Defaults to config [session].minutes;
    # [session].presets are the one-tap choices, not a whitelist.
    planned_minutes: int | None = Field(default=None, gt=0)
    # A session attached to nothing yet. Its task_type cannot be resolved from a
    # trackable, so it is declared -- and it shapes no pace, because with no
    # trackable there is no expected_output and so no actual_output either.
    task_type: str | None = None
    # A target the user DECLARES on the second axis ("8 problems this session"),
    # unlike expected_output which §23.4 requires to come from pace_hat.
    # Declaring this corrupts nothing: it feeds no calibration and no projection.
    target_secondary_output: float | None = Field(default=None, ge=0)


class SessionEnd(BaseModel):
    """Ending a metered session takes ONE input (§23.2).

    `actual_output` omitted means "the expected value was right" -- confirming
    is one tap. For exploratory work `intent_met` is the single toggle (§23.3).
    """

    actual_output: float | None = None
    intent_met: bool | None = None
    interrupted: bool = False
    # Time spent past the planned end. The client sends it because only the
    # client knows when the countdown actually crossed zero; omitting it falls
    # back to the wall-clock overrun.
    flow_minutes: float | None = Field(default=None, ge=0)
    focus_rating: int | None = Field(default=None, ge=1, le=5)
    # Always offered, never required. The §23 interaction budget survives because
    # the field is collapsed until asked for -- and an outlier session asks.
    note: str | None = None
    # The second axis: work done, as opposed to progress made.
    secondary_output: float | None = Field(default=None, ge=0)
    # D12: offered alongside, prefilled, ALWAYS skippable. Omitting it writes no
    # progress_check row at all (AC16).
    self_assessed_pct: float | None = Field(default=None, ge=0, le=100)


class SessionRetroactive(BaseModel):
    """§23.5. Without this, every forgotten day becomes a permanent hole."""

    started_at: datetime
    trackable_id: int | None = None
    milestone_id: int | None = None
    task_id: int | None = None
    actual_output: float | None = None
    expected_output: float | None = None
    intent_met: bool | None = None
    planned_minutes: int | None = None
    actual_minutes: float | None = None
    interrupted: bool = False
    note: str | None = None
    secondary_output: float | None = Field(default=None, ge=0)


class SessionReflection(BaseModel):
    """What happened in a session, recorded after it was already saved.

    Ending stays one tap (§23.2), so the prompt that asks why an unusual session
    went the way it did necessarily arrives afterwards -- and needs somewhere to
    put the answer.

    This is also the only path by which a model-extracted count becomes stored
    data. The analysis endpoint RETURNS what it read out of the note and writes
    nothing; passing it through here makes it a user-supplied number, which is
    what lets the mirrored columns carry no per-observation provenance field.
    """

    note: str | None = None
    secondary_output: float | None = Field(default=None, ge=0)
    # Set on the trackable when it has no second axis yet, so confirming a count
    # names the unit in the same action rather than requiring a separate edit.
    secondary_unit: str | None = None


class SessionAttach(BaseModel):
    """Attaching an untagged session to what the interview just created."""

    trackable_id: int | None = None
    milestone_id: int | None = None
    actual_output: float | None = Field(default=None, ge=0)
    secondary_output: float | None = Field(default=None, ge=0)


class MetricSwitch(BaseModel):
    """Promote the second axis to primary (§25.3, resolution `change_metric`).

    `secondary_total_units` is the one field here that may hold a model estimate,
    which is why its provenance travels with it and is written to the trackable.
    """

    secondary_total_units: float = Field(gt=0)
    secondary_total_units_source: str = "model_estimated"
    rationale: str = Field(min_length=1)


# ------------------------------------------------------------------ baselines


class BaselineCreate(BaseModel):
    trackable_id: int | None = None
    milestone_id: int | None = None
    planned_sessions: int = Field(ge=0)
    target_date: date
    scope_units: float | None = None


class RebaselineRequest(BaseModel):
    """§17: exactly four options, and the reason is mandatory."""

    resolution: str
    rationale: str = Field(min_length=1)
    planned_sessions: int = Field(ge=0)
    target_date: date
    scope_units: float | None = None


# ------------------------------------------------------------------- capacity


class CapacityCreate(BaseModel):
    week_start: date
    available_hours: float = Field(gt=0)
    session_minutes: int | None = None


class BudgetSet(BaseModel):
    goal_id: int
    budgeted_sessions: int = Field(ge=0)


class CommitmentSet(BaseModel):
    trackable_id: int | None = None
    milestone_id: int | None = None
    committed_sessions: int = Field(ge=0)
    target_units: float | None = None


class PlanItemAction(BaseModel):
    """Revealed preference -- the only real signal about the user's utility (§18)."""

    user_action: str
    completed: bool | None = None


class ProgressCheckCreate(BaseModel):
    milestone_id: int | None = None
    trackable_id: int | None = None
    self_assessed_pct: float = Field(ge=0, le=100)
    note: str | None = None


class GapAnswer(BaseModel):
    answer: str
    status: str = "answered"


class Envelope(BaseModel):
    data: Any


# ------------------------------------------------------------------ dashboard


class WidgetPlacement(BaseModel):
    """One widget on the grid.

    `kind` is not validated against an enum here. The widget catalogue is a
    frontend concern that will churn, and a server-side whitelist would turn
    every new widget into a deploy-ordering problem. An unknown kind renders as
    a placeholder and is preserved on save (see the layout router).
    """

    i: str                      # stable id, unique within the layout
    kind: str
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(gt=0)
    h: int = Field(gt=0)
    # Per-widget settings: which goal, how many weeks, which task type.
    config: dict[str, Any] = Field(default_factory=dict)


class LayoutSet(BaseModel):
    widgets: list[WidgetPlacement]


class AllocationSet(BaseModel):
    """N sessions of one piece of work, on one day. No clock time (§36.1)."""

    trackable_id: int | None = None
    milestone_id: int | None = None
    plan_date: date
    sessions: int = Field(ge=0)


class AllocationsSet(BaseModel):
    week_start: date
    allocations: list[AllocationSet]
