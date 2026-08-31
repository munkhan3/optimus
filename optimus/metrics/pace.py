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

§36.1 was reversed: sessions may now be any length. Every observation is divided
by its own duration before it enters the sample, so a 50-minute session yielding
34 pages contributes 17.0 rather than 34. Without that, `pace_hat` would blend a
50-minute session with a 10-minute one and the resulting IQR would widen with
session LENGTH rather than with the user's actual speed -- which the §25.4 gate
would then read as uncertainty about the user and act on.

The estimate stays denominated per STANDARD session rather than per minute. That
is not timidity about the units: §24.6 measures what is available before a
deadline in budgeted SESSIONS, declared under §11, so pace has to be expressed in
the same currency it is compared against.
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence

from .config import MetricsConfig
from .types import (
    Basis,
    Calculation,
    Interval,
    PaceEstimate,
    PaceScores,
    RequiredPace,
    SessionObs,
)


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
    observations = [
        o for o in (normalized_output(s, config) for s in sessions) if o is not None
    ]
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
            point_per_minute=_per_minute(prior_pace, config),
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
        point_per_minute=_per_minute(point, config),
    )


def normalized_output(session: SessionObs, config: MetricsConfig) -> float | None:
    """One session's output, restated as what it would have been at standard length.

    Returns None only for sessions that already never shaped pace: interrupted
    ones, and ones with no recorded output.

    `min_session_minutes` is a credibility floor on the CLOCK, not a filter on
    the session. Because the normalization divides by duration, a degenerate
    reading detonates: nine pages against six seconds implies 2,250 pages per
    session, and one such row would swamp the mean of every honest one. But
    dropping the session is the wrong remedy -- the nine pages were still read,
    and §23.5's whole concern is that a lost session becomes a permanent hole.

    So a sub-floor reading is treated as UNMEASURED and the planned length stands
    in, which is the same fallback a row written before the timer became
    adjustable gets. The smallest offered duration is 15 minutes, so a session
    clocking under five against a planned fifteen is a mis-log or an abandonment
    far more often than it is five real minutes of work -- and a user who did
    genuinely stop after four minutes has `interrupted`, which excludes the row
    outright and is the honest signal for it.

    Falling back to the PLANNED length rather than to the standard one matters
    once durations vary: a 50-minute session with an unusable clock is one long
    session, and crediting its whole output to a 25-minute standard would report
    the user as twice as fast as they are.
    """
    if not session.counts_toward_pace:
        return None
    assert session.actual_output is not None  # counts_toward_pace guarantees this

    minutes = credible_minutes(session, config)
    if minutes is None:
        # Nothing credible about the duration at all. The session was standard
        # length until this change made length a variable, so treat it as one.
        return session.actual_output
    return session.actual_output / (minutes / config.session.minutes)


def credible_minutes(session: SessionObs, config: MetricsConfig) -> float | None:
    """How long a session lasted, or None if nothing about that is believable.

    Shared by everything that divides by a duration, which is the only safe way
    to hold this rule: the productivity index shipped briefly without it and
    reported an eleven-thousand-fold session, because a session started and
    ended within milliseconds has a duration of 0.002 minutes and dividing by it
    detonates exactly as hard as it sounds.

    A sub-floor reading is treated as unmeasured, not as a very short session,
    and the planned length stands in.
    """
    minutes = session.actual_minutes
    if minutes is None or minutes < config.session.min_session_minutes:
        minutes = session.planned_minutes
    if minutes is None or minutes <= 0:
        return None
    return minutes


def _per_minute(point: float | None, config: MetricsConfig) -> float | None:
    if point is None or config.session.minutes <= 0:
        return None
    return point / config.session.minutes


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


def pace_scores(
    trackable_pace: PaceEstimate,
    pooled_pace: PaceEstimate,
    required: RequiredPace | None,
) -> PaceScores:
    """The two dimensionless readings of pace (see PaceScores).

    Both denominators are numbers the engine already produces, so this adds no
    new estimate -- only a comparison, and the terms that produced it.

    `pace` divides this trackable's own rate by the rate the user achieves on
    this task_type generally. That is deliberately NOT a comparison against the
    plan: it answers "how fast do I work on this?", and a book that reads at
    0.8x your usual reading speed is a fact about the book, not a verdict on the
    schedule. `track` is the comparison against the plan, kept separate for the
    reason PaceScores documents.

    Every absent denominator yields None with the reason stated, never 1.0. A
    score of 1.0 means measured parity; it must never mean "no data".
    """
    pace_result: float | None = None
    pace_note = ""
    if trackable_pace.point is None:
        pace_note = "No sessions on this trackable yet."
    elif pooled_pace.point is None or pooled_pace.point <= 0:
        pace_note = "No established rate for this kind of work to compare against."
    else:
        pace_result = trackable_pace.point / pooled_pace.point

    track_result: float | None = None
    track_note = ""
    if pooled_pace.point is None:
        track_note = "No pace estimate yet."
    elif required is None or required.point is None:
        track_note = "No commitment or baseline fixes the denominator (§24.2)."
    elif required.point <= 0:
        # Nothing left to do is not "infinitely on track". §24.6 forbids
        # reporting an infinite required pace and the same restraint applies here.
        track_note = "No remaining work to pace against."
    else:
        track_result = pooled_pace.point / required.point

    return PaceScores(
        pace=pace_result,
        track=track_result,
        pace_calculation=Calculation(
            formula="this trackable's rate / your rate for this task_type",
            terms=(
                ("trackable rate (units/standard session)", trackable_pace.point),
                ("pooled rate (units/standard session)", pooled_pace.point),
                ("trackable rate (units/minute)", trackable_pace.point_per_minute),
                ("sessions behind it", float(trackable_pace.n_sessions)),
            ),
            result=pace_result,
            note=pace_note or "1.0 means you work on this at your usual speed.",
        ),
        track_calculation=Calculation(
            formula="pace_hat / required_pace",
            terms=(
                ("pace_hat (units/standard session)", pooled_pace.point),
                ("required_pace", None if required is None else required.point),
                (
                    "remaining units",
                    None if required is None else required.remaining_units,
                ),
                (
                    "remaining sessions",
                    None if required is None else float(required.remaining_sessions),
                ),
            ),
            result=track_result,
            note=track_note or "1.0 means exactly on track for the commitment.",
        ),
    )
