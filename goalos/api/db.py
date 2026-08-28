"""Engine and session management."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import Engine
from sqlmodel import Session, create_engine

from .settings import get_settings

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(get_settings().database_url, pool_pre_ping=True)
    return _engine


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


# The authoritative value of trackable.completed_units is SUM(actual_output)
# over its sessions (§21). Keeping the cache correct in application code means
# every future write path must remember to; a trigger means none of them can
# forget. AC7 asserts the invariant, and this is what makes it unfalsifiable.
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
                       AND actual_output IS NOT NULL), 0)
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
                       AND actual_output IS NOT NULL), 0)
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
