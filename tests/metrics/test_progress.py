"""§24.1 and the pace-mode remaining-work rule (§12)."""

from __future__ import annotations

from optimus.metrics.progress import percent_complete, remaining_units
from optimus.metrics.types import PaceMode, TrackableState


def _trackable(**kw) -> TrackableState:
    base = {"id": 1, "task_type": "reading", "total_units": 380.0,
            "completed_units": 0.0}
    return TrackableState(**{**base, **kw})


def test_percent_complete_is_the_simple_ratio():
    p = percent_complete(_trackable(completed_units=190.0))
    assert p.fraction == 0.5
    assert p.remaining_units == 190.0


def test_unknown_total_yields_no_percentage():
    """P2: a trackable with no total has no meaningful percentage."""
    assert percent_complete(_trackable(total_units=0.0)).fraction is None


def test_over_delivery_shows_a_full_bar_not_more():
    assert percent_complete(_trackable(completed_units=500.0)).fraction == 1.0


def test_carry_forward_accumulates_shortfall():
    """§12: missing 40 pages means 40 more pages later."""
    t = _trackable(completed_units=100.0, pace_mode=PaceMode.CARRY_FORWARD)
    assert remaining_units(t) == 280.0


def test_reset_period_discards_shortfall():
    """§12: missing two gym sessions does not create a debt of eight."""
    weekly = _trackable(
        total_units=6.0, completed_units=0.0,
        pace_mode=PaceMode.RESET_PERIOD, task_type="admin",
    )
    # A fresh window after a missed one: the target, not the target plus debt.
    assert remaining_units(weekly, completed_in_current_period=0.0) == 6.0
    assert remaining_units(weekly, completed_in_current_period=4.0) == 2.0
    # Over-delivery does not go negative.
    assert remaining_units(weekly, completed_in_current_period=8.0) == 0.0
