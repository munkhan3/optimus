"""Row -> engine-type conversion, and the capacity arithmetic the engine needs.

The metrics engine takes plain frozen dataclasses so it can be tested with no
database (§27). This module is the only place that knows both shapes.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func
from sqlmodel import Session, select

from optimus.metrics.types import (
    BaselineState,
    PaceMode,
    ProgressCheck,
    Provenance,
    SessionObs,
    TrackableState,
)

from ..models import (
    Baseline,
    Capacity,
    Goal,
    GoalBudget,
    Milestone,
    ProgressCheckRow,
    Trackable,
    WeeklyCommitment,
    WorkSession,
)


def week_start(day: date) -> date:
    """Monday of the week containing `day`. Weeks are the commitment unit (§16)."""
    return day - timedelta(days=day.weekday())


# ------------------------------------------------------------- row -> engine


def to_session_obs(row: WorkSession) -> SessionObs:
    return SessionObs(
        task_type=row.task_type,
        started_at=row.started_at,
        actual_output=row.actual_output,
        expected_output=row.expected_output,
        interrupted=row.interrupted,
        entered_retroactively=row.entered_retroactively,
        intent_met=row.intent_met,
    )


def to_trackable_state(row: Trackable) -> TrackableState:
    goal_pace_mode = PaceMode.CARRY_FORWARD  # refined by caller when the goal is known
    return TrackableState(
        id=row.id or 0,
        task_type=row.task_type,
        total_units=row.total_units,
        completed_units=row.completed_units,
        unit=row.unit,
        prior_pace=row.prior_pace,
        target_date=row.target_date,
        exploratory=row.exploratory,
        pace_mode=goal_pace_mode,
        total_units_source=Provenance(row.total_units_source),
    )


def to_baseline_state(row: Baseline) -> BaselineState:
    return BaselineState(
        version=row.version,
        planned_sessions=row.planned_sessions,
        target_date=row.target_date,
        scope_units=row.scope_units,
        resolution=row.resolution,
        rationale=row.rationale,
    )


def to_progress_check(row: ProgressCheckRow) -> ProgressCheck:
    return ProgressCheck(
        self_assessed_pct=row.self_assessed_pct,
        recorded_at=row.recorded_at,
        note=row.note,
    )


# ------------------------------------------------------------------- queries


def pooled_sessions(db: Session, task_type: str) -> list[SessionObs]:
    """Every session of this task_type (§24.3 pools across trackables).

    Pooling is what lets a brand-new trackable inherit the user's demonstrated
    speed at that kind of work instead of starting from their optimism.
    """
    rows = db.exec(
        select(WorkSession)
        .where(WorkSession.task_type == task_type)
        .where(WorkSession.ended_at.is_not(None))
        .order_by(WorkSession.started_at)
    ).all()
    return [to_session_obs(r) for r in rows]


def trackable_sessions(db: Session, trackable_id: int) -> list[SessionObs]:
    rows = db.exec(
        select(WorkSession)
        .where(WorkSession.trackable_id == trackable_id)
        .order_by(WorkSession.started_at)
    ).all()
    return [to_session_obs(r) for r in rows]


def baselines_for_trackable(db: Session, trackable_id: int) -> list[BaselineState]:
    rows = db.exec(
        select(Baseline)
        .where(Baseline.trackable_id == trackable_id)
        .order_by(Baseline.version)
    ).all()
    return [to_baseline_state(r) for r in rows]


def goal_for_trackable(db: Session, trackable: Trackable) -> Goal | None:
    milestone = db.get(Milestone, trackable.milestone_id)
    return db.get(Goal, milestone.goal_id) if milestone else None


def latest_capacity(db: Session, on_or_before: date) -> Capacity | None:
    return db.exec(
        select(Capacity)
        .where(Capacity.week_start <= on_or_before)
        .order_by(Capacity.week_start.desc())
    ).first()


def budgeted_sessions_per_week(db: Session, goal_id: int, today: date) -> int | None:
    """The goal's declared weekly session budget (§11).

    Returns None when capacity has not been declared. That is an honest
    "undetermined" -- feasibility must not assume a number here, because every
    downstream projection would inherit the invention (P2).
    """
    capacity = latest_capacity(db, today)
    if capacity is None:
        return None
    budget = db.exec(
        select(GoalBudget)
        .where(GoalBudget.capacity_id == capacity.id)
        .where(GoalBudget.goal_id == goal_id)
    ).first()
    return budget.budgeted_sessions if budget else None


def sessions_available_before(
    db: Session, goal_id: int, deadline: date | None, today: date
) -> int | None:
    """How many sessions exist between now and the deadline, at the declared budget.

    This is the denominator in §24.6. It is derived from a *declared* weekly
    budget rather than inferred from behaviour, because §11 makes capacity a
    declaration: every budget increase must visibly cost another goal.
    """
    if deadline is None:
        return None
    per_week = budgeted_sessions_per_week(db, goal_id, today)
    if per_week is None:
        return None
    days = (deadline - today).days
    if days <= 0:
        return 0
    return int(per_week * days / 7.0)


def committed_sessions_this_week(
    db: Session, today: date, *, trackable_id: int | None = None,
    milestone_id: int | None = None,
) -> WeeklyCommitment | None:
    capacity = db.exec(
        select(Capacity).where(Capacity.week_start == week_start(today))
    ).first()
    if capacity is None:
        return None
    stmt = select(WeeklyCommitment).where(WeeklyCommitment.capacity_id == capacity.id)
    if trackable_id is not None:
        stmt = stmt.where(WeeklyCommitment.trackable_id == trackable_id)
    else:
        stmt = stmt.where(WeeklyCommitment.milestone_id == milestone_id)
    return db.exec(stmt).first()


def sessions_used_this_week(db: Session, trackable_id: int, today: date) -> int:
    start = week_start(today)
    return (
        db.exec(
            select(func.count(WorkSession.id))
            .where(WorkSession.trackable_id == trackable_id)
            .where(func.date(WorkSession.started_at) >= start)
        ).one()
        or 0
    )


def days_since_last_session(db: Session, trackable_id: int, today: date) -> int | None:
    last = db.exec(
        select(func.max(WorkSession.started_at)).where(
            WorkSession.trackable_id == trackable_id
        )
    ).one()
    if last is None:
        return None
    return (today - last.date()).days
