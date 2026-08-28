"""§24.4 drift: how many sessions behind (or ahead) the plan the work has become.

Drift is deliberately NOT acted on daily (D5). It is consumed at rebaseline,
where the user makes an explicit choice among four options. Surfacing it as a
daily nag would produce exactly the thrash §16 warns about.

Reporting against version 1 as well as the current baseline is the point of
§25.3: three rebaselines in, the user must still be able to see that this began
as ten sessions targeting October. Cumulative slip is invisible if each
rebaseline silently becomes the new reference.
"""

from __future__ import annotations

from collections.abc import Sequence

from .types import BaselineState, Drift, PaceEstimate


def drift(
    remaining_units: float,
    pace: PaceEstimate,
    planned_sessions_remaining: int,
    vs_version: int,
) -> Drift:
    """Positive drift means behind: more sessions needed than planned.

    Returns sessions=None when pace is unusable rather than dividing by zero.
    An unknown drift and a zero drift are different facts (P2).
    """
    if not pace.is_usable:
        return Drift(
            sessions=None,
            vs_version=vs_version,
            projected_sessions_needed=None,
            planned_sessions_remaining=planned_sessions_remaining,
        )

    assert pace.point is not None
    needed = remaining_units / pace.point
    return Drift(
        sessions=needed - planned_sessions_remaining,
        vs_version=vs_version,
        projected_sessions_needed=needed,
        planned_sessions_remaining=planned_sessions_remaining,
    )


def drift_against_all(
    remaining_units: float,
    pace: PaceEstimate,
    baselines: Sequence[BaselineState],
    sessions_used: int,
) -> tuple[Drift | None, Drift | None]:
    """Drift against the current baseline and against version 1.

    Returns (current, original). Either may be None if that baseline is absent.
    The UI shows both, always -- version 1 is retained forever (test 12).
    """
    if not baselines:
        return (None, None)

    ordered = sorted(baselines, key=lambda b: b.version)
    original = ordered[0]
    current = ordered[-1]

    def _for(b: BaselineState) -> Drift:
        return drift(
            remaining_units=remaining_units,
            pace=pace,
            planned_sessions_remaining=max(b.planned_sessions - sessions_used, 0),
            vs_version=b.version,
        )

    current_drift = _for(current)
    original_drift = _for(original) if original.version != current.version else current_drift
    return (current_drift, original_drift)
