"""The goal graph. Definition of done is the root primitive (§10).

D1: a goal cannot be activated without a verifiable definition of done and a
deadline. The database enforces this too, but rejecting it here produces a
message the user can act on rather than a constraint-violation traceback.

The requirement is verifiability, not numeracy. "MVP done: a stranger can sign
up, build a goal tree, and log a session without help" is a perfectly good
definition of done. Forcing a number where none exists is the single most
damaging thing this system can do (§10).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..db import get_session
from ..models import Goal, Milestone
from ..repo.write_rules import check_activation
from ..schemas import GoalCreate, GoalUpdate, MilestoneCreate

router = APIRouter(prefix="/api", tags=["goals"])


@router.post("/goals", status_code=status.HTTP_201_CREATED)
def create_goal(body: GoalCreate, db: Session = Depends(get_session)) -> dict:
    goal = Goal(**body.model_dump())
    check_activation(goal)
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return goal.model_dump()


@router.get("/goals")
def list_goals(db: Session = Depends(get_session)) -> list[dict]:
    return [g.model_dump() for g in db.exec(select(Goal).order_by(Goal.created_at)).all()]


@router.patch("/goals/{goal_id}")
def update_goal(goal_id: int, body: GoalUpdate, db: Session = Depends(get_session)) -> dict:
    goal = db.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(404, f"goal {goal_id} not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(goal, field, value)
    check_activation(goal)
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return goal.model_dump()


@router.post("/milestones", status_code=status.HTTP_201_CREATED)
def create_milestone(body: MilestoneCreate, db: Session = Depends(get_session)) -> dict:
    if db.get(Goal, body.goal_id) is None:
        raise HTTPException(404, f"goal {body.goal_id} not found")
    milestone = Milestone(**body.model_dump())
    db.add(milestone)
    db.commit()
    db.refresh(milestone)
    return milestone.model_dump()


@router.get("/milestones")
def list_milestones(
    goal_id: int | None = None, db: Session = Depends(get_session)
) -> list[dict]:
    stmt = select(Milestone).order_by(Milestone.created_at)
    if goal_id is not None:
        stmt = stmt.where(Milestone.goal_id == goal_id)
    return [m.model_dump() for m in db.exec(stmt).all()]
