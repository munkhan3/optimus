"""The second axis: work done, as distinct from progress made.

The scenario throughout is the one that motivated this: an interview book
tracked by pages, where some pages are prose and some hold hour-long problems.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from optimus.metrics.productivity import (
    density_fit,
    series_stability,
    session_productivity,
)
from optimus.metrics.types import Basis, SessionObs

EPOCH = datetime(2026, 8, 1, 9, 0, 0, tzinfo=UTC)

# Ground truth for the synthetic histories: a page of prose costs 1.2 minutes,
# a problem costs 6.0. One problem therefore displaces 5 pages of reading.
ALPHA, BETA = 1.2, 6.0


def obs(pages, problems, *, day=0, minutes=None, interrupted=False, task_type="reading"):
    return SessionObs(
        task_type=task_type,
        started_at=EPOCH + timedelta(days=day),
        actual_output=pages,
        secondary_output=problems,
        actual_minutes=(
            minutes if minutes is not None else ALPHA * pages + BETA * (problems or 0)
        ),
        planned_minutes=25,
        interrupted=interrupted,
    )


def history(plan):
    return [obs(g, p, day=i) for i, (g, p) in enumerate(plan)]


SPREAD = [(20, 0), (18, 1), (14, 2), (9, 3), (24, 0), (6, 4), (12, 2), (3, 5)]

# Ordinary reading on this book: mostly prose, an occasional problem. Steady
# page counts, which is what makes a collapsed one stand out.
ORDINARY = [(22, 0), (20, 1), (19, 0), (21, 2), (18, 1), (20, 0), (22, 1), (19, 2)]


# ------------------------------------------------------------------- the fit


def test_the_fit_recovers_what_a_page_and_a_problem_actually_cost(config):
    """The quantity nobody can state up front and every plan silently assumes."""
    fit = density_fit(history(SPREAD), config)

    assert fit.basis is Basis.OBSERVED
    assert fit.alpha == pytest.approx(ALPHA)
    assert fit.beta == pytest.approx(BETA)
    assert fit.k == pytest.approx(BETA / ALPHA)
    assert fit.r_squared == pytest.approx(1.0)


def test_the_fit_is_per_trackable_so_different_books_get_different_costs(config):
    """§11. A problem in one book is not a problem in another, which is why this
    is never pooled by task_type the way §24.3 pools pace."""
    easy = [
        obs(g, p, day=i, minutes=1.0 * g + 3.0 * p)
        for i, (g, p) in enumerate(SPREAD)
    ]
    hard = [
        obs(g, p, day=i, minutes=1.0 * g + 30.0 * p)
        for i, (g, p) in enumerate(SPREAD)
    ]

    assert density_fit(easy, config).k == pytest.approx(3.0)
    assert density_fit(hard, config).k == pytest.approx(30.0)


def test_indices_compare_across_books_whose_raw_counts_do_not(config):
    """The point of a dimensionless index: two trackables with wildly different
    costs per problem both report ~1.0 for a session that went as predicted."""
    easy = [obs(g, p, day=i, minutes=1.0 * g + 3.0 * p) for i, (g, p) in enumerate(SPREAD)]
    hard = [obs(g, p, day=i, minutes=1.0 * g + 30.0 * p) for i, (g, p) in enumerate(SPREAD)]

    easy_idx = session_productivity(easy[-1], easy, density_fit(easy, config), config)
    hard_idx = session_productivity(hard[-1], hard, density_fit(hard, config), config)

    assert easy_idx.productivity_index == pytest.approx(1.0)
    assert hard_idx.productivity_index == pytest.approx(1.0)


# ------------------------------------------------------------------- guards


def test_too_few_sessions_is_unavailable_not_a_weak_fit(config):
    """P2. Two parameters from four points is a line through noise, and a wrong
    cost-per-problem does not degrade gracefully -- it reaches weekly ranking."""
    fit = density_fit(history(SPREAD[:4]), config)
    assert fit.basis is Basis.UNAVAILABLE
    assert fit.k is None
    assert "sessions" in fit.reason


def test_counts_that_never_vary_independently_cannot_be_separated(config):
    """Always two problems per ten pages: no amount of such data says what a
    page costs versus what a problem costs."""
    locked = [obs(10 * n, 2 * n, day=n) for n in range(1, 9)]
    fit = density_fit(locked, config)
    assert fit.basis is Basis.UNAVAILABLE
    assert "independently" in fit.reason


def test_a_negative_cost_is_refused_rather_than_reported(config):
    """A fit implying a problem gives time back means the model is wrong for
    this data. Saying so is the only honest response."""
    # More problems, reliably LESS time spent -- which would mean a problem
    # hands time back.
    backwards = [
        obs(g, p, day=i, minutes=1.2 * g - 4.0 * p)
        for i, (g, p) in enumerate(
            [(40, 0), (45, 1), (50, 2), (42, 3), (48, 0), (44, 4), (46, 2), (41, 5)]
        )
    ]
    fit = density_fit(backwards, config)
    assert fit.basis is Basis.UNAVAILABLE
    assert fit.k is None


def test_a_fit_that_explains_nothing_is_unavailable(config):
    """Below min_r_squared the fit is not a weaker number, it is a wrong one."""
    import random

    rng = random.Random(7)
    noise = [obs(g, p, day=i, minutes=rng.uniform(1, 120)) for i, (g, p) in enumerate(SPREAD)]
    fit = density_fit(noise, config)
    if fit.basis is Basis.UNAVAILABLE:
        assert fit.k is None
    else:  # a lucky seed still has to clear the bar it claims to
        assert fit.r_squared >= config.productivity.min_r_squared


def test_sessions_without_a_secondary_count_are_skipped_not_zeroed(config):
    """"I did not write down how many problems" is not "I solved none". Reading
    the first as the second drags the fitted cost of a problem toward zero --
    exactly the conclusion the missing data cannot support."""
    with_missing = history(SPREAD) + [obs(30, None, day=20, minutes=36.0)]
    assert density_fit(with_missing, config).k == pytest.approx(BETA / ALPHA)


# --------------------------------------------------- dense versus actually slow


def test_a_dense_session_is_not_a_productivity_dip(config):
    """The misreading this whole axis exists to prevent. Steady prose reading,
    then one session of nothing but problems: the page count collapses, and the
    session was not slow."""
    dense = obs(2, 4, day=8)
    hist = [*history(ORDINARY), dense]

    report = session_productivity(dense, hist, density_fit(hist, config), config)

    assert report.progress_outlier is True       # the pages look alarming
    assert report.explained_by_density is True   # the work does not
    assert report.productivity_index == pytest.approx(1.0)
    assert report.density_factor is not None


def test_a_genuinely_slow_session_is_not_excused(config):
    """The other half. Same collapsed page count, but the time went nowhere --
    no problems solved either. Density must not launder that."""
    slow = obs(2, 0, day=8, minutes=60.0)
    hist = [*history(ORDINARY), slow]

    report = session_productivity(slow, hist, density_fit(hist, config), config)

    assert report.progress_outlier is True
    assert report.explained_by_density is False
    assert report.productivity_index < config.productivity.normal_index_low


def test_no_usable_fit_means_no_index_rather_than_a_default(config):
    """P2 again: absent, not 1.0. A trackable with no history must not read as
    a perfectly ordinary session."""
    lone = obs(10, 1, day=0)
    report = session_productivity(lone, [lone], density_fit([lone], config), config)

    assert report.productivity_index is None
    assert report.effective_output is None
    assert report.calculation.note  # says which guard fired


# ---------------------------------------------------------------- stability


def test_a_tighter_secondary_series_is_what_proposes_a_switch(config):
    """Whether the unit is wrong is a measurement, not a model's opinion. Here
    the problem count is near-constant while pages swing wildly."""
    rows = [obs(g, 3, day=i, minutes=ALPHA * g + BETA * 3) for i, g in enumerate([4, 30, 8, 26, 6, 28, 10, 24])]
    stability = series_stability(rows, config)

    assert stability.secondary_is_tighter is True
    assert stability.secondary_relative_iqr < stability.primary_relative_iqr


def test_equally_scattered_series_do_not_propose_a_switch(config):
    """Churning the unit when neither measures the work better buys nothing."""
    stability = series_stability(history(SPREAD), config)
    assert stability.secondary_is_tighter is False
    assert stability.reason


def test_stability_is_compared_over_the_same_sessions(config):
    """Otherwise the answer could come from the two units being measured on
    different work."""
    rows = history(SPREAD) + [obs(50, None, day=30, minutes=60.0)]
    assert series_stability(rows, config).n_sessions == len(SPREAD)


def test_an_uncredible_clock_cannot_detonate_the_index(config):
    """This shipped broken once: a session started and ended within
    milliseconds has a duration of 0.002 minutes, and the index divides by it.
    The reported figure was 11000x. The planned length stands in instead."""
    dense = obs(2, 4, day=8, minutes=0.002)
    hist = [*history(ORDINARY), dense]

    report = session_productivity(dense, hist, density_fit(hist, config), config)

    assert report.productivity_index is not None
    assert report.productivity_index < 5.0


def test_a_session_whose_duration_was_never_measured_is_left_out_of_the_fit(config):
    """Stricter than pace.py, deliberately. There an unbelievable clock falls
    back to the planned length, which is fair when duration only scales an
    output. Here duration is the thing being regressed on, so substituting the
    plan would teach the fit that this work costs what was planned for it --
    the very assumption the fit exists to test."""
    polluted = [*history(ORDINARY), obs(20, 3, day=9, minutes=0.001)]
    fit = density_fit(polluted, config)

    assert fit.n_sessions == len(ORDINARY)      # the bad row is not counted
    assert fit.k == pytest.approx(BETA / ALPHA)  # and does not move the answer
