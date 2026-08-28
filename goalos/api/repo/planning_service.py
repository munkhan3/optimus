"""Weekly ranking and daily redistribution (§25).

The division of labour matters and is easy to get wrong:

  WEEKLY   ranking runs once, over every candidate under an active goal, and
           the resulting score is frozen onto the commitment.
  DAILY    redistribution is pure arithmetic over those frozen scores. It does
           not re-rank. Re-scoring daily produces thrash -- logging a session
           drops that item's deficit, something else jumps to the top, the plan
           feels arbitrary, and the user stops trusting it (§16).

Parked goals are excluded everywhere: they compete for nothing (§12).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlmodel import Session, select

from goalos.metrics.config import MetricsConfig
from goalos.metrics.feasibility import feasibility, feasibility_from_session_budget
from goalos.metrics.pace import empirical_pace
from goalos.metrics.progress import remaining_units
from goalos.metrics.redistribute import assign_tier, redistribute
from goalos.metrics.scoring import rank
from goalos.metrics.types import ScoredItem, ScoreInputs

from ..models import Goal, Milestone, Task, Trackable
from . import loader


def _days_to(deadline: date | None, today: date) -> int | None:
    return None if deadline is None else (deadline - today).days


def _blocks_something(db: Session, *, milestone_id: int | None) -> bool:
    if milestone_id is None:
        return False
    return (
        db.exec(select(Milestone).where(Milestone.blocked_by == milestone_id)).first()
        is not None
    )


def candidates(db: Session, today: date, config: MetricsConfig) -> list[ScoreInputs]:
    """Everything competing for time this week.

    Metered trackables and counter-less milestones arrive in identical shape.
    That is what lets §25.1 rank them on the same terms rather than needing a
    correction factor for work that has no natural counter (AC6).
    """
    out: list[ScoreInputs] = []
    active_goals = {
        g.id: g
        for g in db.exec(select(Goal).where(Goal.activation == "active")).all()
    }
    if not active_goals:
        return out

    milestones = db.exec(
        select(Milestone).where(Milestone.goal_id.in_(active_goals.keys()))
    ).all()
    metered_milestone_ids = set()

    for trackable in db.exec(select(Trackable)).all():
        milestone = db.get(Milestone, trackable.milestone_id)
        if milestone is None or milestone.goal_id not in active_goals:
            continue
        if trackable.status in ("done", "abandoned"):
            continue
        metered_milestone_ids.add(milestone.id)
        goal = active_goals[milestone.goal_id]

        state = loader.to_trackable_state(trackable)
        pace = empirical_pace(
            loader.pooled_sessions(db, trackable.task_type), trackable.prior_pace, config
        )
        deadline = trackable.target_date or milestone.deadline or goal.deadline
        available = loader.sessions_available_before(db, goal.id, deadline, today)
        feas = feasibility(remaining_units(state), pace, available)

        est = db.exec(
            select(Task).where(Task.trackable_id == trackable.id).where(Task.status == "open")
        ).first()

        out.append(
            ScoreInputs(
                stakes=goal.stakes,
                trackable_id=trackable.id,
                feasibility_margin_sessions=feas.margin_sessions,
                days_to_deadline=_days_to(deadline, today),
                unblocks_something=_blocks_something(db, milestone_id=milestone.id),
                days_since_last_session=loader.days_since_last_session(
                    db, trackable.id or 0, today
                ),
                est_minutes=(est.est_minutes if est else config.session.minutes),
                label=trackable.title,
            )
        )

    # §10: a milestone whose definition of done has no natural counter has no
    # trackable. It is budgeted in sessions and must still be rankable.
    for milestone in milestones:
        if milestone.id in metered_milestone_ids:
            continue
        if milestone.status in ("done", "abandoned"):
            continue
        goal = active_goals[milestone.goal_id]
        deadline = milestone.deadline or goal.deadline
        available = loader.sessions_available_before(db, goal.id, deadline, today)
        used = len(loader.pooled_sessions(db, "exploratory")) if milestone.exploratory else 0
        feas = feasibility_from_session_budget(
            max((milestone.planned_sessions or 0) - used, 0), available
        )
        out.append(
            ScoreInputs(
                stakes=goal.stakes,
                milestone_id=milestone.id,
                feasibility_margin_sessions=feas.margin_sessions,
                days_to_deadline=_days_to(deadline, today),
                unblocks_something=_blocks_something(db, milestone_id=milestone.id),
                days_since_last_session=None,
                est_minutes=config.session.minutes,
                label=milestone.title,
            )
        )

    return out


def weekly_ranking(db: Session, today: date, config: MetricsConfig) -> list[ScoredItem]:
    """§25.1. Run once per week; the result is frozen onto the commitments."""
    return rank(candidates(db, today, config), config)


def day_allocation(
    db: Session,
    commitment,
    today: date,
    config: MetricsConfig,
    working_days_in_week: int,
    working_days_remaining: int,
) -> dict[str, Any]:
    """§25.5. Arithmetic only -- the frozen weekly score is never touched.

    Metered work redistributes in units; session-budgeted work redistributes in
    sessions, because for work with no natural counter the session IS the unit
    (§10). Both go through the same capped arithmetic, so the "this week does
    not fit" signal means the same thing either way.
    """
    if commitment.trackable_id is not None and commitment.target_units is not None:
        committed = commitment.target_units
        completed = _units_this_week(db, commitment.trackable_id, today)
        unit = "units"
    elif commitment.trackable_id is not None:
        committed = float(commitment.committed_sessions)
        completed = float(loader.sessions_used_this_week(db, commitment.trackable_id, today))
        unit = "sessions"
    else:
        committed = float(commitment.committed_sessions)
        completed = float(_milestone_sessions_this_week(db, commitment.milestone_id, today))
        unit = "sessions"

    alloc = redistribute(
        committed, completed, working_days_remaining, working_days_in_week, config
    )
    return {
        "unit": unit,
        "per_day": alloc.per_day_units,
        # D9: when the cap binds the week does not fit. That is a rebaseline
        # signal, not an instruction to attempt a heroic day.
        "capped": alloc.capped,
        "cap_value": alloc.cap_value,
        "baseline_daily": alloc.baseline_daily,
        "remaining": alloc.remaining_units,
    }


def _milestone_sessions_this_week(db: Session, milestone_id: int | None, today: date) -> int:
    from sqlalchemy import func

    from ..models import WorkSession

    if milestone_id is None:
        return 0
    start = loader.week_start(today)
    return int(
        db.exec(
            select(func.count(WorkSession.id))
            .where(WorkSession.milestone_id == milestone_id)
            .where(func.date(WorkSession.started_at) >= start)
        ).one()
        or 0
    )


def _units_this_week(db: Session, trackable_id: int, today: date) -> float:
    from sqlalchemy import func

    from ..models import WorkSession

    start = loader.week_start(today)
    total = db.exec(
        select(func.sum(WorkSession.actual_output))
        .where(WorkSession.trackable_id == trackable_id)
        .where(func.date(WorkSession.started_at) >= start)
    ).one()
    return float(total or 0.0)


def tier_for(item: ScoredItem, config: MetricsConfig, at_risk: bool, est_minutes: int | None) -> str:
    return assign_tier(item, config, at_risk, est_minutes)
