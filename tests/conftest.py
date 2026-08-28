"""Shared fixtures. Deliberately small -- the metrics engine needs no database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from goalos.metrics.config import MetricsConfig
from goalos.metrics.types import ProgressCheck, SessionObs

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
    ) -> SessionObs:
        return SessionObs(
            task_type=task_type,
            started_at=EPOCH + timedelta(days=day),
            actual_output=actual,
            expected_output=expected,
            interrupted=interrupted,
            entered_retroactively=retroactive,
            intent_met=intent_met,
        )

    return make


@pytest.fixture
def check_factory():
    def make(pct: float, day: int) -> ProgressCheck:
        return ProgressCheck(self_assessed_pct=pct, recorded_at=EPOCH + timedelta(days=day))

    return make
