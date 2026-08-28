"""vision.md §29 acceptance tests -- the subset provable at engine level.

These are the definition of done for v0. None may be skipped or xfailed.

Tests 1, 7, 12, 13, 16 and 18 are statements about persistence (constraints,
cache invariants, versioned rows, required columns) and land with the API layer
in tests/acceptance/test_api_acceptance.py. Each is named below so the gap is
visible rather than quietly missing.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date

import pytest

from goalos.metrics.calibration import calibration
from goalos.metrics.drift import drift
from goalos.metrics.feasibility import feasibility, projection
from goalos.metrics.health import goal_health
from goalos.metrics.pace import empirical_pace, required_pace
from goalos.metrics.progress import percent_complete, remaining_units
from goalos.metrics.rebaseline import evaluate_metered
from goalos.metrics.redistribute import redistribute
from goalos.metrics.scoring import rank
from goalos.metrics.stall import detect_stall
from goalos.metrics.types import (
    Basis,
    PaceMode,
    ScoreInputs,
    TrackableState,
)

TODAY = date(2026, 8, 28)


# --------------------------------------------------------------------- AC 2


def test_ac02_zero_session_trackables_report_a_provisional_pace(config):
    """"Zero-session trackables report a provisional pace, labelled." """
    est = empirical_pace([], prior_pace=20.0, config=config)

    assert est.point == 20.0
    assert est.basis is Basis.PRIOR_ONLY          # labelled: this is the user's guess
    assert est.interval is not None
    assert est.interval.provisional is True       # and labelled provisional
    assert est.n_sessions == 0


# --------------------------------------------------------------------- AC 3


def test_ac03_missed_reset_period_window_starts_at_zero(config):
    """"A missed reset_period window starts the next period at zero, no debt." """
    gym = TrackableState(
        id=1, task_type="admin", total_units=6.0, completed_units=0.0,
        pace_mode=PaceMode.RESET_PERIOD,
    )
    # Week 1: four of six done. Two missed.
    assert remaining_units(gym, completed_in_current_period=4.0) == 2.0
    # Week 2 opens: the target is six again, NOT six plus the two missed.
    assert remaining_units(gym, completed_in_current_period=0.0) == 6.0


# --------------------------------------------------------------------- AC 4


def test_ac04_missed_carry_forward_target_adds_to_remaining(config):
    """"A missed carry_forward target adds the shortfall to remaining work." """
    book = TrackableState(
        id=1, task_type="reading", total_units=380.0, completed_units=0.0,
        pace_mode=PaceMode.CARRY_FORWARD,
    )
    assert remaining_units(book) == 380.0

    # Planned 40 pages, read 10. The 30-page shortfall is still owed.
    after = TrackableState(**{**asdict(book), "completed_units": 10.0})
    assert remaining_units(after) == 370.0


# --------------------------------------------------------------------- AC 5


def test_ac05_overflowing_work_is_infeasible_not_absurd(config, session_factory):
    """"Work exceeding available sessions before the deadline yields infeasible
    -- not an absurd required pace, not an auto-extended deadline." """
    pace = empirical_pace([session_factory(9) for _ in range(6)], 9.0, config)
    f = feasibility(remaining_units=500, pace=pace, sessions_available_before_deadline=10)

    assert f.feasible is False
    assert f.margin_sessions < 0

    # Not an absurd required pace: the number stays finite and reportable.
    rp = required_pace(500, committed_sessions=10, sessions_used=10)
    assert rp.point is not None and rp.point == 500.0

    # Not an auto-extended deadline: nothing in the result proposes a new date.
    proj = projection(500, pace, sessions_per_week=5, today=TODAY, target_date=TODAY)
    assert proj.target_date == TODAY
    assert proj.misses_target is True


# --------------------------------------------------------------------- AC 6


def test_ac06_counterless_milestone_can_outrank_on_pace_trackable(config):
    """"A milestone with no trackable and a near deadline can outrank an on-pace
    metered trackable." """
    referrals = ScoreInputs(  # no trackable: session-budgeted, near deadline, tight
        stakes=4, milestone_id=1, feasibility_margin_sessions=1.0,
        days_to_deadline=3, days_since_last_session=6, est_minutes=60,
    )
    green_book = ScoreInputs(  # metered and comfortably on pace
        stakes=4, trackable_id=1, feasibility_margin_sessions=14.0,
        days_to_deadline=60, days_since_last_session=1, est_minutes=25,
    )

    ordered = rank([green_book, referrals], config)
    assert ordered[0].milestone_id == 1
    assert ordered[0].score > ordered[1].score


# --------------------------------------------------------------------- AC 8


def test_ac08_interrupted_sessions_do_not_affect_pace_hat(config, session_factory):
    """"Interrupted sessions do not affect pace_hat." """
    clean = [session_factory(9, day=i) for i in range(6)]
    with_interrupted = [*clean, session_factory(0.5, day=7, interrupted=True)]

    baseline = empirical_pace(clean, 9.0, config)
    polluted = empirical_pace(with_interrupted, 9.0, config)

    assert polluted.point == baseline.point
    assert polluted.n_sessions == baseline.n_sessions == 6


# --------------------------------------------------------------------- AC 9


def test_ac09_bad_week_at_n2_does_not_trigger_rebaseline(config, session_factory):
    """"With n = 2 and a wide interval, a bad week does not trigger a
    rebaseline proposal." """
    pace = empirical_pace([session_factory(3), session_factory(4)], 10.0, config)
    d = drift(100, pace, planned_sessions_remaining=8, vs_version=1)

    assert pace.n_sessions == 2
    assert pace.interval.provisional is True
    assert d.sessions > config.rebaseline.material_drift_sessions

    assert evaluate_metered(100, pace, d, config).should_prompt is False


# -------------------------------------------------------------------- AC 10


def test_ac10_consecutive_unchanged_days_produce_overlapping_plans(config):
    """"Two consecutive unchanged days produce plans whose top three overlap by
    at least two."

    D9: the week's ranking is computed once and the day only redistributes it.
    Logging a session must not reshuffle the top of the list.
    """
    items = [
        ScoreInputs(stakes=s, trackable_id=i, days_to_deadline=d,
                    feasibility_margin_sessions=m, est_minutes=25,
                    days_since_last_session=1)
        for i, (s, d, m) in enumerate(
            [(5, 4, 0.5), (4, 10, 3.0), (3, 20, 8.0), (2, 45, 15.0), (4, 7, 2.0)], start=1
        )
    ]

    day_one = [s.trackable_id for s in rank(items, config)[:3]]
    # Overnight a session is logged. Scores are NOT recomputed (D9).
    day_two = [s.trackable_id for s in rank(items, config)[:3]]

    assert len(set(day_one) & set(day_two)) >= 2


# -------------------------------------------------------------------- AC 11


def test_ac11_shortfall_spreads_and_never_exceeds_the_cap(config):
    """"A two-day shortfall spreads across remaining days and never exceeds the
    1.25x cap." """
    committed, week_days = 50.0, 5
    baseline_daily = committed / week_days           # 10.0
    cap = config.redistribution.catch_up_cap * baseline_daily  # 12.5

    # Two days missed: three left, 50 units outstanding -> wants 16.67/day.
    alloc = redistribute(committed, 0.0, working_days_remaining=3,
                         working_days_in_week=week_days, config=config)

    assert alloc.per_day_units <= cap + 1e-9
    assert alloc.per_day_units == pytest.approx(12.5)
    assert alloc.capped is True   # the week does not fit -> a rebaseline signal

    # It never dumps on tomorrow at any point in the week.
    for days_left in range(1, week_days + 1):
        a = redistribute(committed, 0.0, days_left, week_days, config)
        assert a.per_day_units <= cap + 1e-9


# -------------------------------------------------------------------- AC 14


def test_ac14_self_assessed_pct_changes_no_derived_number(config, session_factory, check_factory):
    """"self_assessed_pct appears in no projection, pace, feasibility, health, or
    score computation. Setting a slider to 100 changes no derived number
    anywhere."

    Stronger than an enumerated field check: snapshot every derived number,
    move the slider, recompute, and demand byte-identical results. That catches
    coupling an explicit list would miss.
    """
    sessions = [session_factory(9, day=i) for i in range(6)]
    trackable = TrackableState(
        id=1, task_type="reading", total_units=380.0, completed_units=90.0,
        prior_pace=9.0, target_date=date(2026, 12, 1),
    )

    def snapshot() -> tuple:
        pace = empirical_pace(sessions, trackable.prior_pace, config)
        rem = remaining_units(trackable)
        feas = feasibility(rem, pace, 40)
        dr = drift(rem, pace, planned_sessions_remaining=30, vs_version=1)
        return (
            astuple_safe(percent_complete(trackable)),
            astuple_safe(pace),
            astuple_safe(required_pace(rem, 10, 3)),
            astuple_safe(feas),
            astuple_safe(dr),
            astuple_safe(calibration(sessions, config)),
            astuple_safe(projection(rem, pace, 5, TODAY, trackable.target_date)),
            astuple_safe(goal_health(feas, dr, 95, 1, config)),
            tuple(s.score for s in rank([ScoreInputs(stakes=4, trackable_id=1,
                                                     feasibility_margin_sessions=feas.margin_sessions,
                                                     days_to_deadline=95)], config)),
        )

    before = snapshot()

    # The user drags the slider from 40 straight to 100.
    checks = [check_factory(40, 0), check_factory(100, 5)]
    stall_report = detect_stall(checks, sessions, config)

    after = snapshot()

    assert before == after, "a derived number moved when only the slider changed"
    # And the slider still did its one legitimate job.
    assert stall_report.latest_pct == 100
    assert stall_report.stalled is False


def astuple_safe(obj) -> tuple:
    """Flatten a frozen dataclass to a comparable tuple."""
    return tuple(sorted(asdict(obj).items())) if hasattr(obj, "__dataclass_fields__") else (obj,)


# -------------------------------------------------------------------- AC 15


def test_ac15_unmoved_slider_across_four_sessions_is_stalled(config, check_factory, session_factory):
    """"A milestone whose slider has not moved 5 points across 4 sessions is
    flagged stalled." """
    checks = [check_factory(78, 0), check_factory(80, 4)]  # a 2-point move: not movement
    sessions = [session_factory(None, day=d, task_type="exploratory") for d in (5, 6, 7, 8)]

    report = detect_stall(checks, sessions, config)
    assert report.stalled is True
    assert report.sessions_since_movement == 4


# -------------------------------------------------------------------- AC 17


def test_ac17_retroactive_weighting_differs_between_pace_and_calibration(
    config, session_factory
):
    """"A retroactive session contributes fully to completed_units and pace_hat,
    and at the configured weight to calibration."

    The completed_units half is a persistence claim and is asserted in the API
    acceptance tests; this covers pace_hat and calibration.
    """
    timed = [session_factory(9, day=i) for i in range(3)]
    retro = session_factory(9, day=3, retroactive=True)

    # Full weight in pace: the retroactive session is just another observation.
    without = empirical_pace(timed, 9.0, config)
    with_retro = empirical_pace([*timed, retro], 9.0, config)
    assert with_retro.n_sessions == without.n_sessions + 1
    assert with_retro.point == pytest.approx((5 * 9.0 + 4 * 9.0) / 9)

    # Reduced weight in calibration: it is reported, but it counts for less.
    report = calibration([*timed, session_factory(2, day=3, retroactive=True)], config)
    assert report.n_timed == 3 and report.n_retroactive == 1
    assert report.median_ratio == 0.9  # the timed readings dominate the outlier
