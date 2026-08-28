"""Baselines and rebaselining (§17, §25.2, §25.3).

The system forces an explicit choice among exactly four options and records
which one was taken and why. It must never default to moving the deadline:
silent extension is how a goal drifts for months without ever formally failing,
and preventing that is a core purpose of the product.

Version 1 is retained forever and returned alongside the current version
(AC12). Three rebaselines in, the user must still be able to see that this
began as ten sessions targeting October.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from goalos.metrics.rebaseline import FOUR_OPTIONS

from ..db import get_session
from ..models import Baseline
from ..schemas import BaselineCreate, RebaselineRequest

router = APIRouter(prefix="/api/baselines", tags=["baselines"])


def _next_version(db: Session, trackable_id: int | None, milestone_id: int | None) -> int:
    stmt = select(Baseline)
    stmt = (
        stmt.where(Baseline.trackable_id == trackable_id)
        if trackable_id is not None
        else stmt.where(Baseline.milestone_id == milestone_id)
    )
    existing = db.exec(stmt.order_by(Baseline.version.desc())).first()
    return (existing.version + 1) if existing else 1


@router.post("", status_code=status.HTTP_201_CREATED)
def create_baseline(body: BaselineCreate, db: Session = Depends(get_session)) -> dict:
    """Version 1: the original plan. Carries no resolution -- nothing was changed yet."""
    if (body.trackable_id is None) == (body.milestone_id is None):
        raise HTTPException(422, "a baseline attaches to exactly one trackable or milestone")

    version = _next_version(db, body.trackable_id, body.milestone_id)
    if version != 1:
        raise HTTPException(
            409,
            f"a baseline already exists (v{version - 1}); "
            "changing the plan is a rebaseline and needs a resolution and a reason.",
        )

    row = Baseline(**body.model_dump(), version=1)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.post("/rebaseline", status_code=status.HTTP_201_CREATED)
def rebaseline(body: RebaselineRequest, trackable_id: int | None = None,
               milestone_id: int | None = None,
               db: Session = Depends(get_session)) -> dict:
    """§17. One of exactly four options, with a mandatory rationale."""
    if body.resolution not in FOUR_OPTIONS:
        raise HTTPException(
            422, f"resolution must be one of {FOUR_OPTIONS}, got {body.resolution!r}"
        )
    if (trackable_id is None) == (milestone_id is None):
        raise HTTPException(422, "rebaseline exactly one trackable or milestone")

    version = _next_version(db, trackable_id, milestone_id)
    if version == 1:
        raise HTTPException(409, "nothing to rebaseline: create the original baseline first")

    row = Baseline(
        trackable_id=trackable_id,
        milestone_id=milestone_id,
        version=version,
        planned_sessions=body.planned_sessions,
        scope_units=body.scope_units,
        target_date=body.target_date,
        resolution=body.resolution,
        rationale=body.rationale,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    history = db.exec(
        select(Baseline)
        .where(
            Baseline.trackable_id == trackable_id
            if trackable_id is not None
            else Baseline.milestone_id == milestone_id
        )
        .order_by(Baseline.version)
    ).all()
    return {
        "current": row.model_dump(),
        # AC12: v1 comes back with every rebaseline so the UI cannot fail to show it.
        "original": history[0].model_dump(),
        "history": [h.model_dump() for h in history],
    }


@router.get("/options")
def options() -> dict:
    """The four options, in order. move_deadline is never first (§17)."""
    return {
        "options": list(FOUR_OPTIONS),
        "default": None,  # deliberately no default -- the user decides (D11)
    }
