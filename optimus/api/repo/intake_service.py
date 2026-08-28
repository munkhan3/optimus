"""Turning an approved proposal into rows.

D10/D11: the model proposes, the user approves, and only then does anything get
written. This module is the only place the interview's output reaches the
database, and it goes through the same invariants as the manual forms -- a
second write path that skipped them would make those guarantees decorative.

The whole tree lands in ONE transaction. A partially written goal graph is worse
than none: feasibility, drift, and ranking all read the graph as a whole, so a
goal with two of its three milestones produces confident numbers about a plan
the user never agreed to.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session

from ..llm.ingest import IngestProposal, ProposedGoal, ProposedMilestone, ProposedTrackable
from ..models import Baseline, Goal, Milestone, OpenGap, Trackable
from .write_rules import check_activation, gap_for_estimated_units

# A trackable needs a baseline for drift (§24.4) and required pace (§24.2) to
# mean anything, and v1 is retained forever (§25.3). When the user has given a
# pace estimate we can size the plan from it; otherwise we fall back to this and
# the number is visibly provisional rather than invented precision.
FALLBACK_PLANNED_SESSIONS = 10


def _parse_date(value: str | None, field: str) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(422, f"{field} is not an ISO date: {value!r}") from exc


def persist_proposal(db: Session, proposal: IngestProposal) -> dict[str, Any]:
    """Write the approved tree. All of it, or none of it.

    Returns a summary keyed by the proposal's slugs so the client can map what
    it was looking at onto what now exists.
    """
    created: dict[str, list[dict[str, Any]]] = {
        "goals": [], "milestones": [], "trackables": [], "baselines": [], "gaps": [],
    }

    try:
        for p_goal in proposal.goals:
            goal = _write_goal(db, p_goal, created)
            for p_milestone in p_goal.milestones:
                milestone = _write_milestone(db, p_milestone, goal, created)
                for p_trackable in p_milestone.trackables:
                    _write_trackable(db, p_trackable, milestone, created)

        _write_gaps(db, proposal, created)
        db.commit()
    except Exception:
        # Explicit rollback: the session is request-scoped, and leaving a failed
        # transaction open would let a later read in the same request see a
        # half-built tree.
        db.rollback()
        raise

    return {
        "created": {k: len(v) for k, v in created.items()},
        "detail": created,
    }


def _write_goal(db: Session, p: ProposedGoal, created: dict) -> Goal:
    goal = Goal(
        title=p.title,
        kind=p.kind,
        definition_of_done=p.definition_of_done,
        dod_source=p.dod_source,
        activation=p.activation,
        deadline=_parse_date(p.deadline, f"goal '{p.title}' deadline"),
        pace_mode=p.pace_mode,
        reset_period_days=p.reset_period_days,
        stakes=p.stakes,
    )
    # AC1, shared with the manual path. A proposal that would activate a goal
    # with no deadline is refused here rather than corrected silently -- the
    # system holds the line and says why (P4).
    check_activation(goal)

    db.add(goal)
    db.flush()
    created["goals"].append({"key": p.key, "id": goal.id, "title": goal.title})
    return goal


def _write_milestone(
    db: Session, p: ProposedMilestone, goal: Goal, created: dict
) -> Milestone:
    milestone = Milestone(
        goal_id=goal.id,
        title=p.title,
        definition_of_done=p.definition_of_done,
        dod_source=p.dod_source,
        deadline=_parse_date(p.deadline, f"milestone '{p.title}' deadline"),
        exploratory=p.exploratory,
        planned_sessions=p.planned_sessions,
    )
    db.add(milestone)
    db.flush()
    created["milestones"].append({"key": p.key, "id": milestone.id, "title": milestone.title})
    return milestone


def _write_trackable(
    db: Session, p: ProposedTrackable, milestone: Milestone, created: dict
) -> Trackable:
    trackable = Trackable(
        milestone_id=milestone.id,
        title=p.title,
        unit=p.unit,
        total_units=p.total_units,
        total_units_source=p.total_units_source,
        task_type=p.task_type,
        prior_pace=p.prior_pace,
    )
    db.add(trackable)
    db.flush()
    created["trackables"].append({"key": p.key, "id": trackable.id, "title": trackable.title})

    # AC18, shared with the manual path: an inferred total never lands without
    # the question about it landing in the same transaction.
    gap = gap_for_estimated_units(db, trackable, milestone)
    if gap is not None:
        db.flush()
        created["gaps"].append({"id": gap.id, "question": gap.question})

    target = _parse_date(p.target_date, f"trackable '{p.title}' target date") or milestone.deadline
    if target is not None:
        planned = (
            max(math.ceil(p.total_units / p.prior_pace), 1)
            if p.prior_pace
            else FALLBACK_PLANNED_SESSIONS
        )
        baseline = Baseline(
            trackable_id=trackable.id,
            version=1,
            planned_sessions=planned,
            scope_units=p.total_units,
            target_date=target,
        )
        db.add(baseline)
        db.flush()
        created["baselines"].append({"trackable_id": trackable.id, "version": 1})

    return trackable


def _write_gaps(db: Session, proposal: IngestProposal, created: dict) -> None:
    """Unanswered interview questions persist and resurface at review (§22.3).

    Gaps the model raised about structure rather than about an estimated total;
    the estimate-specific ones are already handled by gap_for_estimated_units.
    """
    goal_ids = {g["key"]: g["id"] for g in created["goals"]}
    for p_gap in proposal.gaps:
        subject_id = next(
            (gid for key, gid in goal_ids.items() if key and key in (p_gap.subject or "")),
            None,
        )
        gap = OpenGap(
            goal_id=subject_id or (created["goals"][0]["id"] if created["goals"] else None),
            question=p_gap.question,
            priority=p_gap.priority,
        )
        if gap.goal_id is None:
            continue  # nothing to hang it off; an orphan gap helps no one
        db.add(gap)
        db.flush()
        created["gaps"].append({"id": gap.id, "question": gap.question})
