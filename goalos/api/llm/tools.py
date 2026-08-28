"""The nine read-only tools of §26.

Every one of these reads stored or derived state. None of them writes. That is
the whole design (D10/P1): the database is the source of truth and the model is
a reasoning layer over it, which is what makes the model swappable and the
history permanent.

The tools return the SAME numbers the UI shows, computed by the same engine, so
the assistant cannot drift from what the user is looking at. If a tool
recomputed anything itself, it would eventually disagree with the screen -- and
the user would be right to stop trusting both.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlmodel import Session, select

from goalos.metrics.stall import detect_stall

from ..models import (
    Baseline,
    DailyPlan,
    Goal,
    Milestone,
    OpenGap,
    PlanItem,
    ProgressCheckRow,
    Trackable,
    WeeklyCommitment,
    WorkSession,
)
from ..repo import loader, metrics_service
from ..repo.loader import week_start
from ..settings import get_metrics_config

# Tool schemas, in §26's order. `strict` guarantees the arguments validate.
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "get_goal_state",
        "description": "The goal hierarchy with current metrics. Omit goal_id for all goals.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"goal_id": {"type": ["integer", "null"]}},
            "required": ["goal_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_pace",
        "description": (
            "pace_hat, its displayed interval, required pace, drift, and the "
            "projected completion range for one trackable."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"trackable_id": {"type": "integer"}},
            "required": ["trackable_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_feasibility",
        "description": (
            "Feasibility margin, sessions available before the deadline, and the "
            "infeasible flag for every trackable under a goal."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"goal_id": {"type": "integer"}},
            "required": ["goal_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_plan",
        "description": "The plan for a date, with each item's full score breakdown.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"plan_date": {"type": "string", "description": "ISO date"}},
            "required": ["plan_date"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_sessions",
        "description": "Session history, optionally filtered by trackable and start date.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "since": {"type": ["string", "null"], "description": "ISO date"},
                "trackable_id": {"type": ["integer", "null"]},
                "limit": {"type": ["integer", "null"]},
            },
            "required": ["since", "trackable_id", "limit"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_budget_status",
        "description": "Committed vs consumed sessions per goal for a week.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "week_start": {"type": ["string", "null"], "description": "ISO date (Monday)"}
            },
            "required": ["week_start"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_baselines",
        "description": (
            "Full rebaseline history for a trackable, including version 1 and the "
            "recorded resolution and rationale for each change."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"trackable_id": {"type": "integer"}},
            "required": ["trackable_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_progress_history",
        "description": (
            "The self-assessed progress series for a milestone plus its stall flag. "
            "This series is a review signal only -- it is not an input to any "
            "computed metric."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"milestone_id": {"type": "integer"}},
            "required": ["milestone_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_open_gaps",
        "description": "Unanswered interview questions, highest priority first.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    },
]


def _today() -> date:
    from datetime import UTC, datetime

    return datetime.now(UTC).date()


def dispatch(db: Session, name: str, args: dict[str, Any]) -> Any:
    """Execute one read-only tool. Unknown names are refused, not guessed at."""
    handler = _HANDLERS.get(name)
    if handler is None:
        return {"error": f"unknown tool {name!r}"}
    try:
        return handler(db, args)
    except Exception as exc:  # noqa: BLE001 -- returned to the model, not raised
        return {"error": f"{type(exc).__name__}: {exc}"}


def _get_goal_state(db: Session, args: dict) -> Any:
    goal_id = args.get("goal_id")
    stmt = select(Goal) if goal_id is None else select(Goal).where(Goal.id == goal_id)
    today = _today()
    out = []
    for goal in db.exec(stmt).all():
        milestones = db.exec(
            select(Milestone).where(Milestone.goal_id == goal.id)
        ).all()
        m_out = []
        for milestone in milestones:
            trackables = db.exec(
                select(Trackable).where(Trackable.milestone_id == milestone.id)
            ).all()
            m_out.append({
                **metrics_service.milestone_view(db, milestone, today),
                "trackables": [
                    metrics_service.trackable_view(db, t, today) for t in trackables
                ],
            })
        out.append({
            "goal_id": goal.id,
            "title": goal.title,
            "kind": goal.kind,
            "activation": goal.activation,
            "deadline": str(goal.deadline) if goal.deadline else None,
            "stakes": goal.stakes,
            "definition_of_done": goal.definition_of_done,
            "dod_source": goal.dod_source,
            "pace_mode": goal.pace_mode,
            "milestones": m_out,
        })
    return out


def _get_pace(db: Session, args: dict) -> Any:
    trackable = db.get(Trackable, args["trackable_id"])
    if trackable is None:
        return {"error": f"trackable {args['trackable_id']} not found"}
    view = metrics_service.trackable_view(db, trackable, _today())
    return {
        k: view[k]
        for k in ("trackable_id", "title", "unit", "pace", "required_pace",
                  "drift", "drift_vs_original", "projection", "calibration")
    }


def _get_feasibility(db: Session, args: dict) -> Any:
    goal = db.get(Goal, args["goal_id"])
    if goal is None:
        return {"error": f"goal {args['goal_id']} not found"}
    today = _today()
    rows = []
    for milestone in db.exec(select(Milestone).where(Milestone.goal_id == goal.id)).all():
        trackables = db.exec(
            select(Trackable).where(Trackable.milestone_id == milestone.id)
        ).all()
        if trackables:
            for t in trackables:
                view = metrics_service.trackable_view(db, t, today)
                rows.append({
                    "trackable_id": t.id, "title": t.title,
                    "feasibility": view["feasibility"], "health": view["health"],
                })
        else:
            view = metrics_service.milestone_view(db, milestone, today)
            rows.append({
                "milestone_id": milestone.id, "title": milestone.title,
                "feasibility": view["feasibility"], "health": view["health"],
            })
    return {
        "goal_id": goal.id, "title": goal.title,
        "deadline": str(goal.deadline) if goal.deadline else None,
        "items": rows,
    }


def _get_plan(db: Session, args: dict) -> Any:
    plan_date = date.fromisoformat(args["plan_date"])
    plan = db.exec(select(DailyPlan).where(DailyPlan.plan_date == plan_date)).first()
    if plan is None:
        return {"error": f"no plan generated for {plan_date}"}
    items = db.exec(
        select(PlanItem).where(PlanItem.daily_plan_id == plan.id).order_by(PlanItem.rank)
    ).all()
    return {
        "plan_date": str(plan.plan_date),
        "carried_shortfall": plan.carried_shortfall,
        "items": [
            {
                "rank": i.rank, "tier": i.tier, "score": i.score,
                "trackable_id": i.trackable_id, "milestone_id": i.milestone_id,
                "allocated_units": i.allocated_units,
                "user_action": i.user_action, "completed": i.completed,
                # P3: the breakdown is the answer to "why this?", so it travels.
                "score_breakdown": i.score_breakdown,
            }
            for i in items
        ],
    }


def _get_sessions(db: Session, args: dict) -> Any:
    stmt = select(WorkSession).order_by(WorkSession.started_at.desc())
    if args.get("trackable_id") is not None:
        stmt = stmt.where(WorkSession.trackable_id == args["trackable_id"])
    if args.get("since"):
        from datetime import datetime as dt

        stmt = stmt.where(
            WorkSession.started_at >= dt.combine(
                date.fromisoformat(args["since"]), dt.min.time()
            )
        )
    stmt = stmt.limit(min(int(args.get("limit") or 100), 500))
    return [
        {
            "id": s.id, "trackable_id": s.trackable_id, "milestone_id": s.milestone_id,
            "task_type": s.task_type, "started_at": str(s.started_at),
            "expected_output": s.expected_output, "actual_output": s.actual_output,
            "intent_met": s.intent_met, "interrupted": s.interrupted,
            "entered_retroactively": s.entered_retroactively,
            "actual_minutes": s.actual_minutes, "note": s.note,
        }
        for s in db.exec(stmt).all()
    ]


def _get_budget_status(db: Session, args: dict) -> Any:
    from ..models import Capacity, GoalBudget

    today = _today()
    start = (
        date.fromisoformat(args["week_start"]) if args.get("week_start")
        else week_start(today)
    )
    capacity = db.exec(select(Capacity).where(Capacity.week_start == start)).first()
    if capacity is None:
        return {"error": f"no capacity declared for the week of {start}"}

    rows = []
    for budget in db.exec(
        select(GoalBudget).where(GoalBudget.capacity_id == capacity.id)
    ).all():
        goal = db.get(Goal, budget.goal_id)
        consumed = 0
        for milestone in db.exec(
            select(Milestone).where(Milestone.goal_id == budget.goal_id)
        ).all():
            for t in db.exec(
                select(Trackable).where(Trackable.milestone_id == milestone.id)
            ).all():
                consumed += loader.sessions_used_this_week(db, t.id or 0, today)
        rows.append({
            "goal_id": budget.goal_id,
            "goal_title": goal.title if goal else None,
            "budgeted_sessions": budget.budgeted_sessions,
            "sessions_consumed": consumed,
            "remaining": budget.budgeted_sessions - consumed,
        })

    commitments = db.exec(
        select(WeeklyCommitment).where(WeeklyCommitment.capacity_id == capacity.id)
    ).all()
    return {
        "week_start": str(start),
        "available_hours": capacity.available_hours,
        "session_minutes": capacity.session_minutes,
        "goals": rows,
        "commitments": [
            {
                "trackable_id": c.trackable_id, "milestone_id": c.milestone_id,
                "committed_sessions": c.committed_sessions,
                "target_units": c.target_units, "frozen_score": c.score,
            }
            for c in commitments
        ],
    }


def _get_baselines(db: Session, args: dict) -> Any:
    rows = db.exec(
        select(Baseline)
        .where(Baseline.trackable_id == args["trackable_id"])
        .order_by(Baseline.version)
    ).all()
    if not rows:
        return {"trackable_id": args["trackable_id"], "history": []}
    return {
        "trackable_id": args["trackable_id"],
        # §25.3: v1 is called out explicitly so a summary cannot quietly drop it.
        "original": rows[0].model_dump(mode="json"),
        "current": rows[-1].model_dump(mode="json"),
        "history": [r.model_dump(mode="json") for r in rows],
    }


def _get_progress_history(db: Session, args: dict) -> Any:
    milestone = db.get(Milestone, args["milestone_id"])
    if milestone is None:
        return {"error": f"milestone {args['milestone_id']} not found"}
    checks = [
        loader.to_progress_check(r)
        for r in db.exec(
            select(ProgressCheckRow)
            .where(ProgressCheckRow.milestone_id == milestone.id)
            .order_by(ProgressCheckRow.recorded_at)
        ).all()
    ]
    sessions = [
        loader.to_session_obs(r)
        for r in db.exec(
            select(WorkSession)
            .where(WorkSession.milestone_id == milestone.id)
            .order_by(WorkSession.started_at)
        ).all()
    ]
    report = detect_stall(checks, sessions, get_metrics_config())
    return {
        "milestone_id": milestone.id,
        "title": milestone.title,
        "series": list(report.series),
        "latest_pct": report.latest_pct,
        "sessions_since_movement": report.sessions_since_movement,
        "stalled": report.stalled,
        "note": (
            "Self-assessed progress is a review signal only. It is not an input to "
            "pace, feasibility, health, projection, or any score."
        ),
    }


def _get_open_gaps(db: Session, args: dict) -> Any:
    rows = db.exec(
        select(OpenGap).where(OpenGap.status == "open").order_by(OpenGap.priority.desc())
    ).all()
    return [
        {
            "id": g.id, "question": g.question, "priority": g.priority,
            "goal_id": g.goal_id, "milestone_id": g.milestone_id,
            "trackable_id": g.trackable_id,
        }
        for g in rows
    ]


_HANDLERS = {
    "get_goal_state": _get_goal_state,
    "get_pace": _get_pace,
    "get_feasibility": _get_feasibility,
    "get_plan": _get_plan,
    "get_sessions": _get_sessions,
    "get_budget_status": _get_budget_status,
    "get_baselines": _get_baselines,
    "get_progress_history": _get_progress_history,
    "get_open_gaps": _get_open_gaps,
}

assert {t["name"] for t in TOOL_SCHEMAS} == set(_HANDLERS), (
    "every declared tool needs a handler and vice versa"
)
