"""§24.9 stall detection. The ONLY module in this package that reads
self_assessed_pct.

D12 is strict: the slider is a review signal, never a computed input. It is not
read for projection, pace, feasibility, scoring, or calibration. If a future
change makes another module import ProgressCheck, acceptance test 14 should
fail -- and if it does not, the test is too weak.

The reason the slider is still worth storing: self-assessed progress
characteristically climbs to ~80% and then sits there for weeks. That plateau is
better evidence for rescoping than any invented pace would be, because a long
stall usually means the remaining work was underestimated. So the output here is
a review prompt (§25.2), never a score change.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import pairwise

from .config import MetricsConfig
from .types import ProgressCheck, SessionObs, StallReport


def detect_stall(
    checks: Sequence[ProgressCheck],
    sessions: Sequence[SessionObs],
    config: MetricsConfig,
) -> StallReport:
    """Flag work whose self-assessment has stopped moving despite logged sessions.

        sessions_since_movement = sessions logged since the last progress_check
                                  showing |delta pct| >= movement_pct
        stalled = sessions_since_movement >= threshold_sessions
                  AND latest pct < 100

    With no checks recorded there is no evidence either way, so this reports
    not-stalled rather than guessing.
    """
    if not checks:
        return StallReport(
            stalled=False, sessions_since_movement=0, latest_pct=None, series=()
        )

    ordered = sorted(checks, key=lambda c: c.recorded_at)
    series = tuple(c.self_assessed_pct for c in ordered)
    latest_pct = ordered[-1].self_assessed_pct

    # The first check is itself movement: going from nothing recorded to a
    # number is information. After that, movement means a jump of at least
    # movement_pct in either direction.
    last_movement_at = ordered[0].recorded_at
    for previous, current in pairwise(ordered):
        if abs(current.self_assessed_pct - previous.self_assessed_pct) >= config.stall.movement_pct:
            last_movement_at = current.recorded_at

    sessions_since = sum(1 for s in sessions if s.started_at > last_movement_at)

    stalled = sessions_since >= config.stall.threshold_sessions and latest_pct < 100

    return StallReport(
        stalled=stalled,
        sessions_since_movement=sessions_since,
        latest_pct=latest_pct,
        series=series,
    )
