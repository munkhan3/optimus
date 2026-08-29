"""§24.6 feasibility and §24.7 projected completion.

Feasibility is the load-bearing comparison in this system. §11: pace ratio is
NOT comparable across incommensurable goals -- a goal at 0.7 may simply have had
an aggressive plan. What *is* comparable is whether the remaining work still
fits before the deadline, and that question means the same thing in every
domain. Taxes at 0.7 due in ten days is a real problem; a prototype at 0.7 due
in six months is a bad estimate.

So this module answers the question that triggers reallocation (D6), and §25.1
scores on it rather than on pace deficit.

Two things this module must never do (§24.6):
  - report an infinite or absurd required pace
  - silently propose a later date
When the work does not fit, it says so, and the four-option choice in §17 is the
user's to make.
"""

from __future__ import annotations

from datetime import date, timedelta

from .types import Feasibility, PaceEstimate, Projection


def feasibility(
    remaining_units: float,
    pace: PaceEstimate,
    sessions_available_before_deadline: int | None,
) -> Feasibility:
    """`feasible = (remaining_units / pace_hat) <= sessions_available`.

    Returns feasible=None when it cannot be determined. None is not True --
    callers must not treat an unknown as a pass, which is why this is a
    three-valued result rather than a bool.
    """
    if remaining_units <= 0:
        return Feasibility(
            feasible=True,
            sessions_needed=0.0,
            sessions_available=sessions_available_before_deadline,
            margin_sessions=float(sessions_available_before_deadline or 0),
            reason="No work remaining.",
        )

    if not pace.is_usable:
        return Feasibility(
            feasible=None,
            sessions_needed=None,
            sessions_available=sessions_available_before_deadline,
            margin_sessions=None,
            reason="No usable pace estimate yet -- feasibility is undetermined, not fine.",
        )

    if sessions_available_before_deadline is None:
        return Feasibility(
            feasible=None,
            sessions_needed=remaining_units / pace.point,  # type: ignore[operator]
            sessions_available=None,
            margin_sessions=None,
            reason="No deadline or no committed capacity -- nothing to measure the fit against.",
        )

    assert pace.point is not None
    needed = remaining_units / pace.point
    margin = sessions_available_before_deadline - needed
    fits = needed <= sessions_available_before_deadline

    if fits:
        reason = (
            f"{needed:.1f} sessions needed, {sessions_available_before_deadline} available "
            f"-- margin {margin:.1f}."
        )
    else:
        reason = (
            f"INFEASIBLE: {needed:.1f} sessions needed but only "
            f"{sessions_available_before_deadline} available before the deadline "
            f"(short by {-margin:.1f})."
        )

    return Feasibility(
        feasible=fits,
        sessions_needed=needed,
        sessions_available=sessions_available_before_deadline,
        margin_sessions=margin,
        reason=reason,
    )


def projection(
    remaining_units: float,
    pace: PaceEstimate,
    sessions_per_week: float,
    today: date,
    target_date: date | None = None,
) -> Projection:
    """§24.7. Always a range, derived from the pace interval. Never one date.

    A single projected date implies a precision the estimate does not have. The
    range comes from the displayed interval, which is the one place D8 permits
    the interval to be read -- and it is read for display, not propagated into
    any downstream arithmetic.
    """
    if not pace.is_usable or sessions_per_week <= 0:
        return Projection(
            earliest=None, latest=None, provisional=True, target_date=target_date
        )

    if remaining_units <= 0:
        return Projection(
            earliest=today, latest=today, provisional=False, target_date=target_date
        )

    interval = pace.interval
    # A faster pace finishes sooner, so the interval's HIGH bound gives the
    # earliest date and the LOW bound the latest.
    fast = interval.high if interval and interval.high > 0 else pace.point
    slow = interval.low if interval and interval.low > 0 else pace.point
    assert fast is not None and slow is not None

    def _date_for(rate: float) -> date:
        sessions_needed = remaining_units / rate
        days = sessions_needed / sessions_per_week * 7.0
        return today + timedelta(days=days)

    return Projection(
        earliest=_date_for(fast),
        latest=_date_for(slow),
        provisional=interval.provisional if interval else True,
        target_date=target_date,
    )


def feasibility_from_session_budget(
    planned_sessions_remaining: float,
    sessions_available_before_deadline: int | None,
) -> Feasibility:
    """Feasibility for work with no natural counter (§10, §21).

    A milestone whose definition of done is a checkable condition rather than a
    count has no trackable and no units, so `remaining_units / pace_hat` is
    meaningless for it. Forcing a number here would be the single most damaging
    thing the system can do (§10) -- every projection downstream would rest on a
    figure nobody believes.

    Instead such work is budgeted in sessions, and feasibility asks the same
    question in the same units: do the planned sessions still fit before the
    deadline. This is what lets §25.1 score metered and unmetered work on
    identical terms instead of needing a correction factor.
    """
    if planned_sessions_remaining <= 0:
        return Feasibility(
            feasible=True,
            sessions_needed=0.0,
            sessions_available=sessions_available_before_deadline,
            margin_sessions=float(sessions_available_before_deadline or 0),
            reason="No sessions remaining in the budget.",
        )

    if sessions_available_before_deadline is None:
        return Feasibility(
            feasible=None,
            sessions_needed=planned_sessions_remaining,
            sessions_available=None,
            margin_sessions=None,
            reason="No deadline or no committed capacity -- nothing to measure the fit against.",
        )

    margin = sessions_available_before_deadline - planned_sessions_remaining
    fits = planned_sessions_remaining <= sessions_available_before_deadline
    reason = (
        f"{planned_sessions_remaining:.0f} budgeted sessions, "
        f"{sessions_available_before_deadline} available -- margin {margin:.1f}."
        if fits
        else f"INFEASIBLE: {planned_sessions_remaining:.0f} budgeted sessions but only "
        f"{sessions_available_before_deadline} available before the deadline."
    )
    return Feasibility(
        feasible=fits,
        sessions_needed=planned_sessions_remaining,
        sessions_available=sessions_available_before_deadline,
        margin_sessions=margin,
        reason=reason,
    )
