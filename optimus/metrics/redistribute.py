"""§25.5 daily redistribution, and the A/B/C/D tiers.

This module contains no scoring. The week's ranking is computed once, weekly
(D9), and the daily plan only redistributes what is left of it across the days
that remain. That is what makes two consecutive unchanged days produce
overlapping plans (test 10) instead of a top item that reshuffles every time a
session is logged.

The catch-up cap is the honest part. Shortfall spreads across the remaining
days and never dumps on tomorrow. When the cap binds, the correct response is
not a heroic day the user will not complete -- it is to say the week does not
fit and route into rebaseline (§25.2).
"""

from __future__ import annotations

from collections.abc import Sequence

from .config import MetricsConfig
from .types import DailyAllocation, ScoredItem


def redistribute(
    committed_units: float,
    completed_this_week: float,
    working_days_remaining: int,
    working_days_in_week: int,
    config: MetricsConfig,
) -> DailyAllocation:
    """`per_day = (committed - completed) / working_days_remaining`, capped.

    The cap is `catch_up_cap x baseline_daily_allocation`, where the baseline is
    the week's original even split. `capped=True` means the arithmetic wanted
    more than the cap allows, which is precisely the "this week does not fit"
    signal (D9) -- the caller must surface a rebaseline rather than silently
    issuing the capped number as though it were a plan.
    """
    remaining = max(committed_units - completed_this_week, 0.0)
    baseline_daily = committed_units / max(working_days_in_week, 1)
    cap_value = config.redistribution.catch_up_cap * baseline_daily

    if working_days_remaining <= 0:
        return DailyAllocation(
            per_day_units=0.0,
            baseline_daily=baseline_daily,
            cap_value=cap_value,
            capped=remaining > 0,
            working_days_remaining=0,
            remaining_units=remaining,
        )

    wanted = remaining / working_days_remaining
    capped = wanted > cap_value

    return DailyAllocation(
        per_day_units=min(wanted, cap_value),
        baseline_daily=baseline_daily,
        cap_value=cap_value,
        capped=capped,
        working_days_remaining=working_days_remaining,
        remaining_units=remaining,
    )


def assign_tier(
    item: ScoredItem,
    config: MetricsConfig,
    at_deadline_risk: bool,
    est_minutes: int | None,
) -> str:
    """§25.5 tiers. Presentation only -- derived from the weekly score plus
    deadline flags, and never fed back into any computation.

        A  deadline risk
        B  above threshold, no risk
        C  under `short_task_minutes`
        D  the rest, collapsed

    Evaluated in that order, matching the doc: a short task that is also at
    deadline risk is tier A, not tier C.
    """
    if at_deadline_risk:
        return "A"
    if item.score >= config.tiers.tier_b_score_threshold:
        return "B"
    if est_minutes is not None and est_minutes < config.tiers.short_task_minutes:
        return "C"
    return "D"


def daily_plan_order(scored: Sequence[ScoredItem]) -> list[ScoredItem]:
    """The day's order is the week's order. No re-ranking (D9)."""
    return list(scored)
