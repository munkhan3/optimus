"""Weekly commitment and the daily plan (§25, D9).

The weekly commitment is the load-bearing unit (§16). Ranking happens weekly;
the daily plan does not re-rank -- it redistributes what remains of the week
across the days that remain, adjusted for shortfall.

This is deliberate. Re-scoring daily produces thrash: logging a session drops
that item's deficit, something else jumps to the top, the plan feels arbitrary,
and the user stops trusting it. Stability is worth more than daily optimality.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..auth import get_user_session as get_session
from ..models import (
    Capacity,
    DailyPlan,
    Milestone,
    PlanItem,
    Trackable,
    WeeklyCommitment,
)
from ..repo import planning_service
from ..repo.loader import week_start
from ..schemas import CommitmentSet, PlanItemAction
from ..settings import get_metrics_config

router = APIRouter(prefix="/api/planning", tags=["planning"])

WORKING_DAYS_IN_WEEK = 7  # every day is a candidate; capacity decides the real load


def _today() -> date:
    return datetime.now(UTC).date()


def _capacity_for(db: Session, day: date) -> Capacity:
    capacity = db.exec(
        select(Capacity).where(Capacity.week_start == week_start(day))
    ).first()
    if capacity is None:
        raise HTTPException(
            409,
            f"no capacity declared for the week of {week_start(day)}. "
            "Capacity is declared, not inferred -- budgets have nothing to divide "
            "until you say how many hours actually exist.",
        )
    return capacity


@router.get("/ranking")
def ranking(db: Session = Depends(get_session)) -> list[dict]:
    """§25.1. Preview the week's ranking without committing to it."""
    config = get_metrics_config()
    today = _today()
    scored = planning_service.weekly_ranking(db, today, config)
    inputs = {
        (i.trackable_id, i.milestone_id): i
        for i in planning_service.candidates(db, today, config)
    }
    out = []
    for position, item in enumerate(scored, start=1):
        source = inputs.get((item.trackable_id, item.milestone_id))
        out.append({
            "rank": position,
            "trackable_id": item.trackable_id,
            "milestone_id": item.milestone_id,
            "label": source.label if source else "",
            "score": item.score,
            # P3: the breakdown travels with the score, always.
            "score_breakdown": item.breakdown(),
            "explanation": _explain(item),
        })
    return out


def _explain(item) -> str:
    """§25.6: the primary reason is generated from score_breakdown, never by a model.

    The assistant may elaborate on top of this line, but it never replaces it --
    a user who cannot interrogate a recommendation cannot calibrate trust in it.
    """
    ranked = sorted(item.components, key=lambda c: -abs(c.contribution))
    lead = [c for c in ranked if abs(c.contribution) > 1e-9][:2]
    if not lead:
        return "Nothing is pressing on this yet."
    phrases = {
        "feasibility_pressure": lambda c: f"feasibility margin is down to {c.raw:.1f} sessions",
        "urgency": lambda c: f"due in {int(c.raw)} days",
        "stakes": lambda c: f"stakes {int(c.raw)}/5",
        "unblocking": lambda c: "it unblocks other work",
        "neglect": lambda c: (
            "never worked on" if c.raw is None else f"untouched for {int(c.raw)} days"
        ),
        "effort_penalty": lambda c: f"costs about {int(c.raw)} minutes",
    }
    parts = [phrases[c.name](c) for c in lead if c.name in phrases and c.raw is not None]
    return "; ".join(parts).capitalize() + "." if parts else "Ranked on stakes alone."


@router.post("/commit", status_code=status.HTTP_201_CREATED)
def commit_week(
    items: list[CommitmentSet], db: Session = Depends(get_session)
) -> list[dict]:
    """D5/D9. Committing fixes the pace denominator and freezes the week's scores.

    The score computed here is stored and reused unchanged by every day of the
    week. Nothing downstream recomputes it.
    """
    config = get_metrics_config()
    today = _today()
    capacity = _capacity_for(db, today)

    scored = {
        (s.trackable_id, s.milestone_id): s
        for s in planning_service.weekly_ranking(db, today, config)
    }

    written = []
    for body in items:
        if (body.trackable_id is None) == (body.milestone_id is None):
            raise HTTPException(422, "commit exactly one trackable or milestone per item")

        existing = db.exec(
            select(WeeklyCommitment)
            .where(WeeklyCommitment.capacity_id == capacity.id)
            .where(
                WeeklyCommitment.trackable_id == body.trackable_id
                if body.trackable_id is not None
                else WeeklyCommitment.milestone_id == body.milestone_id
            )
        ).first()

        item = scored.get((body.trackable_id, body.milestone_id))
        row = existing or WeeklyCommitment(
            capacity_id=capacity.id,
            trackable_id=body.trackable_id,
            milestone_id=body.milestone_id,
            committed_sessions=body.committed_sessions,
        )
        row.committed_sessions = body.committed_sessions
        row.target_units = body.target_units
        row.score = item.score if item else None
        row.score_breakdown = item.breakdown() if item else None
        db.add(row)
        written.append(row)

    db.commit()
    # Refresh before dumping: a committed row is expired, and model_dump() on an
    # expired instance silently omits the fields it has not reloaded.
    for row in written:
        db.refresh(row)
    return [r.model_dump() for r in written]


@router.get("/week")
def current_week(db: Session = Depends(get_session)) -> dict:
    capacity = _capacity_for(db, _today())
    rows = db.exec(
        select(WeeklyCommitment).where(WeeklyCommitment.capacity_id == capacity.id)
    ).all()
    return {
        "week_start": capacity.week_start,
        "commitments": [r.model_dump() for r in rows],
    }


@router.post("/day", status_code=status.HTTP_201_CREATED)
def generate_day(
    plan_date: date | None = None, db: Session = Depends(get_session)
) -> dict:
    """§25.5. Redistribution, not re-ranking.

    Scores come from the weekly commitment untouched, which is what makes two
    consecutive unchanged days produce overlapping plans (AC10).
    """
    config = get_metrics_config()
    day = plan_date or _today()
    capacity = _capacity_for(db, day)

    commitments = db.exec(
        select(WeeklyCommitment)
        .where(WeeklyCommitment.capacity_id == capacity.id)
        .where(WeeklyCommitment.committed_sessions > 0)
    ).all()
    if not commitments:
        raise HTTPException(409, "nothing committed for this week yet")

    existing = db.exec(select(DailyPlan).where(DailyPlan.plan_date == day)).first()
    if existing is not None:
        # Regenerating a day replaces its items; the plan row and its date persist.
        for stale in db.exec(
            select(PlanItem).where(PlanItem.daily_plan_id == existing.id)
        ).all():
            db.delete(stale)
        plan = existing
        plan.generated_at = datetime.now(UTC)
    else:
        plan = DailyPlan(
            plan_date=day,
            capacity_minutes=int(capacity.available_hours * 60 / 7),
        )
        db.add(plan)
        db.flush()

    days_remaining = max(WORKING_DAYS_IN_WEEK - day.weekday(), 1)

    # Ordered by the FROZEN weekly score. No re-ranking (D9).
    ordered = sorted(commitments, key=lambda c: -(c.score or 0.0))

    items, capped_any, shortfall = [], False, 0.0
    for position, commitment in enumerate(ordered, start=1):
        alloc = planning_service.day_allocation(
            db, commitment, day, config, WORKING_DAYS_IN_WEEK, days_remaining
        )
        capped_any = capped_any or alloc["capped"]
        shortfall += max(alloc["remaining"], 0.0)

        deadline_risk = _at_deadline_risk(db, commitment, day)
        tier = _tier(commitment.score or 0.0, config, deadline_risk, config.session.minutes)

        item = PlanItem(
            daily_plan_id=plan.id,
            trackable_id=commitment.trackable_id,
            milestone_id=commitment.milestone_id,
            tier=tier,
            score=commitment.score or 0.0,
            # AC13: never empty. Carries the frozen weekly breakdown plus the
            # arithmetic that produced today's number.
            score_breakdown={
                **(commitment.score_breakdown or {"score": 0.0, "components": []}),
                "daily_allocation": alloc,
                "frozen_from": "weekly_commitment",
            },
            allocated_units=alloc["per_day"],
            rank=position,
        )
        db.add(item)
        items.append(item)

    plan.carried_shortfall = shortfall
    db.add(plan)
    db.commit()
    db.refresh(plan)
    for item in items:
        db.refresh(item)

    return {
        "plan": plan.model_dump(),
        "items": [i.model_dump() for i in items],
        # D9: if the cap bound anywhere, the week does not fit. Say so here
        # rather than issuing a day the user will not complete.
        "catch_up_cap_binding": capped_any,
        "rebaseline_suggested": capped_any,
    }


def _tier(score: float, config, at_risk: bool, est_minutes: int) -> str:
    from optimus.metrics.redistribute import assign_tier
    from optimus.metrics.types import ScoredItem

    return assign_tier(ScoredItem(score, ()), config, at_risk, est_minutes)


def _at_deadline_risk(db: Session, commitment: WeeklyCommitment, day: date) -> bool:
    """Tier A is deadline risk, which means infeasible or nearly so."""
    breakdown = commitment.score_breakdown or {}
    for component in breakdown.get("components", []):
        if component.get("name") == "feasibility_pressure":
            return float(component.get("normalized") or 0) >= 0.999
    return False


@router.get("/day/{plan_date}")
def get_day(plan_date: date, db: Session = Depends(get_session)) -> dict:
    plan = db.exec(select(DailyPlan).where(DailyPlan.plan_date == plan_date)).first()
    if plan is None:
        raise HTTPException(404, f"no plan generated for {plan_date}")
    items = db.exec(
        select(PlanItem).where(PlanItem.daily_plan_id == plan.id).order_by(PlanItem.rank)
    ).all()
    enriched = []
    for item in items:
        label = None
        if item.trackable_id:
            t = db.get(Trackable, item.trackable_id)
            label = t.title if t else None
        elif item.milestone_id:
            m = db.get(Milestone, item.milestone_id)
            label = m.title if m else None
        enriched.append({**item.model_dump(), "label": label})
    return {"plan": plan.model_dump(), "items": enriched}


@router.patch("/plan-items/{item_id}")
def record_action(
    item_id: int, body: PlanItemAction, db: Session = Depends(get_session)
) -> dict:
    """§18: accept / modify / reject / defer, recorded.

    Revealed preference is the only real signal about the user's utility
    function, and it is what v2's learning layer trains on (§32).
    """
    item = db.get(PlanItem, item_id)
    if item is None:
        raise HTTPException(404, f"plan item {item_id} not found")
    if body.user_action not in ("accepted", "modified", "rejected", "deferred"):
        raise HTTPException(422, "user_action must be accepted|modified|rejected|deferred")
    item.user_action = body.user_action
    if body.completed is not None:
        item.completed = body.completed
    db.add(item)
    db.commit()
    db.refresh(item)
    return item.model_dump()
