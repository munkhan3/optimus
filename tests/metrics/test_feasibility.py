"""§24.6 feasibility, §24.7 projection, and the session-budget variant."""

from __future__ import annotations

from datetime import date

from optimus.metrics.feasibility import (
    feasibility,
    feasibility_from_session_budget,
    projection,
)
from optimus.metrics.pace import empirical_pace
from optimus.metrics.types import Basis, PaceEstimate

TODAY = date(2026, 8, 28)


def _pace(config, session_factory, outputs=(9, 8, 11, 9, 10, 7)):
    return empirical_pace([session_factory(x) for x in outputs], 9.0, config)


def test_work_that_does_not_fit_is_infeasible(config, session_factory):
    f = feasibility(500, _pace(config, session_factory), 10)
    assert f.feasible is False
    assert "INFEASIBLE" in f.reason
    assert f.margin_sessions < 0


def test_comfortable_work_is_feasible_with_a_stated_margin(config, session_factory):
    f = feasibility(50, _pace(config, session_factory), 20)
    assert f.feasible is True
    assert f.margin_sessions > 0


def test_unknown_pace_is_undetermined_not_feasible(config):
    """None must never be mistaken for a pass."""
    f = feasibility(100, PaceEstimate(point=None, basis=Basis.UNAVAILABLE), 10)
    assert f.feasible is None
    assert f.margin_sessions is None


def test_missing_capacity_is_undetermined(config, session_factory):
    f = feasibility(100, _pace(config, session_factory), None)
    assert f.feasible is None
    assert f.sessions_needed is not None  # the need is known; the fit is not


def test_finished_work_is_trivially_feasible(config, session_factory):
    assert feasibility(0, _pace(config, session_factory), 5).feasible is True


def test_session_budgeted_work_is_scored_on_the_same_question(config):
    """§10: never force a number where none exists. Budget in sessions instead."""
    assert feasibility_from_session_budget(8, 20).feasible is True
    tight = feasibility_from_session_budget(30, 10)
    assert tight.feasible is False and "INFEASIBLE" in tight.reason
    assert feasibility_from_session_budget(5, None).feasible is None


def test_projection_is_a_range_never_a_single_date(config, session_factory):
    p = projection(100, _pace(config, session_factory), sessions_per_week=5, today=TODAY)
    assert p.earliest is not None and p.latest is not None
    assert p.earliest <= p.latest


def test_provisional_pace_yields_a_provisional_projection(config, session_factory):
    """Two sessions in, the range must announce that it is not yet trustworthy."""
    p = projection(100, _pace(config, session_factory, (9, 10)), 5, TODAY)
    assert p.provisional is True


def test_projection_flags_a_missed_target(config, session_factory):
    p = projection(
        400, _pace(config, session_factory), 3, TODAY, target_date=date(2026, 9, 1)
    )
    assert p.misses_target is True


def test_projection_without_usable_pace_returns_no_dates(config):
    p = projection(100, PaceEstimate(None, Basis.UNAVAILABLE), 5, TODAY)
    assert p.earliest is None and p.latest is None and p.provisional is True
