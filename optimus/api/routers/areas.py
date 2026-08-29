"""Areas of life: the taxonomy the goal graph is read through.

An area is deliberately thin. It has a name and nothing else that plans -- no
definition of done, no deadline, no stakes -- because it is a way of grouping
goals, not a thing you can finish. That is what separates it from a Vision
(§9), which sits inside the planning model and does carry all of those.

Deleting an area therefore cannot delete work: the foreign key is ON DELETE SET
NULL, so its goals survive and simply become unfiled.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..auth import get_user_session as get_session
from ..models import Area, Goal
from ..schemas import AreaCreate, AreaUpdate

router = APIRouter(prefix="/api/areas", tags=["areas"])


def _payload(area: Area, goal_count: int) -> dict:
    return {
        "id": area.id,
        "name": area.name,
        "color": area.color,
        "created_at": area.created_at,
        # The UI needs this to size a cluster before it has fetched the tree.
        "goal_count": goal_count,
    }


def _counts(db: Session) -> dict[int, int]:
    """Goals per area, for every area visible to this account."""
    counts: dict[int, int] = {}
    for goal in db.exec(select(Goal)).all():
        if goal.area_id is not None:
            counts[goal.area_id] = counts.get(goal.area_id, 0) + 1
    return counts


@router.get("")
def list_areas(db: Session = Depends(get_session)) -> list[dict]:
    """Ordered by id, because colour is assigned from this order.

    Sorting by name would repaint the whole map the moment an area is renamed.
    """
    counts = _counts(db)
    return [
        _payload(a, counts.get(a.id or 0, 0))
        for a in db.exec(select(Area).order_by(Area.id)).all()
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_area(body: AreaCreate, db: Session = Depends(get_session)) -> dict:
    area = Area(name=body.name.strip(), color=body.color)
    db.add(area)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"You already have an area called {body.name!r}.")
    db.refresh(area)
    return _payload(area, 0)


@router.patch("/{area_id}")
def update_area(area_id: int, body: AreaUpdate, db: Session = Depends(get_session)) -> dict:
    area = db.get(Area, area_id)
    if area is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"area {area_id} not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(area, field, value.strip() if field == "name" and value else value)
    db.add(area)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have an area with that name.")
    db.refresh(area)
    return _payload(area, _counts(db).get(area_id, 0))


@router.delete("/{area_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_area(area_id: int, db: Session = Depends(get_session)) -> None:
    """The goals inside are un-filed, not removed -- see the module docstring."""
    area = db.get(Area, area_id)
    if area is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"area {area_id} not found")
    db.delete(area)
    db.commit()
