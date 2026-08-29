"""Database-backed test fixtures, shared by tests/api and tests/acceptance.

Loaded as a pytest plugin from each directory's conftest rather than living in
one, so the pure metrics tests never pay for a migration they do not need.

Runs against a real Postgres database rather than SQLite, because several
acceptance guarantees are enforced *by Postgres*: the completed_units trigger
(AC7), the partial unique indexes on baseline (AC12), and the JSONB check on
score_breakdown (AC13). Testing those against a different engine would test
nothing.

Migrations are applied with Alembic, so the tests exercise the same DDL that
ships rather than a parallel create_all path that could drift from it.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

TEST_DB_URL = os.environ.get(
    "OPTIMUS_TEST_DATABASE_URL", "postgresql+psycopg://localhost/optimus_test"
)
TEST_TOKEN = "test-token"

TABLES = (
    "auth_session", "app_user",
    "plan_item", "daily_plan", "progress_check", "work_session",
    "weekly_commitment", "baseline", "open_gap", "task", "trackable",
    "milestone", "goal_budget", "capacity", "goal",
)


@pytest.fixture(scope="session")
def _env() -> Iterator[None]:
    os.environ["OPTIMUS_DATABASE_URL"] = TEST_DB_URL
    os.environ["OPTIMUS_AUTH_TOKEN"] = TEST_TOKEN
    # Settings and the engine are cached, so they must be built after the
    # environment is set or the tests would talk to the development database.
    from optimus.api import db, settings

    settings.get_settings.cache_clear()
    settings.get_metrics_config.cache_clear()
    db._engine = None
    yield


@pytest.fixture(scope="session")
def _migrated(_env) -> Iterator[None]:
    """Rebuild the test schema from scratch, then migrate up.

    Dropping the schema rather than running `downgrade base` makes this robust
    to a stale alembic_version left behind by a migration that was amended or
    removed -- which happens routinely while the schema is still churning.
    """
    from alembic import command
    from alembic.config import Config

    from optimus.api.db import get_engine

    with get_engine().begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    command.upgrade(Config("alembic.ini"), "head")
    yield


@pytest.fixture
def db_session(_clean) -> Iterator:
    from sqlmodel import Session

    from optimus.api.db import get_engine

    with Session(get_engine()) as session:
        yield session


@pytest.fixture
def _clean(_migrated) -> Iterator[None]:
    """Each test starts from an empty database and identity counters at 1."""
    from optimus.api.db import get_engine

    with get_engine().begin() as conn:
        conn.execute(
            text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE")
        )
    from optimus.api.auth import reset_legacy_bridge

    reset_legacy_bridge()
    yield


@pytest.fixture
def client(_clean) -> Iterator[TestClient]:
    from optimus.api.main import app

    with TestClient(app) as c:
        c.headers.update({"Authorization": f"Bearer {TEST_TOKEN}"})
        yield c


@pytest.fixture
def seeded(client: TestClient) -> dict:
    """A goal -> milestone -> trackable -> baseline chain, plus declared capacity."""
    goal = client.post("/api/goals", json={
        "title": "Q1 quant offer", "kind": "goal",
        "definition_of_done": "Signed offer in Chicago",
        "activation": "active", "deadline": "2027-02-01", "stakes": 5,
    }).json()
    milestone = client.post("/api/milestones", json={
        "goal_id": goal["id"], "title": "Finish the Green Book",
        "definition_of_done": "All 380 pages read",
    }).json()
    trackable = client.post("/api/trackables", json={
        "milestone_id": milestone["id"], "title": "Green Book", "unit": "pages",
        "total_units": 380, "total_units_source": "user_supplied",
        "task_type": "reading", "prior_pace": 20, "target_date": "2026-12-01",
    }).json()["trackable"]
    baseline = client.post("/api/baselines", json={
        "trackable_id": trackable["id"], "planned_sessions": 20,
        "target_date": "2026-12-01", "scope_units": 380,
    }).json()
    return {
        "goal": goal, "milestone": milestone,
        "trackable": trackable, "baseline": baseline,
    }


def log_session(client: TestClient, trackable_id: int, output: float, **kw) -> dict:
    """Start and immediately end a session -- the two-tap path from §23."""
    started = client.post("/api/sessions/start", json={"trackable_id": trackable_id}).json()
    return client.post(
        f"/api/sessions/{started['id']}/end", json={"actual_output": output, **kw}
    ).json()
