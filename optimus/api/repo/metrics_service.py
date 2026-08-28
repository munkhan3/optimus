"""Orchestration: load state, call the pure engine, return one coherent view.

This is the module that performs §14's backward propagation. A single logged
session must move pace_hat, which moves the projection, which moves feasibility,
which moves goal health -- and it must do so because everything is derived from
the sessions table on read, not because something wrote an "on track" flag.

Nothing here computes a metric itself. If arithmetic appears in this file, it
belongs in optimus/metrics instead.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime
from typing import Any

from sqlmodel import Session, select

from optimus.metrics.calibration import calibration
from optimus.metrics.drift import drift_against_all
from optimus.metrics.feasibility import (
    feasibility,
    feasibility_from_session_budget,
    projection,
)
from optimus.metrics.health import goal_health
from optimus.metrics.pace import empirical_pace, required_pace
from optimus.metrics.progress import percent_complete, remaining_units
from optimus.metrics.stall import detect_stall
from optimus.metrics.types import PaceMode

from ..models import Goal, Milestone, ProgressCheckRow, Trackable, WorkSession
from ..settings import get_metrics_config
from . import loader


def _serialize(obj: Any) -> Any:
    """Flatten engine dataclasses to JSON-ready primitives.

    Dates become ISO strings here rather than at each call site, so the HTTP
    response and the assistant's tool output are byte-identical. If the two
    disagreed, the assistant could describe a number differently from the screen
    the user is looking at -- and both would then be suspect.
    """
    if obj is None:
        return None
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if hasattr(obj, "__dataclass_fields__"):
        return {k: _serialize(v) for k, v in asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialize(v) for v in obj]
    if hasattr(obj, "value"):  # Enum
        return obj.value
    return obj


def trackable_view(db: Session, trackable: Trackable, today: date) -> dict[str, Any]:
    """Every number the UI shows for one trackable, plus how each was derived."""
    config = get_metrics_config()
    goal = loader.goal_for_trackable(db, trackable)

    state = loader.to_trackable_state(trackable)
    if goal and goal.pace_mode == PaceMode.RESET_PERIOD.value:
        state = loader.TrackableState(**{**asdict(state), "pace_mode": PaceMode.RESET_PERIOD})

    # Pace pools across every trackable of this task_type (§24.3).
    pooled = loader.pooled_sessions(db, trackable.task_type)
    pace = empirical_pace(pooled, trackable.prior_pace, config)

    progress = percent_complete(state)
    remaining = remaining_units(state)

    baselines = loader.baselines_for_trackable(db, trackable.id or 0)
    used = loader.sessions_used_this_week(db, trackable.id or 0, today)
    current_drift, original_drift = drift_against_all(remaining, pace, baselines, used)

    # §24.2's denominator is fixed by commitment (D5). Without a commitment we
    # fall back to the baseline's planned sessions and say which we used, so the
    # number is never silently sourced.
    commitment = loader.committed_sessions_this_week(db, today, trackable_id=trackable.id)
    if commitment is not None:
        req = required_pace(remaining, commitment.committed_sessions, used, "weekly_commitment")
    elif baselines:
        req = required_pace(remaining, baselines[-1].planned_sessions, used, "baseline")
    else:
        req = None

    deadline = trackable.target_date or (goal.deadline if goal else None)
    available = (
        loader.sessions_available_before(db, goal.id, deadline, today) if goal else None
    )
    feas = feasibility(remaining, pace, available)

    per_week = (
        loader.budgeted_sessions_per_week(db, goal.id, today) if goal else None
    ) or 0
    proj = projection(remaining, pace, per_week, today, deadline)

    stale = loader.days_since_last_session(db, trackable.id or 0, today)
    health = goal_health(
        feas,
        current_drift,
        (deadline - today).days if deadline else None,
        stale,
        config,
    )

    return {
        "trackable_id": trackable.id,
        "title": trackable.title,
        "unit": trackable.unit,
        "task_type": trackable.task_type,
        "exploratory": trackable.exploratory,
        "total_units_source": trackable.total_units_source,
        "progress": _serialize(progress),
        "pace": _serialize(pace),
        "required_pace": _serialize(req),
        "drift": _serialize(current_drift),
        "drift_vs_original": _serialize(original_drift),
        "calibration": _serialize(calibration(pooled, config)),
        "feasibility": _serialize(feas),
        "projection": _serialize(proj),
        "health": _serialize(health),
        "days_since_last_session": stale,
        "sessions_used_this_week": used,
    }


def milestone_view(db: Session, milestone: Milestone, today: date) -> dict[str, Any]:
    """A milestone with no natural counter is still first-class (§10, §21).

    It is budgeted in sessions rather than units, and its feasibility asks the
    same question in the same units -- which is what lets §25.1 rank it against
    metered work without a correction factor (AC6).
    """
    config = get_metrics_config()
    goal = db.get(Goal, milestone.goal_id)

    used = _milestone_sessions_used(db, milestone.id or 0)
    planned = milestone.planned_sessions
    remaining_planned = max((planned or 0) - used, 0)

    deadline = milestone.deadline or (goal.deadline if goal else None)
    available = (
        loader.sessions_available_before(db, goal.id, deadline, today) if goal else None
    )
    feas = (
        feasibility_from_session_budget(remaining_planned, available)
        if planned is not None
        else feasibility_from_session_budget(0, available)
    )

    checks = [
        loader.to_progress_check(r)
        for r in db.exec(
            select(ProgressCheckRow)
            .where(ProgressCheckRow.milestone_id == milestone.id)
            .order_by(ProgressCheckRow.recorded_at)
        ).all()
    ]
    sessions = _milestone_sessions(db, milestone.id or 0)
    stall = detect_stall(checks, sessions, config)

    health = goal_health(
        feas, None, (deadline - today).days if deadline else None, None, config
    )

    return {
        "milestone_id": milestone.id,
        "title": milestone.title,
        "definition_of_done": milestone.definition_of_done,
        "dod_source": milestone.dod_source,
        "exploratory": milestone.exploratory,
        "planned_sessions": planned,
        "sessions_used": used,
        "feasibility": _serialize(feas),
        "health": _serialize(health),
        # D12: the slider's ONLY downstream use. Never a term in any number above.
        "stall": _serialize(stall),
    }


def _milestone_sessions(db: Session, milestone_id: int) -> list:
    rows = db.exec(
        select(WorkSession)
        .where(WorkSession.milestone_id == milestone_id)
        .order_by(WorkSession.started_at)
    ).all()
    return [loader.to_session_obs(r) for r in rows]


def _milestone_sessions_used(db: Session, milestone_id: int) -> int:
    return len(_milestone_sessions(db, milestone_id))
