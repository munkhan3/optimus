"""Request and response bodies.

Kept separate from models.py so the wire format can differ from the schema --
notably, session logging accepts far less than the table stores, because every
field the user must supply is a field that makes logging cost more (P5).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field

# ------------------------------------------------------------------ goal tree


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


class GoalUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    definition_of_done: str | None = None
    activation: str | None = None
    deadline: date | None = None
    pace_mode: str | None = None
    reset_period_days: int | None = None
    stakes: int | None = Field(default=None, ge=1, le=5)
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
    planned_minutes: int | None = None   # defaults to config [session].minutes


class SessionEnd(BaseModel):
    """Ending a metered session takes ONE input (§23.2).

    `actual_output` omitted means "the expected value was right" -- confirming
    is one tap. For exploratory work `intent_met` is the single toggle (§23.3).
    """

    actual_output: float | None = None
    intent_met: bool | None = None
    interrupted: bool = False
    focus_rating: int | None = Field(default=None, ge=1, le=5)
    note: str | None = None
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
