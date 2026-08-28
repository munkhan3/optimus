"""§25.1 ranking, §25.5 redistribution and tiers, §25.2/25.4 rebaseline."""

from __future__ import annotations

from goalos.metrics.drift import drift
from goalos.metrics.pace import empirical_pace
from goalos.metrics.rebaseline import (
    FOUR_OPTIONS,
    evaluate_exploratory,
    evaluate_metered,
)
from goalos.metrics.redistribute import assign_tier, redistribute
from goalos.metrics.scoring import rank, score_item
from goalos.metrics.types import ScoredItem, ScoreInputs, StallReport

# ------------------------------------------------------------------ scoring


def test_breakdown_is_never_empty_and_sums_to_the_score(config):
    """P3 / test 13. The breakdown is the answer to 'why this?'."""
    s = score_item(ScoreInputs(stakes=3, trackable_id=1), config)
    assert len(s.components) == 6
    assert abs(sum(c.contribution for c in s.components) - s.score) < 1e-12
    assert s.breakdown()["components"]


def test_effort_penalty_subtracts(config):
    cheap = score_item(ScoreInputs(stakes=3, trackable_id=1, est_minutes=10), config)
    dear = score_item(ScoreInputs(stakes=3, trackable_id=1, est_minutes=180), config)
    assert dear.score < cheap.score


def test_pace_deficit_is_not_a_scoring_term(config):
    """D6. The absence is deliberate; feasibility pressure replaces it."""
    names = {c.name for c in score_item(ScoreInputs(stakes=3), config).components}
    assert "pace_deficit" not in names
    assert "pace_ratio" not in names
    assert "feasibility_pressure" in names


def test_urgency_saturates_past_the_deadline(config):
    overdue = score_item(ScoreInputs(stakes=3, days_to_deadline=-5), config)
    urgency = next(c for c in overdue.components if c.name == "urgency")
    assert urgency.normalized == 1.0


def test_no_deadline_earns_no_urgency(config):
    """§12: a goal with no deadline is an intention, not work in progress."""
    s = score_item(ScoreInputs(stakes=3, days_to_deadline=None), config)
    assert next(c for c in s.components if c.name == "urgency").normalized == 0.0


def test_unknown_feasibility_does_not_manufacture_pressure(config):
    s = score_item(ScoreInputs(stakes=3, feasibility_margin_sessions=None), config)
    assert next(c for c in s.components if c.name == "feasibility_pressure").normalized == 0.0


def test_ranking_is_deterministic_for_unchanged_inputs(config):
    """Test 10's precondition: same inputs, same order, every time."""
    items = [
        ScoreInputs(stakes=3, trackable_id=i, days_to_deadline=10, est_minutes=25)
        for i in range(1, 6)
    ]
    assert [s.trackable_id for s in rank(items, config)] == [
        s.trackable_id for s in rank(list(reversed(items)), config)
    ]


# ------------------------------------------------------- redistribution


def test_shortfall_spreads_and_respects_the_cap(config):
    """§25.5 / test 11. 50 units over 5 days -> baseline 10/day, cap 12.5."""
    fresh = redistribute(50, 0, 5, 5, config)
    assert fresh.per_day_units == 10.0 and not fresh.capped

    after_two_missed = redistribute(50, 0, 3, 5, config)
    assert after_two_missed.per_day_units == 12.5      # not 16.67
    assert after_two_missed.capped is True             # the week does not fit


def test_cap_binding_is_the_rebaseline_signal(config):
    """D9: if the cap binds, that is a signal -- not a heroic day."""
    assert redistribute(50, 0, 1, 5, config).capped is True


def test_no_days_left_with_work_outstanding_is_capped(config):
    assert redistribute(50, 10, 0, 5, config).capped is True


def test_finished_week_asks_for_nothing(config):
    done = redistribute(50, 50, 2, 5, config)
    assert done.per_day_units == 0.0 and not done.capped


# ------------------------------------------------------------------ tiers


def test_tiers_follow_the_documented_order(config):
    high, low = ScoredItem(0.9, ()), ScoredItem(0.05, ())
    assert assign_tier(high, config, at_deadline_risk=True, est_minutes=60) == "A"
    assert assign_tier(high, config, at_deadline_risk=False, est_minutes=60) == "B"
    assert assign_tier(low, config, at_deadline_risk=False, est_minutes=10) == "C"
    assert assign_tier(low, config, at_deadline_risk=False, est_minutes=60) == "D"


def test_a_short_task_at_deadline_risk_is_still_tier_a(config):
    assert assign_tier(ScoredItem(0.9, ()), config, True, est_minutes=5) == "A"


# ------------------------------------------------------------- rebaseline


def _pace(config, session_factory, outputs):
    return empirical_pace([session_factory(x) for x in outputs], 10.0, config)


def test_a_bad_week_at_n2_does_not_trigger_a_rebaseline(config, session_factory):
    """Test 9. Acting on noise destroys trust faster than acting late."""
    p = _pace(config, session_factory, (3, 4))
    d = drift(100, p, planned_sessions_remaining=8, vs_version=1)
    proposal = evaluate_metered(100, p, d, config)

    assert d.sessions > config.rebaseline.material_drift_sessions  # drift IS material
    assert p.interval.provisional is True                          # but the band is wide
    assert proposal.should_prompt is False


def test_the_same_drift_prompts_once_there_is_data(config, session_factory):
    p = _pace(config, session_factory, (3, 4, 3, 4, 3, 4))
    d = drift(100, p, planned_sessions_remaining=8, vs_version=1)
    proposal = evaluate_metered(100, p, d, config)
    assert proposal.should_prompt is True
    assert proposal.trigger == "drift"


def test_immaterial_drift_never_prompts(config, session_factory):
    p = _pace(config, session_factory, (10, 10, 10, 10, 10, 10))
    d = drift(20, p, planned_sessions_remaining=3, vs_version=1)
    assert evaluate_metered(20, p, d, config).should_prompt is False


def test_unknown_pace_never_prompts(config, session_factory):
    from goalos.metrics.types import Basis, PaceEstimate

    p = PaceEstimate(None, Basis.UNAVAILABLE)
    d = drift(100, p, 5, 1)
    assert evaluate_metered(100, p, d, config).should_prompt is False


def test_a_stall_prompts_without_needing_a_pace_gate(config):
    """Exploratory work has no counter, so the plateau is itself the evidence."""
    stalled = StallReport(True, 4, 80.0, (40, 60, 75, 80, 80, 80))
    proposal = evaluate_exploratory(stalled)
    assert proposal.should_prompt is True and proposal.trigger == "stall"
    assert "80" in proposal.gate_reason  # the series is shown, not just a verdict


def test_moving_the_deadline_is_never_the_default_option():
    """§17. Silent extension is how a goal drifts for months without failing."""
    assert FOUR_OPTIONS[0] != "move_deadline"
    assert set(FOUR_OPTIONS) == {
        "add_sessions", "cut_scope", "move_deadline", "declare_infeasible",
    }
