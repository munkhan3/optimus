"""§24.1 percent complete, and the remaining-work rule that pace modes turn on.

The pace-mode distinction (§12) matters more than it looks. Carrying shortfall
on a recurring commitment produces impossible plans and guilt; discarding it on
a terminating goal hides real slippage. Both failures are silent, so the rule
lives in one function that both required-pace and feasibility call.
"""

from __future__ import annotations

from .types import PaceMode, Progress, TrackableState


def remaining_units(
    trackable: TrackableState,
    completed_in_current_period: float | None = None,
) -> float:
    """Work left to do, respecting the trackable's pace mode (D4).

    carry_forward: completed_units is cumulative, so a missed target simply
    leaves more remaining -- the shortfall carries by construction (test 4).

    reset_period: the window closed and the shortfall was discarded (test 3).
    Remaining is measured against THIS period only, so a missed week starts the
    next one at the full target rather than at target + debt.
    """
    if trackable.pace_mode is PaceMode.RESET_PERIOD:
        done = (
            completed_in_current_period
            if completed_in_current_period is not None
            else trackable.completed_units
        )
        return max(trackable.total_units - done, 0.0)

    return max(trackable.total_units - trackable.completed_units, 0.0)


def percent_complete(
    trackable: TrackableState,
    completed_in_current_period: float | None = None,
) -> Progress:
    """§24.1. `fraction` is None when total_units is zero or negative.

    Returning None rather than 0.0 or 1.0 is deliberate: a trackable with no
    known total has no meaningful percentage, and inventing one would put a
    fabricated number on a progress bar (P2).
    """
    remaining = remaining_units(trackable, completed_in_current_period)

    if trackable.pace_mode is PaceMode.RESET_PERIOD:
        completed = (
            completed_in_current_period
            if completed_in_current_period is not None
            else trackable.completed_units
        )
    else:
        completed = trackable.completed_units

    total = trackable.total_units
    fraction = None
    if total > 0:
        # Clamped: over-delivery shows a full bar, not 130%.
        fraction = min(max(completed / total, 0.0), 1.0)

    return Progress(
        completed_units=completed,
        total_units=total,
        remaining_units=remaining,
        fraction=fraction,
    )
