"""The goal graph as a structure, for drawing.

Deliberately NOT llm/tools.py's get_goal_state. That one calls
metrics_service.trackable_view per node, which runs the full engine and a pooled
session query for every trackable -- correct when the assistant needs real
numbers, far too heavy to render a diagram that may hold fifty nodes.

This returns shape plus the fields already sitting on the rows. Per-node metrics
load when a node is opened, not when the tree is drawn.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..auth import get_user_session as get_session
from ..models import Area, Goal, Milestone, Trackable

router = APIRouter(prefix="/api/tree", tags=["tree"])


# A goal may nest under another goal, and the schema has no `parent_id <> id`
# check the way milestone does (milestone_no_self_block). A cycle would make the
# recursive assembly below run forever, so nesting is depth-capped and anything
# beyond the cap is treated as a root rather than dropped -- a mis-shaped graph
# should still be visible and fixable, not invisible.
MAX_GOAL_DEPTH = 6


@router.get("")
def get_tree(db: Session = Depends(get_session)) -> dict:
    """Four queries, assembled in memory. No per-node round trips."""
    areas = db.exec(select(Area).order_by(Area.id)).all()
    # Ties on created_at are the norm, not the exception: persist_proposal writes
    # an entire approved graph inside one transaction, so every row it creates
    # shares a timestamp. Without a tiebreaker the planner may return tied rows
    # in any order, and the goal map would silently rearrange between visits.
    goals = db.exec(select(Goal).order_by(Goal.created_at, Goal.id)).all()
    milestones = db.exec(select(Milestone).order_by(Milestone.created_at, Milestone.id)).all()
    trackables = db.exec(select(Trackable).order_by(Trackable.created_at, Trackable.id)).all()

    by_milestone: dict[int, list[dict]] = {}
    for t in trackables:
        by_milestone.setdefault(t.milestone_id, []).append({
            "id": t.id,
            "kind": "trackable",
            "title": t.title,
            "unit": t.unit,
            "total_units": t.total_units,
            "completed_units": t.completed_units,
            # P2: a zero total has no meaningful fraction, so it stays null and
            # the bar renders empty rather than as either 0% or 100%.
            "fraction": (t.completed_units / t.total_units) if t.total_units > 0 else None,
            # D3: provenance travels with the node so the UI can flag it.
            "total_units_source": t.total_units_source,
            "task_type": t.task_type,
            "exploratory": t.exploratory,
            "status": t.status,
            "target_date": t.target_date.isoformat() if t.target_date else None,
        })

    by_goal: dict[int, list[dict]] = {}
    for m in milestones:
        by_goal.setdefault(m.goal_id, []).append({
            "id": m.id,
            "kind": "milestone",
            "title": m.title,
            "definition_of_done": m.definition_of_done,
            "dod_source": m.dod_source,
            "exploratory": m.exploratory,
            "planned_sessions": m.planned_sessions,
            "status": m.status,
            "deadline": m.deadline.isoformat() if m.deadline else None,
            "children": by_milestone.get(m.id or 0, []),
        })

    by_id = {g.id: g for g in goals}
    goal_children: dict[int, list[Goal]] = {}
    for g in goals:
        # Ignore a parent that is missing or is the goal itself; the goal table
        # has no `parent_id <> id` check the way milestone does.
        if g.parent_id is not None and g.parent_id != g.id and g.parent_id in by_id:
            goal_children.setdefault(g.parent_id, []).append(g)

    emitted: set[int] = set()

    def goal_payload(g: Goal, depth: int) -> dict:
        emitted.add(g.id or 0)
        children = goal_children.get(g.id or 0, []) if depth < MAX_GOAL_DEPTH else []
        return {
            "id": g.id,
            "kind": g.kind,
            "title": g.title,
            "definition_of_done": g.definition_of_done,
            "dod_source": g.dod_source,
            # §12: parked goals are shown but compete for nothing, so the
            # UI dims them rather than hiding them.
            "activation": g.activation,
            "deadline": g.deadline.isoformat() if g.deadline else None,
            "stakes": g.stakes,
            "status": g.status,
            # §12: a recurring commitment has a deadline every period, so the
            # UI needs the period to avoid reporting it as having none.
            "pace_mode": g.pace_mode,
            "reset_period_days": g.reset_period_days,
            "parent_id": g.parent_id,
            "area_id": g.area_id,
            # A nested goal's own children come first, then its milestones, so
            # the client walks one uniform "children" list at every level.
            "children": [goal_payload(c, depth + 1) for c in children]
            + by_goal.get(g.id or 0, []),
        }

    # Only unparented goals are roots. Previously every goal was emitted at the
    # top level, so a nested goal appeared as a second root and the edge to its
    # parent vanished without trace.
    roots = [
        goal_payload(g, 0)
        for g in goals
        if g.parent_id is None or g.parent_id == g.id or g.parent_id not in by_id
    ]

    # Anything a cycle or the depth cap left unreachable is surfaced as a root
    # rather than silently dropped. A mis-shaped graph must stay visible, or it
    # cannot be fixed.
    roots.extend(goal_payload(g, MAX_GOAL_DEPTH) for g in goals if (g.id or 0) not in emitted)

    return {
        "areas": [{"id": a.id, "name": a.name, "color": a.color} for a in areas],
        "goals": roots,
    }
