"""§24.2 required pace and §24.3 empirical pace.

Empirical pace is the number the whole system turns on. It is the main thing
the system knows that the user does not (§13): believing you read 20 pages a
session when you read 9 is the root cause of most plan failure.

Two rules govern this module.

  Interrupted sessions never shape pace (§23.6, test 8). They are retained --
  the work happened -- but an interrupted session measures the interruption,
  not the pace.

  Retroactive sessions count at FULL weight here (D13, test 17). The
  down-weighting applies to calibration only, where the concern is that a
  remembered number is anchored to the prediction. For progress and pace, the
  pages were still read.
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence

from .config import MetricsConfig
from .types import Basis, Interval, PaceEstimate, RequiredPace, SessionObs


def empirical_pace(
    sessions: Sequence[SessionObs],
    prior_pace: float | None,
    config: MetricsConfig,
) -> PaceEstimate:
    """§24.3 shrinkage estimator, pooled by task_type.

        pace_hat = (kappa * prior_pace + n * observed_mean) / (kappa + n)

    `sessions` is expected to be pre-filtered to a single task_type -- pooling
    happens across trackables sharing that key, so a new trackable inherits the
    user's demonstrated speed at that kind of work rather than starting cold.

    Returns point=None with basis=UNAVAILABLE when there is neither a prior nor
    an observation. That is the honest answer, and it is what lets the UI say
    "not enough data" instead of printing a zero (P2).
    """
    kappa = config.pace.kappa
    observations = [s.actual_output for s in sessions if s.counts_toward_pace]
    n = len(observations)

    if n == 0:
        if prior_pace is None:
            return PaceEstimate(point=None, basis=Basis.UNAVAILABLE, n_sessions=0)
        # The user's own estimate, untested. Always provisional (test 2).
        return PaceEstimate(
            point=prior_pace,
            basis=Basis.PRIOR_ONLY,
            interval=_provisional_band(prior_pace, config),
            n_sessions=0,
            prior_pace=prior_pace,
        )

    observed_mean = statistics.fmean(observations)

    if prior_pace is None:
        # Nothing to shrink toward; the observations stand alone.
        point = observed_mean
        basis = Basis.OBSERVED
    else:
        point = (kappa * prior_pace + n * observed_mean) / (kappa + n)
        basis = Basis.SHRUNK

    return PaceEstimate(
        point=point,
        basis=basis,
        interval=_interval(observations, point, config),
        n_sessions=n,
        observed_mean=observed_mean,
        prior_pace=prior_pace,
    )


def _interval(
    observations: Sequence[float],
    point: float,
    config: MetricsConfig,
) -> Interval:
    """D8: displayed, never propagated. Gates exactly one decision (§25.4).

    Below min_sessions_for_iqr the spread of the observations is not yet
    meaningful, so we show a fixed wide band and label it provisional rather
    than a tight band computed from two data points, which would read as
    confidence the system has not earned.
    """
    n = len(observations)
    if n >= config.pace.min_sessions_for_iqr:
        q1, _median, q3 = statistics.quantiles(observations, n=4, method="inclusive")
        return Interval(low=q1, high=q3, provisional=False)
    return _provisional_band(point, config)


def _provisional_band(point: float, config: MetricsConfig) -> Interval:
    return Interval(
        low=point * config.pace.provisional_band_low,
        high=point * config.pace.provisional_band_high,
        provisional=True,
    )


def required_pace(
    remaining_units: float,
    committed_sessions: int,
    sessions_used: int,
    denominator_source: str = "weekly_commitment",
) -> RequiredPace:
    """§24.2, with the denominator fixed by commitment (D5).

    The naive `remaining / remaining_available_sessions` is circular: available
    sessions depend on the allocation decision that this number is supposed to
    inform. Committing a session budget fixes the denominator and breaks the
    loop.

    `max(remaining_sessions, 1)` follows the doc and keeps this finite. It does
    NOT mean the plan fits -- whether the work still fits is feasibility's
    question (§24.6), and that is the one allowed to say no.
    """
    remaining_sessions = committed_sessions - sessions_used
    point = remaining_units / max(remaining_sessions, 1)
    return RequiredPace(
        point=point,
        remaining_units=remaining_units,
        remaining_sessions=remaining_sessions,
        denominator_source=denominator_source,
    )
