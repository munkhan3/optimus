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

from ..db import get_session
from ..models import Goal, Milestone, Trackable

router = APIRouter(prefix="/api/tree", tags=["tree"])


@router.get("")
def get_tree(db: Session = Depends(get_session)) -> dict:
    """Three queries, assembled in memory. No per-node round trips."""
    goals = db.exec(select(Goal).order_by(Goal.created_at)).all()
    milestones = db.exec(select(Milestone).order_by(Milestone.created_at)).all()
    trackables = db.exec(select(Trackable).order_by(Trackable.created_at)).all()

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

    return {
        "goals": [
            {
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
                "children": by_goal.get(g.id or 0, []),
            }
            for g in goals
        ]
    }
