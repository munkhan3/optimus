"""Trackables: metered bodies of work, and the metric view over them."""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..auth import get_user_session as get_session
from ..models import Baseline, Milestone, Trackable
from ..repo import metrics_service
from ..repo.write_rules import gap_for_estimated_units, stamp_completion
from ..schemas import TrackableCreate, TrackableUpdate
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

    # AC18 / D3: the gap is written in the same transaction as the estimate,
    # so the two cannot come apart. Shared with the intake path.
    gap = gap_for_estimated_units(db, trackable, milestone)

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
    rows = db.exec(select(Trackable).order_by(Trackable.created_at, Trackable.id)).all()
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


@router.patch("/{trackable_id}")
def update_trackable(
    trackable_id: int, body: TrackableUpdate, db: Session = Depends(get_session)
) -> dict:
    """Status was previously unwritable, the same gap milestones had.

    Scope is deliberately not editable here. Changing total_units is a
    rebaseline (§17) and has to record what was dropped and why -- routing it
    through a PATCH would be the silent drift that flow exists to prevent.
    """
    trackable = db.get(Trackable, trackable_id)
    if trackable is None:
        raise HTTPException(404, f"trackable {trackable_id} not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(trackable, field, value)
    stamp_completion(trackable)
    db.add(trackable)
    db.commit()
    db.refresh(trackable)
    return metrics_service.trackable_view(db, trackable, _today())
