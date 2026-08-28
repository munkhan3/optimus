"""§24.5 calibration and the weighted median it rests on."""

from __future__ import annotations

from goalos.metrics.calibration import calibration, weighted_median


def test_weighted_median_matches_plain_median_at_equal_weights():
    assert weighted_median([(1, 1), (2, 1), (3, 1)]) == 2
    assert weighted_median([(1, 1), (2, 1), (3, 1), (4, 1)]) == 2.5


def test_weighted_median_of_nothing_is_none():
    assert weighted_median([]) is None
    assert weighted_median([(5.0, 0.0)]) is None


def test_weighted_median_respects_weights():
    # One heavy low value outweighs two light high ones.
    assert weighted_median([(1.0, 10.0), (9.0, 1.0), (9.5, 1.0)]) == 1.0


def test_persistent_overestimation_shows_as_ratio_below_one(config, session_factory):
    report = calibration([session_factory(7, expected=10, day=i) for i in range(6)], config)
    assert report.median_ratio == 0.7
    assert report.n_total == 6


def test_zero_expectation_is_skipped_rather_than_dividing(config, session_factory):
    report = calibration([session_factory(5, expected=0, day=0)], config)
    assert report.n_total == 0
    assert report.median_ratio is None


def test_interrupted_sessions_are_excluded(config, session_factory):
    """An interruption measures the interruption, not the user's optimism."""
    clean = [session_factory(7, day=i) for i in range(5)]
    report = calibration([*clean, session_factory(0.1, day=9, interrupted=True)], config)
    assert report.n_total == 5
    assert report.median_ratio == 0.7


def test_timed_and_retroactive_distributions_are_reported_separately(config, session_factory):
    """D13: the 0.5 weight is a placeholder; keeping the split lets it be measured."""
    sessions = [session_factory(10, day=0), session_factory(2, day=1, retroactive=True)]
    report = calibration(sessions, config)
    assert report.timed_ratios == (1.0,)
    assert report.retroactive_ratios == (0.2,)
    assert report.n_timed == 1 and report.n_retroactive == 1


def test_retroactive_sessions_carry_less_weight(config, session_factory):
    """Same counts, different provenance -> the timed reading dominates."""
    timed_heavy = [session_factory(10, day=i) for i in range(3)] + [
        session_factory(2, day=i + 3, retroactive=True) for i in range(2)
    ]
    assert calibration(timed_heavy, config).median_ratio == 1.0


def test_window_drops_stale_history(config, session_factory):
    """Old bad estimates stop dragging on the current picture."""
    window = config.calibration.rolling_window_sessions
    old = [session_factory(1, day=i) for i in range(5)]                       # ratio 0.1
    recent = [session_factory(10, day=100 + i) for i in range(window)]        # ratio 1.0
    report = calibration([*old, *recent], config)
    assert report.n_total == window
    assert report.median_ratio == 1.0
