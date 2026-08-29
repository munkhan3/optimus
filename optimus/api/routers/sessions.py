"""Session logging. The most latency-sensitive surface in the product.

P5: measurement must be nearly free. Every metric is downstream of the user
logging what happened, so if logging costs more than seconds the data degrades
and every derived number becomes fiction. §23 gives the budget explicitly -- if
any of these takes more than one interaction, the implementation is wrong.

D2: the system quantifies at planning time; the user only reports completion.
The user is never asked "how much did you get done?" in open form. Expected
output is prefilled from pace_hat and confirming it is one tap.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import Session, select

from optimus.metrics.pace import empirical_pace

from ..auth import get_user_session as get_session
from ..models import Milestone, ProgressCheckRow, Trackable, WorkSession
from ..repo import loader
from ..schemas import SessionEnd, SessionRetroactive, SessionStart
from ..settings import get_metrics_config

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _now() -> datetime:
    return datetime.now(UTC)


def _resolve_task_type(
    db: Session, trackable_id: int | None, milestone_id: int | None
) -> tuple[str, Trackable | None]:
    """FIX 4: task_type is stamped on the session at write time.

    Reaching it through the trackable would break for milestone-only sessions
    and would silently rewrite history if a trackable were later reclassified.
    """
    if trackable_id is not None:
        trackable = db.get(Trackable, trackable_id)
        if trackable is None:
            raise HTTPException(404, f"trackable {trackable_id} not found")
        return trackable.task_type, trackable
    if milestone_id is not None:
        milestone = db.get(Milestone, milestone_id)
        if milestone is None:
            raise HTTPException(404, f"milestone {milestone_id} not found")
        return ("exploratory" if milestone.exploratory else "admin"), None
    raise HTTPException(422, "a session needs a trackable_id or a milestone_id")


def _expected_output(db: Session, trackable: Trackable | None) -> float | None:
    """§23.4: expected output always comes from pace_hat, never a fixed guess.

    Returns None when there is no usable estimate. The UI then asks for nothing
    rather than presenting an invented number for the user to anchor on (P2).
    """
    if trackable is None:
        return None
    config = get_metrics_config()
    pace = empirical_pace(
        loader.pooled_sessions(db, trackable.task_type), trackable.prior_pace, config
    )
    if pace.point is None:
        return None
    # Round the expectation to something a person can confirm in one tap.
    # pace_hat is a shrinkage estimate and carries full float precision;
    # prefilling "21.666666666666668 pages" makes confirming it absurd, which
    # defeats the one-tap budget in §23.2. Rounding here rather than in the UI
    # keeps the stored expectation and the displayed one identical, so
    # calibration (actual/expected) measures what the user was actually shown.
    return round(pace.point, 1)


@router.get("/open")
def open_session(db: Session = Depends(get_session)) -> dict | None:
    """The in-flight session, if any.

    Timer state lives in this row rather than in the browser, so closing the
    tab or switching to the phone loses nothing.
    """
    row = db.exec(
        select(WorkSession)
        .where(WorkSession.ended_at.is_(None))
        .order_by(WorkSession.started_at.desc())
    ).first()
    return row.model_dump() if row else None


@router.post("/start", status_code=status.HTTP_201_CREATED)
def start_session(body: SessionStart, db: Session = Depends(get_session)) -> dict:
    existing = db.exec(
        select(WorkSession).where(WorkSession.ended_at.is_(None))
    ).first()
    if existing is not None:
        raise HTTPException(
            409,
            f"session {existing.id} is still open; end it before starting another.",
        )

    task_type, trackable = _resolve_task_type(db, body.trackable_id, body.milestone_id)
    config = get_metrics_config()

    row = WorkSession(
        task_id=body.task_id,
        trackable_id=body.trackable_id,
        milestone_id=body.milestone_id,
        task_type=task_type,
        started_at=_now(),
        planned_minutes=body.planned_minutes or config.session.minutes,
        expected_output=_expected_output(db, trackable),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.post("/{session_id}/end")
def end_session(
    session_id: int, body: SessionEnd, db: Session = Depends(get_session)
) -> dict:
    """One input for a metered session; one toggle for an exploratory one."""
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")
    if row.ended_at is not None:
        raise HTTPException(409, f"session {session_id} already ended")

    ended = _now()
    row.ended_at = ended
    row.actual_minutes = (ended - row.started_at).total_seconds() / 60.0
    # Omitting actual_output means "the expected value was right" -- confirming
    # the prefilled number is one tap (§23.2).
    row.actual_output = (
        body.actual_output if body.actual_output is not None else row.expected_output
    )
    row.intent_met = body.intent_met
    row.interrupted = body.interrupted
    row.focus_rating = body.focus_rating
    row.note = body.note
    db.add(row)

    # D12 / AC16: the slider is offered alongside and always skippable. Skipping
    # must be the path of least resistance, so omitting it writes NO row at all
    # -- a forced slider produces invented numbers.
    check_id = None
    if body.self_assessed_pct is not None:
        check = ProgressCheckRow(
            milestone_id=row.milestone_id if row.trackable_id is None else None,
            trackable_id=row.trackable_id,
            self_assessed_pct=body.self_assessed_pct,
            session_id=row.id,
            recorded_at=ended,
        )
        db.add(check)
        db.flush()
        check_id = check.id

    db.commit()
    db.refresh(row)
    return {"session": row.model_dump(), "progress_check_created": check_id}


@router.post("", status_code=status.HTTP_201_CREATED)
def log_retroactively(
    body: SessionRetroactive, db: Session = Depends(get_session)
) -> dict:
    """§23.5. Absent this, every forgotten day becomes a permanent hole.

    D13: the row is flagged, and that flag reduces its weight in calibration
    only -- it counts fully toward progress and pace (AC17).
    """
    task_type, trackable = _resolve_task_type(db, body.trackable_id, body.milestone_id)
    config = get_metrics_config()
    planned = body.planned_minutes or config.session.minutes

    row = WorkSession(
        task_id=body.task_id,
        trackable_id=body.trackable_id,
        milestone_id=body.milestone_id,
        task_type=task_type,
        started_at=body.started_at,
        ended_at=body.started_at,
        planned_minutes=planned,
        actual_minutes=body.actual_minutes if body.actual_minutes is not None else planned,
        expected_output=(
            body.expected_output
            if body.expected_output is not None
            else _expected_output(db, trackable)
        ),
        actual_output=body.actual_output,
        intent_met=body.intent_met,
        interrupted=body.interrupted,
        note=body.note,
        entered_retroactively=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.patch("/{session_id}/interrupted")
def toggle_interrupted(
    session_id: int, interrupted: bool = Query(...), db: Session = Depends(get_session)
) -> dict:
    """§23.6: one toggle. Excluded from pace, retained -- the work happened."""
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")
    row.interrupted = interrupted
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.get("")
def list_sessions(
    since: date | None = None,
    trackable_id: int | None = None,
    limit: int = Query(default=100, le=1000),
    db: Session = Depends(get_session),
) -> list[dict]:
    stmt = select(WorkSession).order_by(WorkSession.started_at.desc()).limit(limit)
    if trackable_id is not None:
        stmt = stmt.where(WorkSession.trackable_id == trackable_id)
    if since is not None:
        stmt = stmt.where(WorkSession.started_at >= datetime.combine(since, datetime.min.time()))
    return [r.model_dump() for r in db.exec(stmt).all()]
