"""Trackables: metered bodies of work, and the metric view over them."""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..db import get_session
from ..models import Baseline, Goal, Milestone, OpenGap, Trackable
from ..repo import metrics_service
from ..schemas import TrackableCreate
from ..settings import get_metrics_config

router = APIRouter(prefix="/api/trackables", tags=["trackables"])


def _today() -> date:
    return datetime.now(UTC).date()


@router.post("", status_code=status.HTTP_201_CREATED)
def create_trackable(body: TrackableCreate, db: Session = Depends(get_session)) -> dict:
    milestone = db.get(Milestone, body.milestone_id)
    if milestone is None:
        raise HTTPException(404, f"milestone {body.milestone_id} not found")

    trackable = Trackable(**body.model_dump())
    db.add(trackable)
    db.flush()

    # AC18 / D3: a model-estimated total_units must never be recorded silently.
    # The gap is written in the same transaction as the estimate, so the two
    # cannot come apart.
    gap: OpenGap | None = None
    if trackable.total_units_source == "model_estimated":
        goal = db.get(Goal, milestone.goal_id)
        stakes = goal.stakes if goal else 3
        gap = OpenGap(
            trackable_id=trackable.id,
            milestone_id=milestone.id,
            question=(
                f"How many {trackable.unit} is '{trackable.title}' really? "
                f"I estimated {trackable.total_units:g} but did not verify it."
            ),
            # §15.3: stakes x uncertainty. An unverified estimate is maximally
            # uncertain, so priority is carried by the stakes of its goal.
            priority=float(stakes),
        )
        db.add(gap)

    db.commit()
    db.refresh(trackable)
    return {
        "trackable": trackable.model_dump(),
        "open_gap_created": gap.id if gap else None,
    }


@router.get("")
def list_trackables(db: Session = Depends(get_session)) -> list[dict]:
    """Every trackable with its full metric view -- the M1 screen (§28)."""
    today = _today()
    rows = db.exec(select(Trackable).order_by(Trackable.created_at)).all()
    return [metrics_service.trackable_view(db, t, today) for t in rows]


@router.get("/{trackable_id}")
def get_trackable(trackable_id: int, db: Session = Depends(get_session)) -> dict:
    trackable = db.get(Trackable, trackable_id)
    if trackable is None:
        raise HTTPException(404, f"trackable {trackable_id} not found")
    return metrics_service.trackable_view(db, trackable, _today())


@router.get("/{trackable_id}/metrics")
def trackable_metrics(trackable_id: int, db: Session = Depends(get_session)) -> dict:
    return get_trackable(trackable_id, db)


@router.get("/{trackable_id}/baselines")
def list_baselines(trackable_id: int, db: Session = Depends(get_session)) -> dict:
    """§25.3: version 1 is returned alongside current, always (AC12)."""
    rows = db.exec(
        select(Baseline)
        .where(Baseline.trackable_id == trackable_id)
        .order_by(Baseline.version)
    ).all()
    if not rows:
        return {"original": None, "current": None, "history": []}
    return {
        "original": rows[0].model_dump(),
        "current": rows[-1].model_dump(),
        "history": [r.model_dump() for r in rows],
    }


@router.get("/{trackable_id}/session-minutes")
def default_session_minutes() -> dict:
    return {"minutes": get_metrics_config().session.minutes}
