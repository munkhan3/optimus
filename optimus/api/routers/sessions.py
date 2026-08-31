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

from dataclasses import replace
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import Session, select

from optimus.metrics.pace import empirical_pace
from optimus.metrics.productivity import density_fit, session_productivity

from ..auth import get_user_session as get_session
from ..llm.client import Deadline, LLMUnavailable, request_budget_seconds
from ..llm.ingest import gaps_sorted, parse_brain_dump
from ..llm.session_review import review_session
from ..models import TASK_TYPE, Milestone, ProgressCheckRow, Trackable, WorkSession
from ..repo import loader
from ..repo.metrics_service import serialize
from ..schemas import (
    SessionAttach,
    SessionEnd,
    SessionReflection,
    SessionRetroactive,
    SessionStart,
)
from ..settings import get_metrics_config

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _now() -> datetime:
    return datetime.now(UTC)


def _resolve_task_type(
    db: Session,
    trackable_id: int | None,
    milestone_id: int | None,
    declared: str | None = None,
) -> tuple[str, Trackable | None]:
    """FIX 4: task_type is stamped on the session at write time.

    Reaching it through the trackable would break for milestone-only sessions
    and would silently rewrite history if a trackable were later reclassified.

    A session attached to NOTHING is allowed. Work does not always arrive with a
    goal tree already built around it, and refusing to time it until one exists
    is the tool asking to be served. Such a session shapes no pace for free: with
    no trackable there is no expected_output, so actual_output stays NULL and
    SessionObs.counts_toward_pace is already False. It stays inert until the
    interview turns the description into a tree and it is attached.
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
    if declared is not None and declared not in TASK_TYPE:
        raise HTTPException(422, f"task_type must be one of {list(TASK_TYPE)}")
    return (declared or "exploratory"), None


def _expected_output(
    db: Session, trackable: Trackable | None, planned_minutes: int
) -> float | None:
    """§23.4: expected output always comes from pace_hat, never a fixed guess.

    Returns None when there is no usable estimate. The UI then asks for nothing
    rather than presenting an invented number for the user to anchor on (P2).

    Scaled to the session's own length. `pace_hat` is denominated per STANDARD
    session, so once durations vary a 50-minute session prefilled with a
    25-minute expectation would report actual/expected near 2.0 every time --
    and §24.5 calibration, whose entire job is to measure the user's optimism,
    would instead be measuring the clock.
    """
    if trackable is None:
        return None
    config = get_metrics_config()
    pace = empirical_pace(
        loader.pooled_sessions(db, trackable.task_type), trackable.prior_pace, config
    )
    if pace.point is None:
        return None
    if config.session.minutes > 0:
        pace = replace(
            pace, point=pace.point * planned_minutes / config.session.minutes
        )
    # Round the expectation to something a person can confirm in one tap.
    # pace_hat is a shrinkage estimate and carries full float precision;
    # prefilling "21.666666666666668 pages" makes confirming it absurd, which
    # defeats the one-tap budget in §23.2. Rounding here rather than in the UI
    # keeps the stored expectation and the displayed one identical, so
    # calibration (actual/expected) measures what the user was actually shown.
    return round(pace.point, 1)


@router.get("/defaults")
def session_defaults() -> dict:
    """What the start control needs to offer a duration (§36.1, reversed).

    Sessions are no longer fixed at 25 minutes. `minutes` is the prefill and
    `presets` are the one-tap choices; neither is a whitelist, since the API
    accepts any positive `planned_minutes`. `min_session_minutes` is returned so
    the client can say why an implausibly short session will not shape pace,
    rather than silently discarding the explanation.
    """
    config = get_metrics_config()
    return {
        "minutes": config.session.minutes,
        "presets": list(config.session.presets),
        "min_session_minutes": config.session.min_session_minutes,
    }


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

    task_type, trackable = _resolve_task_type(
        db, body.trackable_id, body.milestone_id, body.task_type
    )
    config = get_metrics_config()
    planned = body.planned_minutes or config.session.minutes

    row = WorkSession(
        task_id=body.task_id,
        trackable_id=body.trackable_id,
        milestone_id=body.milestone_id,
        task_type=task_type,
        started_at=_now(),
        planned_minutes=planned,
        expected_output=_expected_output(db, trackable, planned),
        secondary_expected_output=body.target_secondary_output,
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
    # Flow is the part of a session that happened after it was over: the timer
    # ran out, said so, and the user carried on anyway. The client reports it
    # because it watched the crossing; when it does not -- a session ended from
    # the desktop pill, or from a phone that never showed a countdown -- the
    # wall-clock overrun is the honest stand-in. It does overcount someone who
    # walked away and came back, which is why the reported value wins when
    # there is one.
    row.flow_minutes = (
        body.flow_minutes
        if body.flow_minutes is not None
        else max(0.0, row.actual_minutes - row.planned_minutes)
    )
    row.focus_rating = body.focus_rating
    row.note = body.note
    row.secondary_output = body.secondary_output
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
    return {
        "session": row.model_dump(),
        "progress_check_created": check_id,
        # Returned so the client knows whether to ask what happened. Ending stays
        # one tap: this is computed from data already written, blocks nothing,
        # and involves no model call.
        "productivity": _productivity_for(db, row),
    }


def _productivity_for(db: Session, row: WorkSession) -> dict | None:
    """The second-axis reading for one finished session, or None.

    None for an untagged or milestone-only session: with no trackable there is
    no history to fit against, and inventing one would be the fabrication P2
    forbids.
    """
    if row.trackable_id is None:
        return None
    config = get_metrics_config()
    history = loader.trackable_sessions(db, row.trackable_id)
    if not history:
        return None
    fit = density_fit(history, config)
    obs = loader.to_session_obs(row)
    return serialize(session_productivity(obs, history, fit, config))


@router.patch("/{session_id}/reflection")
def record_reflection(
    session_id: int, body: SessionReflection, db: Session = Depends(get_session)
) -> dict:
    """Attach a note, a count, or both, after the session is already saved.

    Ending is one tap, so the prompt asking why an unusual session went the way
    it did arrives afterwards and lands here.

    This is also the only path by which a model-extracted count becomes stored
    data. The analysis endpoint returns what it read and writes nothing; going
    through here makes the number user-supplied, which is what lets the mirrored
    columns carry no per-observation provenance field.
    """
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")

    if body.note is not None:
        row.note = body.note
    if body.secondary_output is not None:
        row.secondary_output = body.secondary_output
    db.add(row)

    if body.secondary_unit and row.trackable_id is not None:
        trackable = db.get(Trackable, row.trackable_id)
        # Naming the unit here means confirming a count also opens the second
        # axis, rather than requiring a separate trip to edit the trackable.
        if trackable is not None and not trackable.secondary_unit:
            trackable.secondary_unit = body.secondary_unit
            db.add(trackable)

    db.commit()
    db.refresh(row)
    # secondary_completed_units is maintained by the trigger, not here.
    return {"session": row.model_dump(), "productivity": _productivity_for(db, row)}


@router.post("/{session_id}/analyze")
def analyze_session(session_id: int, db: Session = Depends(get_session)) -> dict:
    """Read the session's note against its numbers. Writes nothing.

    Called by the client AFTER the session is already saved, so ending stays one
    tap (§23.2) and a slow or unavailable model never delays the log. Any count
    the model finds comes back as a proposal for PATCH /secondary to confirm.
    """
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")
    if not (row.note or "").strip():
        raise HTTPException(422, "this session has no note to read")

    trackable = db.get(Trackable, row.trackable_id) if row.trackable_id else None
    config = get_metrics_config()
    history = loader.trackable_sessions(db, row.trackable_id) if row.trackable_id else []
    productivity = _productivity_for(db, row)

    pace = empirical_pace(history, trackable.prior_pace if trackable else None, config)

    try:
        insight = review_session(
            note=row.note or "",
            unit=trackable.unit if trackable else "units",
            primary_output=row.actual_output,
            typical_output=pace.point,
            minutes=row.actual_minutes,
            secondary_unit=trackable.secondary_unit if trackable else None,
            productivity_index=(
                productivity.get("productivity_index") if productivity else None
            ),
            deadline=Deadline(request_budget_seconds()),
        )
    except LLMUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    return {
        "insight": insight.model_dump(),
        "productivity": productivity,
        # D10/D11: nothing here has been written. The count, if any, is a
        # proposal until PATCH /secondary confirms it.
        "persisted": False,
    }


@router.post("/{session_id}/propose-tree")
def propose_tree(session_id: int, db: Session = Depends(get_session)) -> dict:
    """Turn an untagged session's description into a proposed goal tree.

    Reuses the intake interview wholesale (§22): the same parser, the same
    proposal shape the intake screen already renders and confirms, and the same
    POST /api/intake/approve to write it. Nothing new is invented for this path
    because nothing needs to be -- a description of work just done is a brain
    dump with a session attached.
    """
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")
    if not (row.note or "").strip():
        raise HTTPException(422, "describe the session before proposing a tree")

    try:
        proposal = parse_brain_dump(row.note or "", today=_now().date().isoformat())
    except LLMUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    return {
        "proposal": proposal.model_dump(),
        "questions_to_ask": [g.model_dump() for g in gaps_sorted(proposal)],
        "persisted": False,
    }


@router.post("/{session_id}/attach")
def attach_session(
    session_id: int, body: SessionAttach, db: Session = Depends(get_session)
) -> dict:
    """Attach an untagged session to what the interview created.

    The completed_units caches are recomputed by the database trigger on this
    UPDATE, including for a trackable the session is moving away from. No
    application code touches them.
    """
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")
    if body.trackable_id is None and body.milestone_id is None:
        raise HTTPException(422, "attaching needs a trackable_id or a milestone_id")

    # Validates the target exists and re-stamps task_type, which must follow
    # the work rather than stay at whatever an untagged session declared.
    task_type, trackable = _resolve_task_type(db, body.trackable_id, body.milestone_id)
    row.trackable_id = body.trackable_id
    row.milestone_id = body.milestone_id
    row.task_type = task_type

    # A session assigned while it is STILL RUNNING needs the expectation it
    # would have been given at the start (§23.4), or ending it has nothing to
    # prefill and the one-tap confirm in §23.2 is lost. This is the ordinary
    # case for the start-first-assign-later flow, not an edge case.
    #
    # A session that has already ended keeps whatever expectation it had.
    # Back-filling one there would invent the prediction that §24.5 calibration
    # exists to score the user against, and score them against it.
    if row.ended_at is None and trackable is not None:
        row.expected_output = _expected_output(db, trackable, row.planned_minutes)

    if body.actual_output is not None:
        row.actual_output = body.actual_output
    if body.secondary_output is not None:
        row.secondary_output = body.secondary_output
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"session": row.model_dump()}


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
            else _expected_output(db, trackable, planned)
        ),
        actual_output=body.actual_output,
        intent_met=body.intent_met,
        interrupted=body.interrupted,
        note=body.note,
        secondary_output=body.secondary_output,
        entered_retroactively=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_session(session_id: int, db: Session = Depends(get_session)) -> None:
    """Discard a session that is still running. It never happened.

    Distinct from `interrupted`, and the difference is the whole point. An
    interrupted session HAPPENED: the work is real, it is retained, and it is
    excluded from pace because it measures the interruption rather than the
    user (§23.6). A cancelled session contains nothing -- the timer was started
    by mistake, or on the wrong thing -- and retaining it would put a row in the
    log that says work occurred when none did.

    That distinction matters more since the timer became one tap: a start that
    costs nothing produces starts that were not meant, and the alternative to
    cancelling is ending them, which writes `expected_output` into
    `actual_output` as though the expectation had been met. A few of those and
    pace is measuring the user's mis-taps.

    Refused once the session has ended. A finished session is a logged fact, and
    deleting logged facts is a different act from abandoning an in-flight timer
    -- one this endpoint deliberately cannot perform. Correct a bad row with
    `interrupted`, or by editing what it recorded.
    """
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")
    if row.ended_at is not None:
        raise HTTPException(
            409,
            "this session has already ended; a finished session is a logged fact. "
            "Mark it interrupted to keep it out of pace.",
        )

    db.delete(row)
    db.commit()
    # completed_units and secondary_completed_units are refreshed by the trigger
    # on DELETE. An open session has no output to withdraw, but the trigger runs
    # regardless and the caches stay correct without help from here.


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


@router.patch("/{session_id}")
def update_session(
    session_id: int,
    body: dict,
    db: Session = Depends(get_session),
) -> dict:
    """Edit a finished or retroactive session's editable fields.

    Allowed keys: started_at, ended_at, planned_minutes, actual_minutes,
    expected_output, actual_output, intent_met, interrupted, note,
    secondary_output, entered_retroactively.
    """
    row = db.get(WorkSession, session_id)
    if row is None:
        raise HTTPException(404, f"session {session_id} not found")

    # Only allow edits that make sense; keep validation minimal here and
    # rely on higher-level callers to ensure sensible values.
    allowed = {
        "started_at",
        "ended_at",
        "planned_minutes",
        "actual_minutes",
        "expected_output",
        "actual_output",
        "intent_met",
        "interrupted",
        "note",
        "secondary_output",
        "entered_retroactively",
    }

    for k, v in body.items():
        if k not in allowed:
            raise HTTPException(422, f"field {k} is not editable")
        # Parse datetimes if the client sent ISO strings so the DB row keeps
        # proper `datetime` objects rather than raw strings.
        if k in ("started_at", "ended_at") and isinstance(v, str):
            try:
                parsed = datetime.fromisoformat(v)
            except Exception:
                raise HTTPException(422, f"invalid ISO datetime for {k}")
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            setattr(row, k, parsed)
        else:
            setattr(row, k, v)

    # Basic sanity: ended_at must not be before started_at if both present.
    if row.started_at and row.ended_at and row.ended_at < row.started_at:
        raise HTTPException(422, "ended_at cannot be before started_at")

    # Recompute actual_minutes if both timestamps present and caller did not
    # explicitly set actual_minutes.
    if row.started_at and row.ended_at and (
        "actual_minutes" not in body or body.get("actual_minutes") is None
    ):
        row.actual_minutes = (row.ended_at - row.started_at).total_seconds() / 60.0

    db.add(row)
    db.commit()
    db.refresh(row)
    return {"session": row.model_dump(), "productivity": _productivity_for(db, row)}


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
