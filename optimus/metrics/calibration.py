"""§24.5 calibration: actual / expected, rolling median per task_type.

This is the system's model of the user (§13). Progress is the motivational
number; calibration is the honest one. A completion ratio trending toward 1.0
is one of the stated twelve-month success criteria (§8).

Two weighting decisions:

  Retroactive sessions carry `retroactive_weight` (default 0.5, D13). A timed
  session holds a measured number; a reconstructed one holds a remembered
  number, and a remembered number tends to be anchored to the prediction --
  which is exactly the quantity being tested. The two distributions are
  returned separately so this weight can be set from data later rather than
  left at a placeholder forever.

  Interrupted sessions are excluded. This goes slightly beyond the letter of
  §23.6, which only names pace, but an interrupted session's shortfall measures
  the interruption rather than the user's optimism. Including them would push
  the ratio down and misattribute the cause -- the opposite of what this metric
  exists to detect.
"""

from __future__ import annotations

from collections.abc import Sequence

from .config import MetricsConfig
from .types import CalibrationReport, SessionObs


def _ratio(session: SessionObs) -> float | None:
    if session.actual_output is None or session.expected_output is None:
        return None
    if session.expected_output <= 0:
        return None  # dividing by a zero expectation yields noise, not information
    return session.actual_output / session.expected_output


def weighted_median(pairs: Sequence[tuple[float, float]]) -> float | None:
    """Median of (value, weight) pairs.

    Walks the sorted values accumulating weight and returns the value at which
    cumulative weight crosses half the total. When the crossing lands exactly on
    a boundary the two neighbouring values are averaged, matching the ordinary
    even-count median.
    """
    usable = [(v, w) for v, w in pairs if w > 0]
    if not usable:
        return None

    usable.sort(key=lambda p: p[0])
    total = sum(w for _v, w in usable)
    half = total / 2.0

    cumulative = 0.0
    for i, (value, weight) in enumerate(usable):
        cumulative += weight
        if cumulative > half:
            return value
        if cumulative == half:
            # Exact boundary: average with the next distinct value if there is one.
            if i + 1 < len(usable):
                return (value + usable[i + 1][0]) / 2.0
            return value
    return usable[-1][0]


def calibration(
    sessions: Sequence[SessionObs],
    config: MetricsConfig,
) -> CalibrationReport:
    """Rolling weighted median of actual/expected over the recent window.

    `sessions` is expected to be pre-filtered to one task_type. The window is
    the most recent `rolling_window_sessions` by start time, so a long-ago
    stretch of bad estimates stops dragging on the current picture.
    """
    usable = [s for s in sessions if not s.interrupted and _ratio(s) is not None]
    usable.sort(key=lambda s: s.started_at)
    window = usable[-config.calibration.rolling_window_sessions :]

    timed: list[float] = []
    retro: list[float] = []
    pairs: list[tuple[float, float]] = []

    for session in window:
        r = _ratio(session)
        assert r is not None  # filtered above
        if session.entered_retroactively:
            retro.append(r)
            pairs.append((r, config.calibration.retroactive_weight))
        else:
            timed.append(r)
            pairs.append((r, 1.0))

    return CalibrationReport(
        median_ratio=weighted_median(pairs),
        n_total=len(window),
        timed_ratios=tuple(timed),
        retroactive_ratios=tuple(retro),
    )
