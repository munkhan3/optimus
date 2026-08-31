"""§24.3 empirical pace and §24.2 required pace."""

from __future__ import annotations

from optimus.metrics.pace import empirical_pace, pace_scores, required_pace
from optimus.metrics.types import Basis


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


# ------------------------------------------------- §36.1 reversed: any length


def test_equal_rates_at_different_durations_contribute_equally(config, session_factory):
    """The point of normalizing. 34 pages in 50 minutes is the same rate as 17 in
    25 and 6.8 in 10, and pace must not read the session LENGTH as speed."""
    varied = empirical_pace(
        [
            session_factory(34, minutes=50),
            session_factory(17, minutes=25),
            session_factory(6.8, minutes=10),
        ],
        prior_pace=None,
        config=config,
    )
    assert varied.n_sessions == 3
    assert varied.point == 17.0
    # Identical observations leave no spread to mistake for uncertainty.
    assert varied.observed_mean == 17.0


def test_a_long_session_is_not_reported_as_a_fast_one(config, session_factory):
    """Without normalization this is the failure: two hours of work reads as a
    burst of speed, and §25.4 would eventually act on the invented spread."""
    raw = empirical_pace([session_factory(34, minutes=50)], None, config)
    assert raw.point == 17.0


def test_per_minute_rate_is_reported_alongside(config, session_factory):
    est = empirical_pace([session_factory(17, minutes=25)], None, config)
    assert est.point_per_minute == 17.0 / config.session.minutes


def test_an_uncredible_clock_falls_back_to_the_planned_length(config, session_factory):
    """A session logged start-to-end in seconds has a duration, not a
    measurement. Dividing by it would imply thousands of pages per session, so
    the planned length stands in -- and the session is NOT discarded, because
    the pages were still read (§23.5)."""
    est = empirical_pace(
        [session_factory(9, minutes=0.002, planned=25)], None, config
    )
    assert est.n_sessions == 1
    assert est.point == 9.0


def test_uncredible_clock_uses_planned_length_not_the_standard_one(config, session_factory):
    """A 50-minute session with an unusable clock is one long session. Crediting
    its whole output to a 25-minute standard would report double the real rate."""
    est = empirical_pace(
        [session_factory(34, minutes=0.001, planned=50)], None, config
    )
    assert est.point == 17.0


def test_a_session_with_no_duration_at_all_is_still_counted(config, session_factory):
    """Rows written before the timer became adjustable carry neither length."""
    est = empirical_pace([session_factory(9)], None, config)
    assert est.n_sessions == 1
    assert est.point == 9.0


def test_interrupted_sessions_are_still_excluded_at_any_length(config, session_factory):
    """AC8 must survive normalization -- an interrupted session measures the
    interruption whatever the clock says."""
    est = empirical_pace(
        [session_factory(34, minutes=50), session_factory(2, minutes=50, interrupted=True)],
        None,
        config,
    )
    assert est.n_sessions == 1
    assert est.point == 17.0


# ------------------------------------------------------------- the two scores


def test_the_two_scores_answer_different_questions(config, session_factory):
    """A trackable worked at exactly the usual speed for its task_type scores 1.0
    on pace, while still being behind the plan. Collapsing these into one number
    would report slow work when the finding is an optimistic plan (D6)."""

    pooled = empirical_pace([session_factory(10, minutes=25) for _ in range(6)], None, config)
    own = empirical_pace([session_factory(10, minutes=25) for _ in range(6)], None, config)
    req = required_pace(remaining_units=100.0, committed_sessions=5, sessions_used=0)

    scores = pace_scores(own, pooled, req)
    assert scores.pace == 1.0            # working at your usual speed
    assert scores.track == 0.5           # and needing twice that to hit the plan


def test_a_slower_book_scores_below_one(config, session_factory):

    pooled = empirical_pace([session_factory(20, minutes=25) for _ in range(6)], None, config)
    own = empirical_pace([session_factory(10, minutes=25) for _ in range(6)], None, config)
    assert pace_scores(own, pooled, None).pace == 0.5


def test_a_score_with_no_denominator_is_absent_not_one(config, session_factory):
    """P2. 1.0 must mean measured parity, never "no data" -- otherwise an
    untouched trackable reads as perfectly on track."""

    empty = empirical_pace([], None, config)
    scores = pace_scores(empty, empty, None)
    assert scores.pace is None
    assert scores.track is None
    assert scores.pace_calculation.note
    assert scores.track_calculation.note


def test_every_score_carries_its_own_terms(config, session_factory):
    """P3: the UI renders the disclosure from these, so it cannot drift out of
    agreement with the code that produced the number."""

    pooled = empirical_pace([session_factory(10, minutes=25) for _ in range(6)], None, config)
    scores = pace_scores(pooled, pooled, required_pace(50.0, 5, 0))
    assert scores.pace_calculation.result == scores.pace
    assert scores.track_calculation.result == scores.track
    assert dict(scores.track_calculation.terms)["required_pace"] == 10.0
