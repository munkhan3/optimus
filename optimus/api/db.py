"""Engine and session management."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import Request
from sqlalchemy import Engine, event
from sqlalchemy.orm import with_loader_criteria
from sqlmodel import Session, create_engine

from .models import (
    Area,
    Baseline,
    Capacity,
    DailyPlan,
    DashboardLayout,
    Goal,
    GoalBudget,
    Milestone,
    OpenGap,
    PlanItem,
    ProgressCheckRow,
    SessionAllocation,
    Task,
    Trackable,
    WeeklyCommitment,
    WorkSession,
)
from .settings import get_settings

_engine: Engine | None = None
TENANT_MODELS = (
    Area, Goal, Milestone, Trackable, Task, Capacity, GoalBudget, WeeklyCommitment,
    SessionAllocation, WorkSession, ProgressCheckRow, Baseline, OpenGap, DailyPlan,
    PlanItem, DashboardLayout,
)


@event.listens_for(Session, "after_begin")
def set_tenant_context(session: Session, _transaction, connection) -> None:
    """Reapply the RLS identity after every commit starts a new transaction."""
    user_id = session.info.get("user_id")
    if user_id is not None and connection.dialect.name == "postgresql":
        connection.exec_driver_sql(f"SET LOCAL app.user_id = '{int(user_id)}'")


@event.listens_for(Session, "do_orm_execute")
def scope_orm_reads(execute_state) -> None:
    """Defence in depth for environments whose database role bypasses RLS."""
    user_id = execute_state.session.info.get("user_id")
    if user_id is None or not execute_state.is_select:
        return
    statement = execute_state.statement
    for model in TENANT_MODELS:
        statement = statement.options(
            with_loader_criteria(
                model,
                lambda entity: entity.user_id == user_id,
                include_aliases=True,
            )
        )
    execute_state.statement = statement


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(get_settings().database_url, pool_pre_ping=True)
    return _engine


@contextmanager
def open_session(user_id: int | None) -> Iterator[Session]:
    """A session carrying an RLS identity, not tied to a request's lifetime.

    The streaming assistant needs this. A dependency-provided session is closed
    when the route function returns, which for a StreamingResponse is *before*
    the generator has produced its body -- so the loop would be reading from a
    session that had already gone away.
    """
    with Session(get_engine()) as session:
        # PostgreSQL RLS policies use this transaction-local setting. Auth sets
        # it before a route opens its data session; public account endpoints
        # run without it and only touch the auth tables.
        if user_id is not None:
            session.info["user_id"] = user_id
            # Open the initial transaction with its RLS setting in place. The
            # after_begin listener above repeats this after endpoint commits.
            if get_engine().dialect.name == "postgresql":
                session.connection().exec_driver_sql(f"SET LOCAL app.user_id = '{int(user_id)}'")
        yield session


def get_session(request: Request) -> Iterator[Session]:
    with open_session(getattr(request.state, "user_id", None)) as session:
        yield session


# The authoritative value of trackable.completed_units is SUM(actual_output)
# over its sessions (§21), and secondary_completed_units is SUM(secondary_output)
# on the same terms. Keeping the caches correct in application code means every
# future write path must remember to; a trigger means none of them can forget.
# AC7 asserts the invariant, and this is what makes it unfalsifiable.
#
# ONE function maintains both. Two triggers would be two things to keep in step,
# and the second would eventually be forgotten in exactly the branch that matters
# -- the one below, where a session moves between trackables.
COMPLETED_UNITS_TRIGGER = """
CREATE OR REPLACE FUNCTION refresh_completed_units() RETURNS TRIGGER AS $$
DECLARE
    affected BIGINT;
BEGIN
    affected := COALESCE(NEW.trackable_id, OLD.trackable_id);
    IF affected IS NOT NULL THEN
        UPDATE trackable
           SET completed_units = COALESCE(
                   (SELECT SUM(actual_output)
                      FROM work_session
                     WHERE trackable_id = affected
                       AND actual_output IS NOT NULL), 0),
               secondary_completed_units = COALESCE(
                   (SELECT SUM(secondary_output)
                      FROM work_session
                     WHERE trackable_id = affected
                       AND secondary_output IS NOT NULL), 0)
         WHERE id = affected;
    END IF;

    -- A session moved between trackables: refresh the one it left, too.
    IF TG_OP = 'UPDATE'
       AND OLD.trackable_id IS DISTINCT FROM NEW.trackable_id
       AND OLD.trackable_id IS NOT NULL THEN
        UPDATE trackable
           SET completed_units = COALESCE(
                   (SELECT SUM(actual_output)
                      FROM work_session
                     WHERE trackable_id = OLD.trackable_id
                       AND actual_output IS NOT NULL), 0),
               secondary_completed_units = COALESCE(
                   (SELECT SUM(secondary_output)
                      FROM work_session
                     WHERE trackable_id = OLD.trackable_id
                       AND secondary_output IS NOT NULL), 0)
         WHERE id = OLD.trackable_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_session_completed_units
AFTER INSERT OR UPDATE OR DELETE ON work_session
FOR EACH ROW EXECUTE FUNCTION refresh_completed_units();
"""

DROP_COMPLETED_UNITS_TRIGGER = """
DROP TRIGGER IF EXISTS work_session_completed_units ON work_session;
DROP FUNCTION IF EXISTS refresh_completed_units();
"""
