"""Capacity and budgets (§11).

Time is the scarce resource and goals are claims on it. Capacity is *declared*,
not inferred -- how many focus sessions per week actually exist after
coursework, work, sleep, and life.

The important property is that the portfolio is explicit: every budget increase
is visibly taken from somewhere else. There is no free reallocation and the
system must never present one, so allocating returns the totals rather than
quietly accepting an over-commitment.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..db import get_session
from ..models import Capacity, Goal, GoalBudget
from ..repo.loader import week_start
from ..schemas import BudgetSet, CapacityCreate
from ..settings import get_metrics_config

router = APIRouter(prefix="/api/capacity", tags=["capacity"])


def _today() -> date:
    return datetime.now(UTC).date()


def _sessions_available(capacity: Capacity) -> int:
    return int(capacity.available_hours * 60 / capacity.session_minutes)


def _summary(db: Session, capacity: Capacity) -> dict:
    budgets = db.exec(
        select(GoalBudget).where(GoalBudget.capacity_id == capacity.id)
    ).all()
    total = _sessions_available(capacity)
    allocated = sum(b.budgeted_sessions for b in budgets)
    rows = []
    for b in budgets:
        goal = db.get(Goal, b.goal_id)
        rows.append({
            "goal_id": b.goal_id,
            "goal_title": goal.title if goal else None,
            "stakes": goal.stakes if goal else None,
            "budgeted_sessions": b.budgeted_sessions,
            "share": (b.budgeted_sessions / total) if total else None,
        })
    return {
        "capacity": capacity.model_dump(),
        "sessions_available": total,
        "sessions_allocated": allocated,
        "sessions_unallocated": total - allocated,
        # §11: an over-committed week is surfaced, never silently accepted.
        "over_committed": allocated > total,
        "budgets": sorted(rows, key=lambda r: -r["budgeted_sessions"]),
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def declare_capacity(body: CapacityCreate, db: Session = Depends(get_session)) -> dict:
    existing = db.exec(
        select(Capacity).where(Capacity.week_start == body.week_start)
    ).first()
    if existing is not None:
        raise HTTPException(409, f"capacity for week {body.week_start} already declared")

    row = Capacity(
        week_start=body.week_start,
        available_hours=body.available_hours,
        session_minutes=body.session_minutes or get_metrics_config().session.minutes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _summary(db, row)


@router.get("/current")
def current_capacity(db: Session = Depends(get_session)) -> dict | None:
    row = db.exec(
        select(Capacity).where(Capacity.week_start == week_start(_today()))
    ).first()
    return _summary(db, row) if row else None


@router.put("/{capacity_id}/budgets")
def set_budget(
    capacity_id: int, body: BudgetSet, db: Session = Depends(get_session)
) -> dict:
    """Set one goal's weekly session budget.

    The response always carries the whole portfolio, because a budget is only
    meaningful relative to what else is claiming the same hours (§11).
    """
    capacity = db.get(Capacity, capacity_id)
    if capacity is None:
        raise HTTPException(404, f"capacity {capacity_id} not found")
    goal = db.get(Goal, body.goal_id)
    if goal is None:
        raise HTTPException(404, f"goal {body.goal_id} not found")
    # §12: parked goals compete for nothing.
    if goal.activation != "active":
        raise HTTPException(
            422,
            f"'{goal.title}' is parked. A parked goal competes for nothing -- "
            "activate it (which needs a deadline) before budgeting time to it.",
        )

    existing = db.exec(
        select(GoalBudget)
        .where(GoalBudget.capacity_id == capacity_id)
        .where(GoalBudget.goal_id == body.goal_id)
    ).first()
    if existing is None:
        db.add(GoalBudget(
            capacity_id=capacity_id, goal_id=body.goal_id,
            budgeted_sessions=body.budgeted_sessions,
        ))
    else:
        existing.budgeted_sessions = body.budgeted_sessions
        db.add(existing)
    db.commit()
    return _summary(db, capacity)


@router.get("/{capacity_id}")
def get_capacity(capacity_id: int, db: Session = Depends(get_session)) -> dict:
    capacity = db.get(Capacity, capacity_id)
    if capacity is None:
        raise HTTPException(404, f"capacity {capacity_id} not found")
    return _summary(db, capacity)
