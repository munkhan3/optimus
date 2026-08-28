"""§24.3 empirical pace and §24.2 required pace."""

from __future__ import annotations

from goalos.metrics.pace import empirical_pace, required_pace
from goalos.metrics.types import Basis


def test_no_prior_no_sessions_is_unavailable_not_zero(config):
    """P2: absent is not zero. A confident wrong number is worse than none."""
    est = empirical_pace([], prior_pace=None, config=config)
    assert est.point is None
    assert est.basis is Basis.UNAVAILABLE
    assert not est.is_usable


def test_prior_only_when_no_sessions(config):
    est = empirical_pace([], prior_pace=20.0, config=config)
    assert est.point == 20.0
    assert est.basis is Basis.PRIOR_ONLY
    assert est.n_sessions == 0


def test_shrinkage_pulls_optimistic_prior_toward_observation(config, session_factory):
    """The doc's own scenario: believes 20 pages/session, actually reads ~9."""
    sessions = [session_factory(x) for x in (9, 8, 11, 9, 10, 7)]
    est = empirical_pace(sessions, prior_pace=20.0, config=config)

    assert est.basis is Basis.SHRUNK
    assert est.observed_mean == 9.0
    # kappa=5, n=6 -> (5*20 + 6*9) / 11
    assert est.point == (5 * 20.0 + 6 * 9.0) / 11
    # Strictly between the prior and the observation, and heading the right way.
    assert 9.0 < est.point < 20.0


def test_shrinkage_converges_to_observation_as_n_grows(config, session_factory):
    few = empirical_pace([session_factory(9) for _ in range(3)], 20.0, config)
    many = empirical_pace([session_factory(9) for _ in range(60)], 20.0, config)
    assert abs(many.point - 9.0) < abs(few.point - 9.0)


def test_observations_stand_alone_without_a_prior(config, session_factory):
    est = empirical_pace([session_factory(x) for x in (8, 10)], None, config)
    assert est.basis is Basis.OBSERVED
    assert est.point == 9.0


def test_sessions_without_output_are_not_observations(config, session_factory):
    """An open or exploratory session carries no count; it must not read as zero."""
    est = empirical_pace([session_factory(None), session_factory(None)], 12.0, config)
    assert est.n_sessions == 0
    assert est.basis is Basis.PRIOR_ONLY
    assert est.point == 12.0


def test_required_pace_is_finite_when_sessions_are_exhausted(config):
    """§24.2 uses max(remaining, 1); feasibility, not pace, is allowed to say no."""
    rp = required_pace(remaining_units=80, committed_sessions=5, sessions_used=5)
    assert rp.remaining_sessions == 0
    assert rp.point == 80.0


def test_required_pace_denominator_is_the_commitment(config):
    rp = required_pace(remaining_units=120, committed_sessions=10, sessions_used=3)
    assert rp.remaining_sessions == 7
    assert rp.point == 120 / 7
    assert rp.denominator_source == "weekly_commitment"
