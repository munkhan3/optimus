"""§24.9 stall detection."""

from __future__ import annotations

from goalos.metrics.stall import detect_stall


def _sessions(days, session_factory):
    return [session_factory(None, day=d, task_type="exploratory") for d in days]


def test_the_documented_plateau_is_flagged(config, check_factory, session_factory):
    """The doc's own series: 40 -> 60 -> 75 -> 80 -> 80 -> 80."""
    checks = [check_factory(p, d) for d, p in [(0, 40), (2, 60), (4, 75), (6, 80), (8, 80), (10, 80)]]
    report = detect_stall(checks, _sessions([7, 9, 11, 13], session_factory), config)

    assert report.stalled is True
    assert report.sessions_since_movement == 4
    assert report.series == (40, 60, 75, 80, 80, 80)  # the story, not just a verdict


def test_below_the_threshold_is_not_a_stall(config, check_factory, session_factory):
    checks = [check_factory(p, d) for d, p in [(0, 40), (6, 80), (8, 80)]]
    assert detect_stall(checks, _sessions([7, 9, 11], session_factory), config).stalled is False


def test_completed_work_is_never_stalled(config, check_factory, session_factory):
    checks = [check_factory(p, d) for d, p in [(0, 40), (6, 100)]]
    report = detect_stall(checks, _sessions([7, 9, 11, 13], session_factory), config)
    assert report.stalled is False
    assert report.latest_pct == 100


def test_movement_resets_the_count(config, check_factory, session_factory):
    checks = [check_factory(p, d) for d, p in [(0, 40), (2, 80), (12, 90)]]
    report = detect_stall(checks, _sessions([13, 14], session_factory), config)
    assert report.sessions_since_movement == 2
    assert report.stalled is False


def test_a_downward_revision_counts_as_movement(config, check_factory, session_factory):
    """§36.5: a downward move is the most informative signal the slider produces."""
    checks = [check_factory(p, d) for d, p in [(0, 80), (10, 60)]]
    report = detect_stall(checks, _sessions([11, 12, 13, 14], session_factory), config)
    assert report.sessions_since_movement == 4
    # Movement was registered at day 10, so the four sessions since are the count.
    assert report.series == (80, 60)


def test_no_checks_means_no_evidence_either_way(config, session_factory):
    assert detect_stall([], _sessions([1, 2, 3, 4, 5], session_factory), config).stalled is False


def test_sessions_before_the_last_movement_do_not_count(config, check_factory, session_factory):
    checks = [check_factory(p, d) for d, p in [(0, 40), (10, 80)]]
    report = detect_stall(checks, _sessions([1, 2, 3, 4, 5], session_factory), config)
    assert report.sessions_since_movement == 0
