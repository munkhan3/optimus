"""Distribution summaries for the dashboard.

Pure, like everything else in this package: it takes numbers and returns
numbers. It lives here rather than in the aggregation service because the
service is not allowed to do arithmetic, and because a quantile is exactly the
kind of thing that should be testable without a database.

Quantiles use linear interpolation between order statistics -- the same
definition numpy calls 'linear' and the one an IQR is normally quoted against.
Rolling our own rather than pulling in a dependency matches pace.py, which
already computes an IQR by hand for the same reason.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Distribution:
    """A per-session output distribution.

    `n` is the count behind every other field. It is reported so the UI can
    refuse to draw a box plot from three observations -- the same discipline
    §24.3 applies to the pace interval, where a narrow band at n=2 is noise
    dressed as precision.
    """

    n: int
    mean: float | None
    median: float | None
    p25: float | None
    p75: float | None
    low: float | None
    high: float | None


EMPTY = Distribution(n=0, mean=None, median=None, p25=None, p75=None, low=None, high=None)


def quantile(sorted_values: Sequence[float], q: float) -> float | None:
    """The q-th quantile of an already-sorted sequence, linearly interpolated."""
    n = len(sorted_values)
    if n == 0:
        return None
    if n == 1:
        return float(sorted_values[0])
    pos = q * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return float(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac)


def describe(values: Sequence[float]) -> Distribution:
    """Summarize per-session output. Empty input yields nulls, never zeros.

    A zero would say "you produced nothing per session", which is a claim about
    the user. Null says "there is nothing to report yet", which is the truth.
    """
    clean = sorted(float(v) for v in values if v is not None)
    if not clean:
        return EMPTY
    return Distribution(
        n=len(clean),
        mean=sum(clean) / len(clean),
        median=quantile(clean, 0.5),
        p25=quantile(clean, 0.25),
        p75=quantile(clean, 0.75),
        low=clean[0],
        high=clean[-1],
    )
