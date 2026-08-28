"""§24.4 drift and §24.8 goal health."""

from __future__ import annotations

from datetime import date

from goalos.metrics.drift import drift, drift_against_all
from goalos.metrics.health import goal_health
from goalos.metrics.pace import empirical_pace
from goalos.metrics.types import BaselineState, Basis, Drift, Feasibility, PaceEstimate


def _pace(config, session_factory, outputs=(9, 9, 9, 9, 9, 9)):
    return empirical_pace([session_factory(x) for x in outputs], 9.0, config)


def test_behind_plan_is_positive_drift(config, session_factory):
    d = drift(90, _pace(config, session_factory), planned_sessions_remaining=5, vs_version=1)
    assert d.projected_sessions_needed == 10.0
    assert d.sessions == 5.0


def test_ahead_of_plan_is_negative_drift(config, session_factory):
    d = drift(18, _pace(config, session_factory), planned_sessions_remaining=5, vs_version=1)
    assert d.sessions == -3.0


def test_unusable_pace_gives_unknown_drift_not_zero(config):
    d = drift(100, PaceEstimate(None, Basis.UNAVAILABLE), 5, 1)
    assert d.sessions is None


def test_drift_is_reported_against_version_one_as_well(config, session_factory):
    """§25.3: cumulative slip is invisible if each rebaseline resets the reference."""
    baselines = [
        BaselineState(version=1, planned_sessions=10, target_date=date(2026, 10, 1)),
        BaselineState(version=2, planned_sessions=20, target_date=date(2026, 11, 1)),
        BaselineState(version=3, planned_sessions=30, target_date=date(2026, 12, 1)),
    ]
    current, original = drift_against_all(
        180, _pace(config, session_factory), baselines, sessions_used=0
    )
    assert current.vs_version == 3
    assert original.vs_version == 1
    # 20 sessions needed: comfortable against v3's 30, badly behind v1's 10.
    assert current.sessions == -10.0
    assert original.sessions == 10.0


def test_no_baselines_yields_no_drift(config, session_factory):
    assert drift_against_all(100, _pace(config, session_factory), [], 0) == (None, None)


def test_health_components_are_always_present(config):
    h = goal_health(Feasibility(True, 5.0, 20, 15.0, "ok"), Drift(-1.0, 1, 5, 6), 25, 1, config)
    assert [c.name for c in h.components] == [
        "feasibility_margin",
        "drift",
        "days_to_deadline",
        "days_since_last_session",
    ]


def test_infeasible_goal_is_unhealthy(config):
    sick = goal_health(
        Feasibility(False, 55.0, 10, -45.0, "INFEASIBLE"), Drift(8.0, 1, 14, 6), 3, 12, config
    )
    healthy = goal_health(
        Feasibility(True, 5.0, 20, 15.0, "ok"), Drift(-1.0, 1, 5, 6), 25, 1, config
    )
    assert sick.score < 0.2 < healthy.score
    assert sick.components[0].note == "INFEASIBLE"


def test_feasibility_dominates_health(config):
    """D6: pace ratio is not a term, and feasibility outweighs everything else."""
    assert config.health.w_feasibility > max(
        config.health.w_drift, config.health.w_deadline, config.health.w_recency
    )


def test_health_is_unknown_when_nothing_is_known(config):
    h = goal_health(Feasibility(None, None, None, None, "?"), None, None, None, config)
    assert h.score is None
    assert len(h.components) == 4  # still enumerated, so the UI can say why
