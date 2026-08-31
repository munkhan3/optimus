"""Shared fixtures.

The database fixtures live in tests/db_fixtures.py and are registered here as a
plugin (pytest only permits pytest_plugins in the root conftest). They are
opt-in rather than autouse, so the pure metrics tests still run with no
database and no migration -- which is the point of keeping the engine pure.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from optimus.metrics.config import MetricsConfig
from optimus.metrics.types import ProgressCheck, SessionObs

# pytest only permits this in the root conftest.
pytest_plugins = ["tests.db_fixtures"]

REPO_ROOT = Path(__file__).resolve().parents[1]
# §21: timestamps are UTC. Aware datetimes here keep the tests honest about
# a comparison the engine performs (stall detection orders checks against
# sessions), which naive datetimes would let drift silently.
EPOCH = datetime(2026, 8, 1, 9, 0, 0, tzinfo=UTC)


@pytest.fixture(scope="session")
def config() -> MetricsConfig:
    """The real config.toml, not a hand-built object.

    Tests read the shipped file so that changing a constant there and breaking an
    acceptance guarantee shows up as a test failure rather than a surprise in
    production.
    """
    return MetricsConfig.from_toml(REPO_ROOT / "config.toml")


@pytest.fixture
def session_factory():
    def make(
        actual: float | None,
        *,
        expected: float | None = 10.0,
        day: int = 0,
        task_type: str = "reading",
        interrupted: bool = False,
        retroactive: bool = False,
        intent_met: bool | None = None,
        minutes: float | None = None,
        planned: float | None = None,
    ) -> SessionObs:
        return SessionObs(
            task_type=task_type,
            started_at=EPOCH + timedelta(days=day),
            actual_output=actual,
            expected_output=expected,
            interrupted=interrupted,
            entered_retroactively=retroactive,
            intent_met=intent_met,
            actual_minutes=minutes,
            planned_minutes=planned,
        )

    return make


@pytest.fixture
def check_factory():
    def make(pct: float, day: int) -> ProgressCheck:
        return ProgressCheck(self_assessed_pct=pct, recorded_at=EPOCH + timedelta(days=day))

    return make
