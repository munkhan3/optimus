"""The progress dashboard (§19, in scope for v0 and never built until now).

One endpoint per widget family rather than one bundled payload. A dashboard is
a set of independent questions, and bundling them would make the cheapest
widget pay the cost of the most expensive one on every refresh.

Nothing here computes a metric. Every number comes from repo/dashboard_service,
which in turn defers to metrics_service for anything the rest of the app
already shows -- so the dashboard and the trackable list cannot disagree.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from ..auth import get_user_session as get_session
from ..models import DashboardLayout
from ..repo import dashboard_service, metrics_service
from ..schemas import LayoutSet

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

DEFAULT_NAME = "Overview"

# What a brand-new account sees. Chosen to answer the questions §11 and §24.6
# say matter most -- what is at risk, and what actually got produced -- rather
# than to fill the grid.
DEFAULT_WIDGETS = [
    {"i": "w-activity", "kind": "commitment_grid", "x": 0, "y": 0, "w": 8, "h": 4, "config": {}},
    {"i": "w-feasibility", "kind": "feasibility_margin", "x": 8, "y": 0, "w": 4, "h": 4,
     "config": {}},
    {"i": "w-progress", "kind": "goal_progress", "x": 0, "y": 4, "w": 6, "h": 4, "config": {}},
    {"i": "w-output", "kind": "output_per_session", "x": 6, "y": 4, "w": 6, "h": 4,
     "config": {}},
    {"i": "w-roadmap", "kind": "roadmap_compact", "x": 0, "y": 8, "w": 12, "h": 4, "config": {}},
]


def _today() -> date:
    return datetime.now(UTC).date()


def _tz(tz: str) -> str:
    try:
        return dashboard_service.validate_tz(tz)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# ---------------------------------------------------------------------- layout


@router.get("/layout")
def get_layout(db: Session = Depends(get_session)) -> dict:
    """Seeds a default arrangement on first read rather than returning empty.

    An empty dashboard is indistinguishable from a broken one, and a first-run
    user has no way to know which they are looking at.
    """
    row = db.exec(select(DashboardLayout).where(DashboardLayout.name == DEFAULT_NAME)).first()
    if row is None:
        row = DashboardLayout(name=DEFAULT_NAME, widgets=DEFAULT_WIDGETS)
        db.add(row)
        db.commit()
        db.refresh(row)
    return {"name": row.name, "widgets": row.widgets, "updated_at": row.updated_at}


@router.put("/layout")
def set_layout(body: LayoutSet, db: Session = Depends(get_session)) -> dict:
    """Replaces the arrangement wholesale.

    Widget ids must be unique within a layout: react-grid-layout keys its
    positions by id, so a duplicate silently makes one widget un-draggable
    rather than failing visibly.
    """
    ids = [w.i for w in body.widgets]
    if len(ids) != len(set(ids)):
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        raise HTTPException(422, f"Duplicate widget ids in layout: {duplicates}")

    row = db.exec(select(DashboardLayout).where(DashboardLayout.name == DEFAULT_NAME)).first()
    if row is None:
        row = DashboardLayout(name=DEFAULT_NAME)
    row.widgets = [w.model_dump() for w in body.widgets]
    row.updated_at = datetime.now(UTC)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"name": row.name, "widgets": row.widgets, "updated_at": row.updated_at}


# ----------------------------------------------------------------------- data


@router.get("/activity")
def activity(
    tz: str = "UTC",
    weeks: int = Query(default=26, ge=1, le=dashboard_service.MAX_WEEKS),
    goal_id: int | None = None,
    trackable_id: int | None = None,
    db: Session = Depends(get_session),
) -> dict:
    return dashboard_service.activity(
        db, today=_today(), tz=_tz(tz), weeks=weeks,
        goal_id=goal_id, trackable_id=trackable_id,
    )


@router.get("/throughput")
def throughput(
    tz: str = "UTC",
    weeks: int = Query(default=12, ge=1, le=dashboard_service.MAX_WEEKS),
    task_type: str | None = None,
    db: Session = Depends(get_session),
) -> dict:
    return dashboard_service.throughput(
        db, today=_today(), tz=_tz(tz), weeks=weeks, task_type=task_type
    )


@router.get("/portfolio")
def portfolio(db: Session = Depends(get_session)) -> dict:
    return dashboard_service.portfolio(db, today=_today())


@router.get("/calibration")
def calibration(db: Session = Depends(get_session)) -> dict:
    """§24.5, with the timed and retroactive distributions kept apart (D13)."""
    return {"by_task_type": metrics_service.calibration_by_task_type(db)}


@router.get("/roadmap")
def roadmap(db: Session = Depends(get_session)) -> dict:
    return dashboard_service.roadmap(db, today=_today())
