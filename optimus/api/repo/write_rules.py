"""Invariants that every write path into the goal graph must satisfy.

These live here rather than in a router because there are now two ways rows get
created: the manual forms, and the intake interview. An invariant enforced in
only one of them is not an invariant -- it is a coincidence.

Both rules below have acceptance tests against them (AC1, AC18), and both tests
exercise only the manual path. Extracting the logic is what keeps those tests
meaningful for the intake path too.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlmodel import Session

from ..models import Goal, Milestone, OpenGap, Trackable, _utcnow

Completable = Goal | Milestone | Trackable


def check_activation(goal: Goal) -> None:
    """D1/D4 and AC1. Raises with an explanation rather than a constraint 500.

    The database enforces this too. Doing it here as well buys a message the
    user can act on -- the point is to hold the line *and* say why (P4).
    """
    if goal.activation != "active":
        return
    if not goal.definition_of_done.strip():
        raise HTTPException(
            422,
            "A goal cannot be activated without a definition of done: "
            "work that cannot be recognized as complete cannot be planned against.",
        )
    # §9: a vision is directional and unbounded, so it never carries a deadline.
    if goal.kind == "vision":
        return
    # §12: a recurring commitment has a deadline every period. "Gym six days a
    # week" is not an intention, and the window closing weekly IS its deadline --
    # demanding an absolute date would make the whole recurring category
    # impossible to activate.
    if goal.pace_mode == "reset_period" and goal.reset_period_days:
        return
    if goal.deadline is None:
        raise HTTPException(
            422,
            "An active goal needs a deadline. A goal with no deadline is not being "
            "worked on -- it is an intention, and belongs parked. (A recurring "
            "commitment is the exception: set pace_mode to reset_period with a "
            "period, and the window closing is its deadline.)",
        )


def gap_for_estimated_units(
    db: Session, trackable: Trackable, milestone: Milestone
) -> OpenGap | None:
    """AC18/D3: a model-estimated total_units never gets recorded silently.

    Returns the gap it added (unflushed), or None when the total came from the
    user or from a verifiable fact. The caller must not commit one without the
    other -- the guarantee is that the estimate and the question about it live
    or die together.
    """
    if trackable.total_units_source != "model_estimated":
        return None

    goal = db.get(Goal, milestone.goal_id)
    gap = OpenGap(
        trackable_id=trackable.id,
        milestone_id=milestone.id,
        question=(
            f"How many {trackable.unit} is '{trackable.title}' really? "
            f"I estimated {trackable.total_units:g} but did not verify it."
        ),
        # §15.3: stakes x uncertainty. An unverified estimate is maximally
        # uncertain, so priority is carried by the stakes of its goal.
        priority=float(goal.stakes if goal else 3),
    )
    db.add(gap)
    return gap


def stamp_completion(node: Completable) -> None:
    """Keep completed_at consistent with status on every write path.

    Status is mutated in place, so without this the schema records *that* work
    finished and never *when* -- which makes "what did I finish this month"
    unanswerable and leaves a planned-vs-actual roadmap with nothing to draw.

    Reopening clears the stamp rather than keeping the old one. A goal moved
    back to in_progress is not finished, and a stale completion date is worse
    than an absent one: absent reads as unknown, stale reads as fact.

    Idempotent by design. Re-saving a row that is already done must not slide
    its completion date forward to today -- most PATCHes touch some other field
    entirely, and a date that drifts on every edit is not a record of anything.
    """
    if node.status == "done":
        if node.completed_at is None:
            node.completed_at = _utcnow()
    else:
        node.completed_at = None
