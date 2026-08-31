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

from optimus.metrics.productivity import series_stability
from optimus.metrics.rebaseline import FOUR_OPTIONS

from ..auth import get_user_session as get_session
from ..models import Baseline, Trackable, WorkSession
from ..repo import loader
from ..schemas import BaselineCreate, MetricSwitch, RebaselineRequest
from ..settings import get_metrics_config

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


def _current_unit(db: Session, trackable_id: int | None) -> str | None:
    if trackable_id is None:
        return None
    trackable = db.get(Trackable, trackable_id)
    return trackable.unit if trackable else None


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
        # Stamped so a later metric switch is legible in history: without it,
        # v2's "210" beside v1's "380" reads as a scope cut rather than the same
        # work counted differently.
        unit=_current_unit(db, trackable_id),
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


@router.post("/switch-metric", status_code=status.HTTP_201_CREATED)
def switch_metric(
    body: MetricSwitch,
    trackable_id: int,
    db: Session = Depends(get_session),
) -> dict:
    """Promote the second axis to primary.

    This is the fifth resolution, and the reason it is not one of §17's four:
    those are answers to "reality diverged from the plan, what gives?", whereas
    this is a statement that the plan was being counted in the wrong currency
    all along. Folding it into `cut_scope` would write a lie into permanent
    history -- the scope did not shrink, the ruler changed.

    Refused unless the second axis has actually been measured. The proposal that
    leads here comes from `series_stability`, which compares the spread of the
    two series over the SAME sessions; promoting a unit with no observations
    behind it would replace a measured plan with an estimated one.

    Sessions carrying no secondary count are not back-converted. They simply do
    not contribute to the new series, so `n` restarts honestly rather than being
    padded with the old series multiplied by a constant -- which would produce a
    confident-looking interval built from no new information.
    """
    trackable = db.get(Trackable, trackable_id)
    if trackable is None:
        raise HTTPException(404, f"trackable {trackable_id} not found")
    if not trackable.secondary_unit:
        raise HTTPException(422, "this trackable has no second axis to promote")

    config = get_metrics_config()
    sessions = loader.trackable_sessions(db, trackable_id)
    stability = series_stability(sessions, config)
    if not stability.secondary_is_tighter:
        raise HTTPException(
            422,
            "the second axis is not measurably a better unit for this work: "
            + stability.reason,
        )

    version = _next_version(db, trackable_id, None)
    if version == 1:
        raise HTTPException(409, "nothing to rebaseline: create the original baseline first")

    old_unit = trackable.unit
    baseline = Baseline(
        trackable_id=trackable_id,
        version=version,
        planned_sessions=_latest_planned_sessions(db, trackable_id),
        scope_units=body.secondary_total_units,
        unit=trackable.secondary_unit,
        target_date=_latest_target_date(db, trackable_id),
        resolution="change_metric",
        rationale=body.rationale,
    )

    # The promotion. completed_units is trigger-owned and recomputes from
    # actual_output, so the two columns are swapped on the SESSIONS as well --
    # otherwise the cache would immediately contradict the new unit.
    for row in db.exec(select(WorkSession).where(WorkSession.trackable_id == trackable_id)):
        row.actual_output, row.secondary_output = row.secondary_output, row.actual_output
        db.add(row)

    trackable.unit = trackable.secondary_unit
    trackable.total_units = body.secondary_total_units
    trackable.total_units_source = body.secondary_total_units_source
    trackable.secondary_unit = old_unit
    trackable.secondary_total_units = None
    trackable.secondary_total_units_source = None
    # prior_pace was stated in the old unit and is now meaningless. Clearing it
    # is honest: pace falls back to the observations, and P2 prefers an absent
    # prior to one silently reinterpreted in a different currency.
    trackable.prior_pace = None

    db.add(trackable)
    db.add(baseline)
    db.commit()
    db.refresh(baseline)
    db.refresh(trackable)

    history = db.exec(
        select(Baseline)
        .where(Baseline.trackable_id == trackable_id)
        .order_by(Baseline.version)
    ).all()
    return {
        "trackable": trackable.model_dump(),
        "current": baseline.model_dump(),
        "original": history[0].model_dump(),
        "history": [h.model_dump() for h in history],
    }


def _latest_planned_sessions(db: Session, trackable_id: int) -> int:
    latest = db.exec(
        select(Baseline)
        .where(Baseline.trackable_id == trackable_id)
        .order_by(Baseline.version.desc())
    ).first()
    return latest.planned_sessions if latest else 0


def _latest_target_date(db: Session, trackable_id: int):
    latest = db.exec(
        select(Baseline)
        .where(Baseline.trackable_id == trackable_id)
        .order_by(Baseline.version.desc())
    ).first()
    if latest is None:
        raise HTTPException(409, "no baseline to carry a target date from")
    return latest.target_date
