"""Weekly review (§15.4, §28 M4).

The relationship with the assistant continues through review cadence. This is
where inferred values get corrected, scope gets renegotiated, and the system
reports what it has learned about how the user actually works.

Everything here is assembled from the metrics engine and stored state. It
proposes; it never applies (D11). In particular the rebaseline prompts respect
the §25.4 gate -- a bad week at n=2 is noise, and prompting on it would teach
the user that the prompts are worthless.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from optimus.metrics.drift import drift_against_all
from optimus.metrics.pace import empirical_pace
from optimus.metrics.productivity import (
    density_fit,
    series_stability,
    session_productivity,
)
from optimus.metrics.progress import remaining_units
from optimus.metrics.rebaseline import evaluate_exploratory, evaluate_metered
from optimus.metrics.stall import detect_stall

from ..auth import get_user_session as get_session
from ..models import (
    Capacity,
    Goal,
    Milestone,
    OpenGap,
    PlanItem,
    ProgressCheckRow,
    Trackable,
    WeeklyCommitment,
    WorkSession,
)
from ..repo import loader
from ..repo.loader import week_start
from ..repo.metrics_service import serialize
from ..settings import get_metrics_config

router = APIRouter(prefix="/api/reviews", tags=["reviews"])


def _today() -> date:
    return datetime.now(UTC).date()


@router.get("/weekly")
def weekly_review(week: date | None = None, db: Session = Depends(get_session)) -> dict:
    """Plan vs actual, calibration, unresolved estimates, and rebaseline prompts."""
    config = get_metrics_config()
    today = _today()
    start = week_start(week or today)
    end = start + timedelta(days=7)

    capacity = db.exec(select(Capacity).where(Capacity.week_start == start)).first()

    # ---- plan vs actual -----------------------------------------------------
    commitments = (
        db.exec(
            select(WeeklyCommitment).where(WeeklyCommitment.capacity_id == capacity.id)
        ).all()
        if capacity
        else []
    )

    plan_vs_actual = []
    for c in commitments:
        if c.trackable_id is not None:
            trackable = db.get(Trackable, c.trackable_id)
            used = loader.sessions_used_this_week(db, c.trackable_id, today)
            done = sum(
                s.actual_output or 0
                for s in db.exec(
                    select(WorkSession)
                    .where(WorkSession.trackable_id == c.trackable_id)
                    .where(WorkSession.started_at >= datetime.combine(start, datetime.min.time()))
                ).all()
            )
            plan_vs_actual.append({
                "label": trackable.title if trackable else None,
                "trackable_id": c.trackable_id,
                "committed_sessions": c.committed_sessions,
                "sessions_used": used,
                "target_units": c.target_units,
                "units_done": done,
                "hit_target": (c.target_units is not None and done >= c.target_units),
            })
        else:
            milestone = db.get(Milestone, c.milestone_id)
            used = len(
                db.exec(
                    select(WorkSession)
                    .where(WorkSession.milestone_id == c.milestone_id)
                    .where(WorkSession.started_at >= datetime.combine(start, datetime.min.time()))
                ).all()
            )
            plan_vs_actual.append({
                "label": milestone.title if milestone else None,
                "milestone_id": c.milestone_id,
                "committed_sessions": c.committed_sessions,
                "sessions_used": used,
                "target_units": None,
                "units_done": None,
                "hit_target": used >= c.committed_sessions,
            })

    # ---- what the system learned about the user this week --------------------
    # §8: completion ratios trending toward 1.0 is a stated success criterion,
    # so calibration is reported per task_type rather than as one number.
    from ..repo.metrics_service import calibration_by_task_type

    # Shared with the dashboard so the two screens cannot disagree. The review
    # has never shown the raw ratio series, so it keeps projecting them away.
    calibration_by_type = {
        task_type: {k: v for k, v in report.items() if not k.endswith("_ratios")}
        for task_type, report in calibration_by_task_type(db).items()
    }

    # ---- rebaseline prompts, gated ------------------------------------------
    prompts = []
    # Prompts held back because the primary unit is understating the work. §17's
    # concern is drift that goes UNSEEN, so a held prompt is reported here rather
    # than dropped -- deferred and visible, never silent.
    held: list[dict] = []
    switch_proposals: list[dict] = []
    for trackable in db.exec(select(Trackable)).all():
        state = loader.to_trackable_state(trackable)
        pace = empirical_pace(
            loader.pooled_sessions(db, trackable.task_type), trackable.prior_pace, config
        )
        baselines = loader.baselines_for_trackable(db, trackable.id or 0)
        if not baselines:
            continue
        used = loader.sessions_used_this_week(db, trackable.id or 0, today)
        current, _original = drift_against_all(
            remaining_units(state), pace, baselines, used
        )
        if current is None:
            continue
        own = loader.trackable_sessions(db, trackable.id or 0)
        fit = density_fit(own, config)
        productivity = (
            session_productivity(own[-1], own, fit, config) if own else None
        )

        proposal = evaluate_metered(
            remaining_units(state), pace, current, config, productivity=productivity
        )
        entry = {
            "trackable_id": trackable.id,
            "label": trackable.title,
            "trigger": proposal.trigger,
            "reason": proposal.gate_reason,
            "drift_sessions": current.sessions,
            "options": list(proposal.options),
        }
        if proposal.should_prompt:
            prompts.append(entry)
        elif proposal.held_by_density:
            held.append(entry)

        # Whether the unit is wrong is a measurement, not an opinion: the two
        # series are compared over the same sessions, and no proposal is made
        # unless one is measurably tighter.
        if trackable.secondary_unit:
            stability = series_stability(own, config)
            if stability.secondary_is_tighter:
                switch_proposals.append({
                    "trackable_id": trackable.id,
                    "label": trackable.title,
                    "from_unit": trackable.unit,
                    "to_unit": trackable.secondary_unit,
                    "reason": stability.reason,
                    "stability": serialize(stability),
                    "density_fit": serialize(fit),
                })

    for milestone in db.exec(select(Milestone).where(Milestone.exploratory)).all():
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
                select(WorkSession).where(WorkSession.milestone_id == milestone.id)
            ).all()
        ]
        stall = detect_stall(checks, sessions, config)
        proposal = evaluate_exploratory(stall)
        if proposal.should_prompt:
            prompts.append({
                "milestone_id": milestone.id,
                "label": milestone.title,
                "trigger": proposal.trigger,
                "reason": proposal.gate_reason,
                "series": list(stall.series),
                "options": list(proposal.options),
            })

    # ---- what the user wrote about their sessions ---------------------------
    # Captured notes are surfaced with the numbers beside them. The model pass
    # over them is per-session and on demand (POST /api/sessions/{id}/analyze):
    # a review that silently fired one model call per note would be slow and
    # would spend the request budget on sessions nobody asked about.
    session_notes = []
    for row in db.exec(
        select(WorkSession)
        .where(WorkSession.started_at >= datetime.combine(start, datetime.min.time()))
        .where(WorkSession.started_at < datetime.combine(end, datetime.min.time()))
        .order_by(WorkSession.started_at)
    ).all():
        if not (row.note or "").strip():
            continue
        session_notes.append({
            "session_id": row.id,
            "trackable_id": row.trackable_id,
            "started_at": row.started_at.isoformat(),
            "note": row.note,
            "actual_output": row.actual_output,
            "secondary_output": row.secondary_output,
            "actual_minutes": row.actual_minutes,
        })

    # ---- values the system guessed, resurfaced (D3) ---------------------------
    estimated = [
        {"trackable_id": t.id, "label": t.title, "total_units": t.total_units,
         "field": "total_units"}
        for t in db.exec(
            select(Trackable).where(Trackable.total_units_source == "model_estimated")
        ).all()
    ] + [
        {"goal_id": g.id, "label": g.title, "field": "definition_of_done"}
        for g in db.exec(select(Goal).where(Goal.dod_source == "model_estimated")).all()
    ]

    gaps = db.exec(
        select(OpenGap).where(OpenGap.status == "open").order_by(OpenGap.priority.desc())
    ).all()

    decisions = db.exec(
        select(PlanItem).where(PlanItem.user_action.is_not(None))
    ).all()
    action_counts: dict[str, int] = {}
    for item in decisions:
        action_counts[item.user_action] = action_counts.get(item.user_action, 0) + 1

    return {
        "week_start": str(start),
        "week_end": str(end - timedelta(days=1)),
        "plan_vs_actual": plan_vs_actual,
        "calibration": calibration_by_type,
        # §25.4 gates these: nothing appears here on a wide interval.
        "rebaseline_prompts": prompts,
        # Drift that IS real in the primary unit but is explained by the work
        # being denser than the unit can see. Reported, not dropped.
        "held_rebaselines": held,
        # Where the second axis measures this work measurably better.
        "metric_switch_proposals": switch_proposals,
        # What the user wrote, with the numbers beside it.
        "session_notes": session_notes,
        # D3: everything the model guessed comes back for correction.
        "model_estimated_values": estimated,
        "open_gaps": [
            {"id": g.id, "question": g.question, "priority": g.priority} for g in gaps
        ],
        # §32's training signal, shown back so the user can see their own pattern.
        "revealed_preference": action_counts,
    }
